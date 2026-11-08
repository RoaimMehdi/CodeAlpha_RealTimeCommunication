'use strict';

/**
 * CamKnock — backend
 * Express REST API + Socket.IO signalling for a WebRTC mesh call,
 * with persistent chat, files and whiteboard strokes in MySQL.
 */

require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

/* ------------------------------------------------------------------ */
/* Config                                                             */
/* ------------------------------------------------------------------ */

const PORT = Number(process.env.PORT || 3000);
const SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const MAX_PARTICIPANTS = Number(process.env.MAX_PARTICIPANTS || 6);
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 25);
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORTAL_DIR = path.join(__dirname, 'portal');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

if (!SECRET || SECRET.length < 16) {
  console.error('[fatal] Set JWT_SECRET (16+ characters) in .env');
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* Database                                                           */
/* ------------------------------------------------------------------ */

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'meetroom',
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL || 10),
  charset: 'utf8mb4',
  timezone: 'Z',
});

pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+00:00'");
});

/* ------------------------------------------------------------------ */
/* Uploads                                                            */
/* ------------------------------------------------------------------ */

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, _file, cb) => cb(null, crypto.randomBytes(16).toString('hex')),
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

/* ------------------------------------------------------------------ */
/* App                                                                */
/* ------------------------------------------------------------------ */

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e6,
  cors: {
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

app.disable('x-powered-by');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

app.use(
  helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'img-src': ["'self'", 'data:', 'blob:', 'https://images.unsplash.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com'],
        'connect-src': [
          "'self'",
          'ws:',
          'wss:',
          'stun:',
          'stun:stun.l.google.com:19302',
          'https://fonts.googleapis.com',
          'https://fonts.gstatic.com',
          'https://images.unsplash.com',
        ],
        'media-src': ["'self'", 'blob:'],
        'object-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'form-action': ["'self'"],
        // Self-hosted installs often run on plain HTTP over a LAN address;
        // forcing HTTPS upgrades there would break asset loading.
        'upgrade-insecure-requests': null,
      },
    },
  })
);

app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));

app.use(
  express.static(PUBLIC_DIR, {
    index: 'index.html',
    extensions: ['html'],
    setHeaders(res) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    },
  })
);

app.use(
  '/portal',
  express.static(PORTAL_DIR, {
    index: 'index.html',
    extensions: ['html'],
    setHeaders(res) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    },
  })
);

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const fail = (status, message) => {
  throw new HttpError(status, message);
};

const sign = (user) =>
  jwt.sign({ id: user.id, name: user.name, role: user.role || 'user' }, SECRET, { expiresIn: JWT_EXPIRES_IN });

const auth = (req, _res, next) => {
  const header = req.headers.authorization || '';
  const token =
    header.startsWith('Bearer ')
      ? header.slice(7)
      : req.query && typeof req.query.token === 'string'
        ? req.query.token
        : null;
  if (!token) return next(new HttpError(401, 'Please sign in again'));
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    next(new HttpError(401, 'Your session expired — please sign in again'));
  }
};

const optionalAuth = (req, _res, next) => {
  const header = req.headers.authorization || '';
  const token =
    header.startsWith('Bearer ')
      ? header.slice(7)
      : req.query && typeof req.query.token === 'string'
        ? req.query.token
        : null;
  if (!token) return next();
  try {
    req.user = jwt.verify(token, SECRET);
  } catch {
    // Ignore invalid/expired token for optional endpoints
  }
  next();
};

const roomByCode = async (code) => {
  const [rows] = await pool.query('SELECT * FROM rooms WHERE code = ? LIMIT 1', [code]);
  return rows[0] || null;
};

const requireRoom = async (code) => {
  const normalized = String(code || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  const room = await roomByCode(normalized);
  if (!room) fail(404, 'Room not found');
  return room;
};

const requireHost = (room, user) => {
  if (Number(room.owner_id) !== Number(user.id)) {
    fail(403, 'Only the host can do that');
  }
};

const activeCount = async (code) => (await io.in('r' + code).fetchSockets()).length;

const newRoomCode = async () => {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const code = crypto.randomBytes(4).toString('hex');
    const [rows] = await pool.query('SELECT id FROM rooms WHERE code = ? LIMIT 1', [code]);
    if (!rows.length) return code;
  }
  throw new HttpError(503, 'Could not allocate a room code, please retry');
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ------------------------------------------------------------------ */
/* REST API                                                           */
/* ------------------------------------------------------------------ */

app.get(
  '/api/health',
  asyncHandler(async (_req, res) => {
    const started = Date.now();
    await pool.query('SELECT 1');
    res.json({
      status: 'ok',
      database: 'connected',
      latencyMs: Date.now() - started,
      uptimeSeconds: Math.round(process.uptime()),
      version: require('./package.json').version,
    });
  })
);

app.post(
  ['/api/register', '/api/auth/register'],
  rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false }),
  asyncHandler(async (req, res) => {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (name.length < 2) fail(400, 'Please enter your full name');
    if (!EMAIL_RE.test(email)) fail(400, 'Please enter a valid email address');
    if (password.length < 6) fail(400, 'Password must be at least 6 characters');

    const hash = await bcrypt.hash(password, 12);
    try {
      const [result] = await pool.query(
        'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)',
        [name.slice(0, 80), email.slice(0, 160), hash]
      );
      const user = { id: result.insertId, name: name.slice(0, 80) };
      res.status(201).json({ token: sign(user), name: user.name, email });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') fail(409, 'This email is already registered');
      throw error;
    }
  })
);

