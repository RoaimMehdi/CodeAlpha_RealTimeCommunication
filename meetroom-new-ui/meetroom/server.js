require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');
const multer = require('multer');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { AccessToken } = require('livekit-server-sdk');

// ---------- Validation ----------
const SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET.length < 16) {
  console.error('Set JWT_SECRET (16+ chars) in .env');
  process.exit(1);
}
const PORT = Number(process.env.PORT || 3001);

const LIVEKIT_URL = process.env.LIVEKIT_URL || '';
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || '';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || '';

const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:' + PORT;

// ---------- MySQL pool ----------
const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'meetroom',
  connectionLimit: 10,
});

// ---------- Uploads ----------
const UP = path.join(__dirname, 'uploads');
fs.mkdirSync(UP, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UP,
    filename: (_, __, cb) => cb(null, crypto.randomBytes(16).toString('hex')),
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// ---------- Express app ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CORS_ORIGIN, methods: ['GET', 'POST'], credentials: true },
});

// ---------- CSP ----------
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "connect-src 'self' ws: wss: http://localhost:" + PORT + "; " +
    "media-src 'self' blob:; " +
    "img-src 'self' data:; " +
    "frame-src 'self';");
  next();
});

// ---------- Body parsing ----------
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Rate limiting ----------
app.use('/api/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 30 }));
app.use('/api/register', rateLimit({ windowMs: 60 * 60 * 1000, max: 20 }));

// ---------- Helpers ----------
const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) { console.error('API error:', e); res.status(500).json({ error: 'Server error' }); }
};
const sign = (u) => jwt.sign({ id: u.id, name: u.name, roomCode: u.roomCode }, SECRET, { expiresIn: '7d' });
const auth = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || '';
    req.user = jwt.verify(authHeader.replace('Bearer ', ''), SECRET);
    next();
  } catch (e) { res.status(401).json({ error: 'Please log in again' }); }
};
const roomByCode = async (code) => {
  const [rows] = await pool.query('SELECT * FROM rooms WHERE code=?', [code]);
  return rows[0];
};
const randomRoomCode = async () => {
  let code;
  for (let i = 0; i < 10; i++) {
    code = crypto.randomBytes(4).toString('hex');
    const [[r]] = await pool.query('SELECT id FROM rooms WHERE code=?', [code]);
    if (!r) return code;
  }
  throw new Error('Could not generate unique room code');
};

// ---------- Health ----------
app.get('/api/health', wrap(async (req, res) => {
  try {
    const [[r]] = await pool.query('SELECT 1 AS ok, NOW() AS time');
    res.json({ status: 'ok', database: 'connected', time: r.time });
  } catch (e) {
    res.status(500).json({ error: 'Database connection failed: ' + e.message });
  }
}));

// ---------- Auth ----------
app.post('/api/register', wrap(async (req, res) => {
  const { name, email, password } = req.body;
  if (!name?.trim() || !/^[^\s]+@[^\s]+\.[^\s]+$/.test(email || '') || (password || '').length < 8) {
    return res.status(400).json({ error: 'Enter a name, a valid email and a password of 8+ characters' });
  }
  const hash = await bcrypt.hash(password, 12);
  try {
    const [r] = await pool.query('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)', [name.trim(), email.toLowerCase(), hash]);
    const u = { id: r.insertId, name: name.trim() };
    res.json({ token: sign(u), name: u.name });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'This email is already registered' });
    throw e;
  }
}));

app.post('/api/login', wrap(async (req, res) => {
  const { email, password } = req.body;
  const [[u]] = await pool.query('SELECT * FROM users WHERE email=?', [(email || '').toLowerCase()]);
  if (!u || !(await bcrypt.compare(password || '', u.password_hash))) {
    return res.status(401).json({ error: 'Email or password is wrong' });
  }
  res.json({ token: sign(u), name: u.name });
}));

// ---------- Rooms ----------
app.post('/api/rooms', auth, wrap(async (req, res) => {
  const name = (req.body.name || '').trim() || 'Untitled room';
  const code = await randomRoomCode();
  await pool.query('INSERT INTO rooms (code, name, owner_id) VALUES (?, ?, ?)', [code, name.slice(0, 120), req.user.id]);
  res.json({ code, name });
}));

app.get('/api/rooms/:code', auth, wrap(async (req, res) => {
  const r = await roomByCode(req.params.code);
  if (!r) return res.status(404).json({ error: 'Room not found' });
  res.json({ code: r.code, name: r.name });
}));