app.post(
  ['/api/login', '/api/auth/login'],
  rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false }),
  asyncHandler(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    const [rows] = await pool.query('SELECT * FROM users WHERE email = ? LIMIT 1', [email]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      fail(401, 'Email or password is incorrect');
    }

    if (user.status === 'suspended') {
      fail(403, 'Your account has been suspended by administration');
    }

    // Check host_login setting
    try {
      const [sRows] = await pool.query('SELECT host_login FROM settings WHERE id = 1 LIMIT 1');
      if (sRows.length && Number(sRows[0].host_login) === 0 && user.role !== 'admin') {
        fail(403, 'Host login is temporarily disabled by administrator');
      }
    } catch (e) {
      // ignore table check error if not ready
    }

    res.json({ token: sign(user), name: user.name, email: user.email, role: user.role || 'user', status: user.status || 'active' });
  })
);

app.post(
  '/api/guest',
  rateLimit({ windowMs: 60 * 60 * 1000, limit: 40, standardHeaders: 'draft-7', legacyHeaders: false }),
  asyncHandler(async (req, res) => {
    // Check guest_join setting
    try {
      const [sRows] = await pool.query('SELECT guest_join FROM settings WHERE id = 1 LIMIT 1');
      if (sRows.length && Number(sRows[0].guest_join) === 0) {
        fail(403, 'Guest access is currently disabled by administrator. Please sign in to continue.');
      }
    } catch (e) {
      // ignore
    }

    const name = String(req.body.name || '').trim();
    if (name.length < 2) fail(400, 'Please enter your name');

    const email = `guest-${crypto.randomBytes(8).toString('hex')}@guest.meetroom.local`;
    const hash = await bcrypt.hash(crypto.randomBytes(18).toString('hex'), 10);
    const [result] = await pool.query(
      'INSERT INTO users (name, email, password_hash, role, status) VALUES (?, ?, ?, ?, "active")',
      [name.slice(0, 80), email, hash, 'user']
    );
    const user = { id: result.insertId, name: name.slice(0, 80), role: 'user', status: 'active' };
    res.status(201).json({ token: sign(user), name: user.name, guest: true, role: 'user' });
  })
);

app.get(
  '/api/me',
  auth,
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query('SELECT id, name, email, role, status, created_at FROM users WHERE id = ?', [
      req.user.id,
    ]);
    if (!rows.length) fail(404, 'User not found');
    res.json(rows[0]);
  })
);

app.post(
  '/api/rooms',
  auth,
  asyncHandler(async (req, res) => {
    // Check if host is suspended
    const [uRows] = await pool.query('SELECT status FROM users WHERE id = ? LIMIT 1', [req.user.id]);
    if (uRows.length && uRows[0].status === 'suspended') {
      fail(403, 'Your account is suspended. You cannot host meetings.');
    }

    const name = String(req.body.name || '').trim().slice(0, 120) || 'Untitled room';
    const code = await newRoomCode();
    await pool.query('INSERT INTO rooms (code, name, owner_id) VALUES (?, ?, ?)', [
      code,
      name,
      req.user.id,
    ]);

    // Keep meetings table synchronized
    await pool.query(
      'INSERT INTO meetings (code, title, host_id, date, time, duration_min, status) VALUES (?, ?, ?, CURDATE(), CURTIME(), 30, "live") ON DUPLICATE KEY UPDATE title = VALUES(title), status = "live"',
      [code, name, req.user.id]
    );

    res.status(201).json({ code, name });
  })
);

app.get(
  '/api/rooms',
  auth,
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
      `SELECT r.id, r.code, r.name, r.created_at, r.owner_id,
              (SELECT COUNT(*) FROM room_participants p
                WHERE p.room_id = r.id AND p.left_at IS NULL) AS participant_count
         FROM rooms r
        WHERE r.owner_id = ?
           OR EXISTS (SELECT 1 FROM room_participants p
                       WHERE p.room_id = r.id AND p.user_id = ?)
        ORDER BY r.created_at DESC
        LIMIT 50`,
      [req.user.id, req.user.id]
    );
    res.json(rows);
  })
);

app.get(
  '/api/rooms/:code',
  auth,
  asyncHandler(async (req, res) => {
    const room = await requireRoom(req.params.code);
    res.json({
      code: room.code,
      name: room.name,
      isHost: Number(room.owner_id) === Number(req.user.id),
      participants: (await io.in('r' + room.code).fetchSockets()).map((s) => ({
        id: s.id,
        name: s.data.name,
        userId: s.data.userId,
      })),
    });
  })
);

app.post(
  '/api/rooms/:code/end',
  auth,
  asyncHandler(async (req, res) => {
    const room = await requireRoom(req.params.code);
    requireHost(room, req.user);

    await pool.query(
      'UPDATE room_participants SET left_at = NOW() WHERE room_id = ? AND left_at IS NULL',
      [room.id]
    );
    await pool.query('DELETE FROM strokes WHERE room_id = ?', [room.id]);

    io.to('r' + room.code).emit('room-ended');
    const sockets = await io.in('r' + room.code).fetchSockets();
    sockets.forEach((s) => s.leave('r' + room.code));

    res.json({ success: true });
  })
);

app.post(
  '/api/rooms/:code/participants',
  auth,
  asyncHandler(async (req, res) => {
    const room = await requireRoom(req.params.code);
    requireHost(room, req.user);

    const userId = Number(req.body.userId);
    if (!userId) fail(400, 'userId is required');
    if (userId === Number(room.owner_id)) fail(400, 'The host cannot be removed');

    await pool.query(
      'UPDATE room_participants SET left_at = NOW() WHERE room_id = ? AND user_id = ? AND left_at IS NULL',
      [room.id, userId]
    );
    io.to('r' + room.code).emit('participant-removed', { userId });
    res.json({ success: true });
  })
);

app.get(
  '/api/rooms/:code/messages',
  auth,
  asyncHandler(async (req, res) => {
    const room = await requireRoom(req.params.code);
    const [rows] = await pool.query(
      `SELECT m.id, m.content, m.created_at, u.name AS sender, m.user_id
         FROM messages m
         JOIN users u ON u.id = m.user_id
        WHERE m.room_id = ?
        ORDER BY m.created_at ASC
        LIMIT 200`,
      [room.id]
    );
    res.json(rows);
  })
);

app.post(
  '/api/rooms/:code/messages',
  auth,
  asyncHandler(async (req, res) => {
    const room = await requireRoom(req.params.code);
    const content = String(req.body.content || '').trim();
    if (!content) fail(400, 'Message cannot be empty');
    if (content.length > 2000) fail(400, 'Message is too long (2000 characters max)');

    const [result] = await pool.query(
      'INSERT INTO messages (room_id, user_id, content) VALUES (?, ?, ?)',
      [room.id, req.user.id, content]
    );
    const message = {
      id: result.insertId,
      content,
      created_at: new Date().toISOString(),
      sender: req.user.name,
      user_id: req.user.id,
    };
    io.to('r' + room.code).emit('message', message);
    res.status(201).json(message);
  })
);

app.get(
  '/api/rooms/:code/files',
  auth,
  asyncHandler(async (req, res) => {
    const room = await requireRoom(req.params.code);
    const [rows] = await pool.query(
      `SELECT f.id, f.original_name AS name, f.size, f.created_at, u.name AS uploader
         FROM files f
         JOIN users u ON u.id = f.user_id
        WHERE f.room_id = ?
        ORDER BY f.id ASC`,
      [room.id]
    );
    res.json(rows);
  })
);

app.post(
  '/api/rooms/:code/files',
  auth,
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const room = await requireRoom(req.params.code);
    if (!req.file) fail(400, 'No file received');

    const originalName = path.basename(req.file.originalname).slice(0, 255) || 'file';
    const [result] = await pool.query(
      `INSERT INTO files (room_id, user_id, original_name, stored_name, size)
       VALUES (?, ?, ?, ?, ?)`,
      [room.id, req.user.id, originalName, req.file.filename, req.file.size]
    );

    const file = {
      id: result.insertId,
      name: originalName,
      size: req.file.size,
      uploader: req.user.name,
      created_at: new Date().toISOString(),
    };
    io.to('r' + room.code).emit('file', file);
    res.status(201).json(file);
  })
);

app.get(
  '/api/files/:id',
  auth,
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query('SELECT * FROM files WHERE id = ? LIMIT 1', [req.params.id]);
    const file = rows[0];
    if (!file) fail(404, 'File not found');

    const absolute = path.join(UPLOAD_DIR, file.stored_name);
    if (!fs.existsSync(absolute)) fail(410, 'This file is no longer available');

    res.download(absolute, file.original_name, (error) => {
      if (error && !res.headersSent) res.status(500).end();
    });
  })
);

/* ------------------------------------------------------------------ */
/* Real-Time Message Translation API                                  */
/* ------------------------------------------------------------------ */