app.get('/api/rooms', auth, wrap(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT r.id, r.code, r.name, r.created_at,
            (SELECT COUNT(*) FROM room_participants WHERE room_id=r.id AND left_at IS NULL) AS participant_count
     FROM rooms r
     WHERE r.owner_id=? OR EXISTS (SELECT 1 FROM room_participants WHERE room_id=r.id AND left_at IS NULL)
     ORDER BY r.created_at DESC`, [req.user.id]);
  res.json(rows);
}));

// ---------- Messages ----------
app.get('/api/rooms/:code/messages', auth, wrap(async (req, res) => {
  const room = await roomByCode(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const [rows] = await pool.query(
    `SELECT m.id, m.content, m.created_at, u.name AS sender
     FROM messages m JOIN users u ON m.user_id = u.id
     WHERE m.room_id = ? ORDER BY m.created_at ASC LIMIT 200`, [room.id]);
  res.json(rows);
}));

app.post('/api/rooms/:code/messages', auth, wrap(async (req, res) => {
  const room = await roomByCode(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const { content } = req.body;
  if (!content || content.trim().length === 0) return res.status(400).json({ error: 'Message cannot be empty' });
  const [r] = await pool.query('INSERT INTO messages (room_id, user_id, content) VALUES (?, ?, ?)', [room.id, req.user.id, content.trim()]);
  res.json({ id: r.insertId, content: content.trim(), created_at: new Date(), sender: req.user.name });
}));

// ---------- Files ----------
app.post('/api/rooms/:code/files', auth, upload.single('file'), wrap(async (req, res) => {
  const room = await roomByCode(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No file uploaded' });
  const [r] = await pool.query(
    'INSERT INTO files (room_id, user_id, original_name, stored_name, size) VALUES (?, ?, ?, ?, ?)',
    [room.id, req.user.id, file.originalname, file.filename, file.size]);
  res.json({ id: r.insertId, name: file.originalname, size: file.size, uploader: req.user.name });
}));

app.get('/api/files/:id', auth, wrap(async (req, res) => {
  const file = await pool.query('SELECT * FROM files WHERE id=?', [req.params.id]);
  if (!file || file.length === 0) return res.status(404).json({ error: 'File not found' });
  res.setHeader('Content-Disposition', 'attachment; filename="' + file[0].original_name + '"');
  res.setHeader('Content-Type', 'application/octet-stream');
  const stream = fs.createReadStream(path.join(UP, file[0].stored_name));
  stream.pipe(res);
}));

// ---------- LiveKit token endpoint ----------
app.get('/api/livekit/token', auth, wrap(async (req, res) => {
  const roomCode = req.query.code || '';
  if (!roomCode) return res.status(400).json({ error: 'Room code is required' });

  const room = await roomByCode(roomCode);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const [participants] = await pool.query(
    'SELECT user_id FROM room_participants WHERE room_id=? AND left_at IS NULL', [room.id]);
  if (!participants.some(p => p.user_id == req.user.id)) {
    return res.status(403).json({ error: 'Not a participant in this room' });
  }

  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: req.user.name,
    room: roomCode,
    metadata: JSON.stringify({ userId: req.user.id, isHost: req.user.id == room.owner_id }),
    ttl: '1h',
  });

  at.addGrant({
    roomJoin: true,
    canPublishVideo: true,
    canPublishAudio: true,
    canSubscribeVideo: true,
    canSubscribeAudio: true,
  });

  at.roomConfig = {
    maxParticipants: 100,
    resolution: 'hd',
    frameRate: 30,
    quality: 'high',
    adaptiveStream: true,
    dynacast: true,
    simulcast: true,
  };

  res.json({ token: await at.toJwt() });
}));

// ---------- Socket.IO ----------
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('auth'));
    socket.user = jwt.verify(token, SECRET);
    next();
  } catch (e) { next(new Error('auth')); }
});

io.on('connection', (socket) => {
  console.log(`User ${socket.user.id} (${socket.user.name}) connected`);

  let roomId = null;
  let roomCode = null;

  socket.on('join', async (data, cb) => {
    try {
      const { code } = data;
      const room = await roomByCode(code);
      if (!room) return cb({ error: 'Room not found' });

      socket.roomId = room.id;
      socket.room = 'r' + code;
      roomCode = code;
      socket.join(socket.room);

      // Save participant
      await pool.query('INSERT IGNORE INTO room_participants (room_id, user_id, joined_at) VALUES (?, ?, NOW())', [room.id, socket.user.id]);
      // END Save participant

      const peers = (await io.in(socket.room).fetchSockets()).map(x => ({ id: x.id, name: x.user.name }));

      socket.to(socket.room).emit('peer-joined', { id: socket.id, name: socket.user.name });

      // Load whiteboard strokes for late joiners
      let strokes = [];
      try {
        const [strokesRow] = await pool.query('SELECT data FROM strokes WHERE room_id=? ORDER BY id', [room.id]);
        strokes = strokesRow ? strokesRow.map(s => s.data) : [];
      } catch (e) { console.error('Error loading strokes:', e); }

      // Load files
      let files = [];
      try {
        const [filesRow] = await pool.query(
          `SELECT f.id, f.original_name AS name, f.size, u.name AS uploader
           FROM files f JOIN users u ON u.id = f.user_id
           WHERE f.room_id=? ORDER BY f.id`, [room.id]);
        files = filesRow || [];
      } catch (e) { console.error('Error loading files:', e); }

      // Load chat messages (last 50)
      let messages = [];
      try {
        const [messagesRow] = await pool.query(
          `SELECT m.id, m.content, m.created_at, u.name AS sender
           FROM messages m JOIN users u ON m.user_id = u.id
           WHERE m.room_id = ? ORDER BY m.created_at DESC LIMIT 50`, [room.id]);
        messages = messagesRow || [];
      } catch (e) { console.error('Error loading messages:', e); }

      // 6-person limit
      const [participantCount] = await pool.query(
        'SELECT COUNT(*) AS cnt FROM room_participants WHERE room_id=? AND left_at IS NULL', [room.id]);
      if ((participantCount[0].cnt || 0) >= 6) {
        return cb({ error: 'This room is full (6 participants max). Please join another room.' });
      }

      cb({ room: room.name, peers, strokes, files, messages: messages.reverse(), livekitRoom: roomCode });
    } catch (e) {
      console.error('Join fatal error:', e);
      cb({ error: 'Could not join: ' + e.message });
    }
  });

  socket.on('signal', ({ to, data }) => {
    if (!socket.room) return;
    io.to(to).emit('signal', { from: socket.id, name: socket.user.name, data });
  });

  socket.on('stroke', async (stroke) => {
    if (!socket.roomId || !Array.isArray(stroke?.p) || stroke.p.length > 5000) return;
    const clean = { p: stroke.p, c: String(stroke.c).slice(0, 9), w: Math.min(+stroke.w || 3, 40) };
    try {
      await pool.query('INSERT INTO strokes (room_id, data) VALUES (?, ?)', [socket.roomId, JSON.stringify(clean)]);
    } catch (e) { console.error('Stroke DB error:', e); }
    socket.to(socket.room).emit('stroke', clean);
  });

  socket.on('clear-board', async () => {
    if (!socket.roomId) return;
    try { await pool.query('DELETE FROM strokes WHERE room_id=?', [socket.roomId]); } catch (e) { console.error('Clear-board DB error:', e); }
    socket.to(socket.room).emit('clear-board');
  });

  socket.on('file-upload', async (fileData) => {
    if (!socket.roomId) return;
    const { original_name, stored_name, size } = fileData;
    try {
      const [r] = await pool.query(
        'INSERT INTO files (room_id, user_id, original_name, stored_name, size) VALUES (?, ?, ?, ?, ?)',
        [socket.roomId, socket.user.id, original_name, stored_name, size]);
      io.to(socket.room).emit('file', { id: r.insertId, name: original_name, size, uploader: socket.user.name });
    } catch (e) { console.error('File DB error:', e); }
  });

  socket.on('disconnect', () => {
    console.log(`User ${socket.user.id} (${socket.user.name}) disconnected`);
    socket.room && socket.to(socket.room).emit('peer-left', socket.id);
    if (socket.roomId) {
      pool.query('UPDATE room_participants SET left_at=NOW() WHERE room_id=? AND user_id=? AND left_at IS NULL', [socket.roomId, socket.user.id]).catch(e => console.error('Participant update error:', e));
    }
  });
});

// ---------- Start ----------
server.listen(PORT, () => {
  console.log(`MeetRoom running on http://localhost:${PORT}`);
}).on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`Port ${PORT} is already in use. Please stop the existing process or use a different port.`);
  } else {
    console.error('Server error:', e.message);
  }
});