app.post(
  '/api/translate',
  asyncHandler(async (req, res) => {
    const text = String(req.body.text || '').trim();
    const target = String(req.body.target || 'en').trim().toLowerCase();
    const source = String(req.body.source || 'autodetect').trim().toLowerCase();

    if (!text) fail(400, 'Text to translate is required');

    const https = require('https');
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(source)}|${encodeURIComponent(target)}`;

    const translated = await new Promise((resolve) => {
      const request = https.get(
        url,
        { headers: { 'User-Agent': 'Mozilla/5.0 CamKnock/2.0' }, timeout: 6000 },
        (apiRes) => {
          let raw = '';
          apiRes.on('data', (chunk) => (raw += chunk));
          apiRes.on('end', () => {
            try {
              const data = JSON.parse(raw);
              if (data.responseData && data.responseData.translatedText) {
                resolve(data.responseData.translatedText);
              } else {
                resolve(text);
              }
            } catch (e) {
              resolve(text);
            }
          });
        }
      );
      request.on('error', () => resolve(text));
      request.on('timeout', () => {
        request.destroy();
        resolve(text);
      });
    });

    res.json({ success: true, original: text, translated, target, source });
  })
);

/* ------------------------------------------------------------------ */
/* Calendar & Scheduled Meetings API                                  */
/* ------------------------------------------------------------------ */

app.get(
  '/api/meetings/scheduled',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
      `SELECT m.*, u.name as host_name, u.email as host_email 
       FROM scheduled_meetings m
       JOIN users u ON u.id = m.host_id
       ORDER BY m.scheduled_date ASC, m.scheduled_time ASC`
    );
    res.json(rows);
  })
);

app.post(
  '/api/meetings/schedule',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const title = String(req.body.title || '').trim();
    const description = String(req.body.description || '').trim();
    const scheduled_date = String(req.body.scheduled_date || '').trim();
    const scheduled_time = String(req.body.scheduled_time || '').trim();
    const duration_mins = Number(req.body.duration_mins || 30);

    if (!title) fail(400, 'Meeting title is required');
    if (!scheduled_date) fail(400, 'Scheduled date is required');
    if (!scheduled_time) fail(400, 'Scheduled time is required');

    const hostId = req.user ? req.user.id : 1;
    const code = await newRoomCode();
    await pool.query('INSERT INTO rooms (code, name, owner_id) VALUES (?, ?, ?)', [
      code,
      title,
      hostId,
    ]);

    const [result] = await pool.query(
      `INSERT INTO scheduled_meetings (host_id, title, description, room_code, scheduled_date, scheduled_time, duration_mins)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [hostId, title, description, code, scheduled_date, scheduled_time, duration_mins]
    );

    res.status(201).json({
      id: result.insertId,
      code,
      title,
      scheduled_date,
      scheduled_time,
      duration_mins,
      join_url: `/r/${code}`,
    });
  })
);

app.delete(
  '/api/meetings/scheduled/:id',
  auth,
  asyncHandler(async (req, res) => {
    await pool.query('DELETE FROM scheduled_meetings WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  })
);

/* ------------------------------------------------------------------ */
/* Support Tickets API                                                */
/* ------------------------------------------------------------------ */

app.post(
  '/api/support/tickets',
  asyncHandler(async (req, res) => {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const phone = String(req.body.phone || '').trim();
    const subject = String(req.body.subject || '').trim();
    const message = String(req.body.message || '').trim();

    if (!name) fail(400, 'Name is required');
    if (!EMAIL_RE.test(email)) fail(400, 'Valid email is required');
    if (!subject) fail(400, 'Subject is required');
    if (!message) fail(400, 'Message is required');

    const [result] = await pool.query(
      'INSERT INTO support_tickets (name, email, phone, subject, message) VALUES (?, ?, ?, ?, ?)',
      [name, email, phone || '+1 201-685-2107', subject, message]
    );

    res.status(201).json({
      success: true,
      ticket_id: result.insertId,
      message: 'Support request received. Our team will contact you shortly.',
    });
  })
);

app.get(
  '/api/support/tickets',
  optionalAuth,
  asyncHandler(async (_req, res) => {
    const [rows] = await pool.query('SELECT * FROM support_tickets ORDER BY created_at DESC');
    res.json(rows);
  })
);

app.patch(
  '/api/support/tickets/:id',
  auth,
  asyncHandler(async (req, res) => {
    const status = String(req.body.status || 'open');
    await pool.query('UPDATE support_tickets SET status = ? WHERE id = ?', [status, req.params.id]);
    res.json({ success: true, status });
  })
);

/* ------------------------------------------------------------------ */
/* Portal Analytics & Management API                                  */
/* ------------------------------------------------------------------ */

app.get(
  '/api/portal/session',
  asyncHandler(async (_req, res) => {
    const [rows] = await pool.query(
      'SELECT id, name, email, role FROM users WHERE role = "admin" OR email = "demo@camknock.app" LIMIT 1'
    );
    const user = rows[0] || { id: 1, name: 'Admin', email: 'admin@meetroom.local', role: 'admin' };
    const token = sign(user);
    res.json({ token, user });
  })
);

app.get(
  '/api/portal/stats',
  asyncHandler(async (_req, res) => {
    // 1. Total registered users
    const [[{ total_users }]] = await pool.query(
      'SELECT COUNT(*) as total_users FROM users WHERE email NOT LIKE "guest-%"'
    );

    // 2. Total unique hosts
    const [[{ total_hosts }]] = await pool.query(
      'SELECT COUNT(DISTINCT owner_id) as total_hosts FROM rooms'
    );

    // 3. Total rooms created
    const [[{ total_rooms }]] = await pool.query('SELECT COUNT(*) as total_rooms FROM rooms');

    // 4. Total participants joined
    const [[{ total_participants }]] = await pool.query(
      'SELECT COUNT(*) as total_participants FROM room_participants'
    );

    // 5. Total support tickets
    const [[{ total_tickets }]] = await pool.query(
      'SELECT COUNT(*) as total_tickets FROM support_tickets'
    );

    // 6. Active live rooms
    let active_live_rooms = 0;
    for (const [roomName, s] of io.sockets.adapter.rooms) {
      if (roomName.startsWith('r') && s.size > 0) active_live_rooms++;
    }

    // 7. Host Breakdown: how many rooms each host created & how many participants joined their rooms
    const [host_breakdown] = await pool.query(`
      SELECT 
        u.id as host_id,
        u.name as host_name,
        u.email as host_email,
        u.role as host_role,
        u.created_at as joined_date,
        COUNT(DISTINCT r.id) as rooms_created,
        COUNT(p.id) as participants_added,
        MAX(r.created_at) as last_meeting_at
      FROM users u
      LEFT JOIN rooms r ON r.owner_id = u.id
      LEFT JOIN room_participants p ON p.room_id = r.id
      WHERE u.email NOT LIKE "guest-%"
      GROUP BY u.id, u.name, u.email, u.role, u.created_at
      ORDER BY participants_added DESC, rooms_created DESC
    `);

    // 8. Recent meetings with participant counts
    const [recent_meetings] = await pool.query(`
      SELECT 
        r.id,
        r.code,
        r.name as room_title,
        r.created_at,
        u.name as host_name,
        u.email as host_email,
        COUNT(p.id) as participants_count
      FROM rooms r
      LEFT JOIN users u ON u.id = r.owner_id
      LEFT JOIN room_participants p ON p.room_id = r.id
      GROUP BY r.id, r.code, r.name, r.created_at, u.name, u.email
      ORDER BY r.created_at DESC
      LIMIT 25
    `);

    // 9. Recent users
    const [recent_users] = await pool.query(`
      SELECT id, name, email, role, created_at
      FROM users
      ORDER BY created_at DESC
      LIMIT 30
    `);

    res.json({
      metrics: {
        total_users,
        total_hosts,
        total_rooms,
        total_participants,
        active_live_rooms,
        total_tickets,
      },
      host_breakdown,
      recent_meetings,
      recent_users,
    });
  })
);

app.patch(
  '/api/portal/users/:id/role',
  auth,
  asyncHandler(async (req, res) => {
    const role = String(req.body.role || 'user').toLowerCase();
    if (!['admin', 'support', 'host', 'user'].includes(role)) {
      fail(400, 'Invalid role');
    }
    await pool.query('UPDATE users SET role = ? WHERE id = ?', [role, req.params.id]);
    res.json({ success: true, role });
  })
);

/* Create User / Host directly from Portal */
app.post(
  '/api/portal/users',
  auth,
  asyncHandler(async (req, res) => {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || 'camknock123');
    const role = String(req.body.role || 'user').toLowerCase();

    if (!name || name.length < 2) fail(400, 'Name must be at least 2 characters');
    if (!EMAIL_RE.test(email)) fail(400, 'Valid email is required');
    if (!['admin', 'support', 'host', 'user'].includes(role)) fail(400, 'Invalid role');

    const hash = await bcrypt.hash(password, 10);
    try {
      const [result] = await pool.query(
        'INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)',
        [name, email, hash, role]
      );
      res.status(201).json({ success: true, id: result.insertId, name, email, role });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') fail(409, 'This email already exists');
      throw err;
    }
  })
);

/* Delete User from Portal */
app.delete(
  '/api/portal/users/:id',
  auth,
  asyncHandler(async (req, res) => {
    await pool.query('DELETE FROM users WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  })
);

/* Reset User Password from Portal */
app.patch(
  '/api/portal/users/:id/password',
  auth,
  asyncHandler(async (req, res) => {
    const newPassword = String(req.body.password || 'camknock123');
    if (newPassword.length < 6) fail(400, 'Password must be at least 6 characters');
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.params.id]);
    res.json({ success: true, message: 'Password updated successfully' });
  })
);

/* Live Calls Monitor & Real-Time Management */
app.get(
  '/api/portal/live-rooms',
  asyncHandler(async (_req, res) => {
    const live = [];
    for (const [roomKey, socketSet] of io.sockets.adapter.rooms) {
      if (roomKey.startsWith('r') && socketSet.size > 0) {
        const code = roomKey.slice(1);
        const [rows] = await pool.query(
          `SELECT r.*, u.name as host_name, u.email as host_email 
           FROM rooms r 
           LEFT JOIN users u ON u.id = r.owner_id 
           WHERE r.code = ? LIMIT 1`,
          [code]
        );
        const roomData = rows[0] || { code, name: 'Live Call', host_name: 'Guest' };
        live.push({
          code,
          title: roomData.name || 'CamKnock Live Call',
          host: roomData.host_name || 'Guest Host',
          host_email: roomData.host_email || '',
          active_participants: socketSet.size,
          created_at: roomData.created_at || new Date().toISOString(),
        });
      }
    }
    res.json(live);
  })
);

/* Force Terminate Room from Portal */
app.post(
  '/api/portal/rooms/:code/end',
  auth,
  asyncHandler(async (req, res) => {
    const code = String(req.params.code).trim().toLowerCase();
    io.to('r' + code).emit('room-ended', { message: 'This meeting was ended by CamKnock Support & Admin Operations.' });

    const [rows] = await pool.query('SELECT id FROM rooms WHERE code = ? LIMIT 1', [code]);
    if (rows.length) {
      await pool.query('UPDATE room_participants SET left_at = NOW() WHERE room_id = ? AND left_at IS NULL', [rows[0].id]);
    }
    res.json({ success: true, message: `Room ${code} terminated successfully` });
  })
);

/* Room Audit (Messages, Files, Participants) */
app.get(
  '/api/portal/rooms/:code/audit',
  auth,
  asyncHandler(async (req, res) => {
    const code = String(req.params.code).trim().toLowerCase();
    const [rooms] = await pool.query('SELECT * FROM rooms WHERE code = ? LIMIT 1', [code]);
    if (!rooms.length) fail(404, 'Room not found');
    const roomId = rooms[0].id;

    const [participants] = await pool.query(
      `SELECT p.*, u.name as user_name, u.email as user_email 
       FROM room_participants p 
       JOIN users u ON u.id = p.user_id 
       WHERE p.room_id = ? 
       ORDER BY p.joined_at DESC`,
      [roomId]
    );

    const [messages] = await pool.query(
      `SELECT m.*, u.name as sender_name 
       FROM messages m 
       JOIN users u ON u.id = m.user_id 
       WHERE m.room_id = ? 
       ORDER BY m.created_at ASC`,
      [roomId]
    );

    const [files] = await pool.query(
      `SELECT f.*, u.name as uploader_name 
       FROM files f 
       JOIN users u ON u.id = f.user_id 
       WHERE f.room_id = ? 
       ORDER BY f.created_at DESC`,
      [roomId]
    );

    res.json({
      room: rooms[0],
      participants,
      messages,
      files,
    });
  })
);

/* Support Tickets Advanced Management */
app.patch(
  '/api/portal/tickets/:id',
  auth,
  asyncHandler(async (req, res) => {
    const status = req.body.status;
    const priority = req.body.priority;
    const reply = req.body.reply;
    const internal_notes = req.body.internal_notes;

    const updates = [];
    const params = [];
    if (status) { updates.push('status = ?'); params.push(status); }
    if (priority) { updates.push('priority = ?'); params.push(priority); }
    if (reply !== undefined) { updates.push('reply = ?'); params.push(reply); }
    if (internal_notes !== undefined) { updates.push('internal_notes = ?'); params.push(internal_notes); }

    if (updates.length) {
      params.push(req.params.id);
      await pool.query(`UPDATE support_tickets SET ${updates.join(', ')} WHERE id = ?`, params);
    }
    res.json({ success: true });
  })
);

app.delete(
  '/api/portal/tickets/:id',
  auth,
  asyncHandler(async (req, res) => {
    await pool.query('DELETE FROM support_tickets WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  })
);

/* Platform Settings (Website Settings & Helpline) */
app.get(
  '/api/portal/settings',
  asyncHandler(async (_req, res) => {
    const [rows] = await pool.query('SELECT * FROM platform_settings');
    const settings = {};
    rows.forEach((r) => { settings[r.key_name] = r.key_value; });
    res.json(settings);
  })
);

app.post(
  '/api/portal/settings',
  auth,
  asyncHandler(async (req, res) => {
    const entries = Object.entries(req.body);
    for (const [key, val] of entries) {
      await pool.query(
        'INSERT INTO platform_settings (key_name, key_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE key_value = VALUES(key_value)',
        [key, String(val)]
      );
    }
    res.json({ success: true, message: 'Settings saved' });
  })
);

app.get(
  '/api/public/settings',
  asyncHandler(async (_req, res) => {
    const [rows] = await pool.query('SELECT * FROM settings WHERE id = 1');
    res.json(rows[0] || {});
  })
);

// Register Complete CamKnock Admin Portal API & WebSocket Routes
const registerAdminRoutes = require('./admin_routes');
registerAdminRoutes(app, pool, io, SECRET);

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

app.get('/r/:code', (req, res) => {
  const code = String(req.params.code || '').trim().toLowerCase();
  res.redirect('/call?code=' + encodeURIComponent(code));
});

const PAGES = {
  '/home': 'home.html',
  '/call': 'call.html',
  '/signup': 'signup.html',
  '/join': 'join.html',
  '/signin': 'signin.html',
  '/login': 'signin.html',
  '/privacy': 'privacy.html',
  '/terms': 'terms.html',
  '/help': 'help.html',
};

app.get('/portal', (_req, res) => {
  res.sendFile(path.join(PORTAL_DIR, 'index.html'));
});

app.get('/portal/login', (_req, res) => {
  res.sendFile(path.join(PORTAL_DIR, 'login.html'));
});

app.get(Object.keys(PAGES), (req, res, next) => {
  res.sendFile(path.join(PUBLIC_DIR, PAGES[req.path]), (error) =>
    error ? next(error) : undefined
  );
});

// SPA-ish fallback: unknown page requests go back to the entry page.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  if (path.extname(req.path)) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// eslint-disable-next-line no-unused-vars
app.use((error, req, res, _next) => {
  if (error instanceof multer.MulterError) {
    const message =
      error.code === 'LIMIT_FILE_SIZE'
        ? `File is larger than ${MAX_UPLOAD_MB}MB`
        : 'Upload failed';
    return res.status(400).json({ error: message });
  }
  const status = error.status || 500;
  if (status >= 500) console.error('[api]', req.method, req.originalUrl, error);
  res.status(status).json({ error: status >= 500 ? 'Server error' : error.message });
});

/* ------------------------------------------------------------------ */
/* Socket.IO                                                          */
/* ------------------------------------------------------------------ */

io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (!token) return next(new Error('unauthorized'));
  try {
    const user = jwt.verify(token, SECRET);
    socket.data.userId = user.id;
    socket.data.name = user.name;
    next();
  } catch {
    next(new Error('unauthorized'));
  }
});

io.on('connection', (socket) => {
  socket.data.roomCode = null;

  socket.on('join', async (payload, ack = () => {}) => {
    try {
      const code = String((payload && payload.code) || payload || '').trim().toLowerCase();
      if (!code) return ack({ error: 'Room code is required' });

      // Check system maintenance and dynamic capacity from settings table
      let maxAllowed = MAX_PARTICIPANTS;
      try {
        const [settRows] = await pool.query('SELECT maintenance, max_participants FROM settings WHERE id = 1 LIMIT 1');
        if (settRows.length) {
          if (Number(settRows[0].maintenance) === 1) {
            return ack({ error: 'CamKnock is currently undergoing system maintenance. Please try again later.' });
          }
          if (settRows[0].max_participants) {
            maxAllowed = Number(settRows[0].max_participants);
          }
        }
      } catch (e) {
        // ignore
      }

      const room = await roomByCode(code);
      if (!room) return ack({ error: 'Room not found — check the code and try again' });

      if (socket.data.roomCode && socket.data.roomCode !== code) {
        socket.leave('r' + socket.data.roomCode);
      }

      if ((await activeCount(code)) >= maxAllowed) {
        return ack({ error: `This room is full (${maxAllowed} participants max)` });
      }

      socket.join('r' + code);
      socket.data.roomCode = code;

      await pool.query(
        `INSERT INTO room_participants (room_id, user_id, joined_at, left_at)
         VALUES (?, ?, NOW(), NULL)
         ON DUPLICATE KEY UPDATE left_at = NULL, joined_at = NOW()`,
        [room.id, socket.data.userId]
      );

      // Record join in joins table
      try {
        await pool.query(
          'INSERT INTO joins (meeting_code, name, user_id) VALUES (?, ?, ?)',
          [code, socket.data.name || 'Guest Participant', socket.data.userId || null]
        );
        await pool.query(
          'UPDATE meetings SET status = "live" WHERE code = ?',
          [code]
        );
      } catch (e) {
        // ignore duplicate/schema errors
      }

      const peers = (await io.in('r' + code).fetchSockets())
        .filter((peer) => peer.id !== socket.id)
        .map((peer) => ({
          id: peer.id,
          name: peer.data.name,
          userId: peer.data.userId,
          state: peer.data.state || { mic: true, cam: true },
        }));

      socket.to('r' + code).emit('peer-joined', {
        id: socket.id,
        name: socket.data.name,
        userId: socket.data.userId,
        state: socket.data.state || { mic: true, cam: true },
      });

      const [strokeRows] = await pool.query(
        'SELECT data FROM strokes WHERE room_id = ? ORDER BY id',
        [room.id]
      );
      const [fileRows] = await pool.query(
        `SELECT f.id, f.original_name AS name, f.size, f.created_at, u.name AS uploader
           FROM files f
           JOIN users u ON u.id = f.user_id
          WHERE f.room_id = ?
          ORDER BY f.id`,
        [room.id]
      );
      const [messageRows] = await pool.query(
        `SELECT m.id, m.content, m.created_at, u.name AS sender, m.user_id
           FROM messages m
           JOIN users u ON u.id = m.user_id
          WHERE m.room_id = ?
          ORDER BY m.created_at DESC
          LIMIT 50`,
        [room.id]
      );

      ack({
        room: { code: room.code, name: room.name },
        isHost: Number(room.owner_id) === Number(socket.data.userId),
        selfId: socket.id,
        peers,
        strokes: strokeRows.map((row) => row.data),
        files: fileRows,
        messages: messageRows.reverse(),
        limits: { maxParticipants: MAX_PARTICIPANTS, maxUploadMb: MAX_UPLOAD_MB },
      });
    } catch (error) {
      console.error('[socket:join]', error);
      ack({ error: 'Could not join the room right now' });
    }
  });

  socket.on('signal', ({ to, data } = {}) => {
    const code = socket.data.roomCode;
    if (!code || !to || !data) return;
    if (!io.sockets.adapter.rooms.get('r' + code)?.has(to)) return;
    io.to(to).emit('signal', { from: socket.id, name: socket.data.name, data });
  });

  socket.on('peer-state', (state = {}) => {
    const code = socket.data.roomCode;
    if (!code) return;
    socket.data.state = {
      mic: state.mic !== false,
      cam: state.cam !== false,
      sharing: state.sharing === true,
      hand: state.hand === true,
    };
    socket.to('r' + code).emit('peer-state', { id: socket.id, state: socket.data.state });
  });

  socket.on('stroke', async (stroke) => {
    const code = socket.data.roomCode;
    if (!code || !Array.isArray(stroke?.p) || !stroke.p.length) return;
    if (stroke.p.length > 8000) return;

    // Points arrive normalised to the canvas (0..1) so every client can
    // redraw the same stroke at its own resolution.
    const clean = {
      p: stroke.p
        .slice(0, 8000)
        .map((value) => Math.min(Math.max(Number(value) || 0, 0), 1))
        .map((value) => Math.round(value * 100000) / 100000),
      c: String(stroke.c || '#0E7A4B').slice(0, 9),
      w: Math.min(Math.max(Number(stroke.w) || 3, 1), 40),
    };

    const [rows] = await pool.query('SELECT id FROM rooms WHERE code = ? LIMIT 1', [code]);
    if (!rows.length) return;

    try {
      await pool.query('INSERT INTO strokes (room_id, data) VALUES (?, ?)', [
        rows[0].id,
        JSON.stringify(clean),
      ]);
    } catch (error) {
      console.error('[socket:stroke]', error.message);
    }
    socket.to('r' + code).emit('stroke', clean);
  });

  socket.on('clear-board', async () => {
    const code = socket.data.roomCode;
    if (!code) return;
    try {
      const [rows] = await pool.query('SELECT id FROM rooms WHERE code = ? LIMIT 1', [code]);
      if (rows.length) await pool.query('DELETE FROM strokes WHERE room_id = ?', [rows[0].id]);
    } catch (error) {
      console.error('[socket:clear-board]', error.message);
    }
    socket.to('r' + code).emit('clear-board');
  });

  socket.on('disconnect', async () => {
    const code = socket.data.roomCode;
    if (!code) return;
    socket.to('r' + code).emit('peer-left', socket.id);

    try {
      const [rows] = await pool.query('SELECT id FROM rooms WHERE code = ? LIMIT 1', [code]);
      if (rows.length) {
        await pool.query(
          `UPDATE room_participants SET left_at = NOW()
            WHERE room_id = ? AND user_id = ? AND left_at IS NULL`,
          [rows[0].id, socket.data.userId]
        );
      }
    } catch (error) {
      console.error('[socket:disconnect]', error.message);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Lifecycle                                                          */
/* ------------------------------------------------------------------ */

server.listen(PORT, () => {
  console.log(`CamKnock running on http://localhost:${PORT}`);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`[fatal] Port ${PORT} is already in use. Stop the other process or set PORT in .env`);
    process.exit(1);
  }
  console.error('[fatal]', error.message);
  process.exit(1);
});

const shutdown = async (signal) => {
  console.log(`\n${signal} received — shutting down`);
  io.close();
  server.close();
  await pool.end().catch(() => {});
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
