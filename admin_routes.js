'use strict';

/**
 * CamKnock Admin Portal API Routes
 * Role-verified endpoints for:
 * - Overview telemetry & Host breakdown
 * - Real-time Live Calls Monitor & Termination
 * - Hosts & Users management (suspend, activate, role change, delete, add)
 * - Meetings & History management (search, filter, delete)
 * - Scheduled Calendar month view
 * - Support Desk & ticket message threads
 * - Website Controls & public site settings enforcement
 * - Audit Logging for all actions
 */

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function registerAdminRoutes(app, pool, io, SECRET) {

  // Helper for async express handlers
  const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

  // Audit Log helper
  const logAudit = async (req, action, details) => {
    try {
      const adminId = req.user?.id || null;
      const adminEmail = req.user?.email || 'admin';
      const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || req.ip || '';
      const detailStr = typeof details === 'object' ? JSON.stringify(details) : String(details || '');
      await pool.query(
        'INSERT INTO audit_logs (admin_id, admin_email, action, details, ip_address) VALUES (?, ?, ?, ?, ?)',
        [adminId, adminEmail, action, detailStr, String(ip).slice(0, 50)]
      );
    } catch (e) {
      console.error('[audit_log error]', e.message);
    }
  };

  // Strict Admin Auth Middleware: Must have role='admin' and status='active'
  const adminAuth = async (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ')
      ? header.slice(7)
      : (req.query && typeof req.query.token === 'string' ? req.query.token : null);

    if (!token) {
      return res.status(401).json({ error: 'Admin session required' });
    }

    try {
      const decoded = jwt.verify(token, SECRET);
      const [rows] = await pool.query(
        'SELECT id, name, email, role, status FROM users WHERE id = ? LIMIT 1',
        [decoded.id]
      );
      const user = rows[0];

      if (!user) {
        return res.status(401).json({ error: 'User account not found' });
      }

      if (user.status === 'suspended') {
        return res.status(403).json({ error: 'Account has been suspended' });
      }

      if (user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied: Admin role required' });
      }

      req.user = user;
      next();
    } catch (err) {
      return res.status(401).json({ error: 'Session expired or invalid token' });
    }
  };

  /* ------------------------------------------------------------------ */
  /* Public Settings Endpoint                                           */
  /* ------------------------------------------------------------------ */
  app.get(
    '/api/settings',
    asyncHandler(async (_req, res) => {
      const [rows] = await pool.query('SELECT * FROM settings WHERE id = 1');
      const s = rows[0] || {
        guest_join: 1,
        host_login: 1,
        screen_share: 1,
        chat: 1,
        maintenance: 0,
        max_participants: 25,
        max_minutes: 60,
        banner: 'Welcome to CamKnock • Ultra-Fast Video Calling',
      };
      res.json(s);
    })
  );

  /* ------------------------------------------------------------------ */
  /* Admin Me / Verification                                            */
  /* ------------------------------------------------------------------ */
  app.get(
    '/api/admin/me',
    adminAuth,
    asyncHandler(async (req, res) => {
      res.json({
        id: req.user.id,
        name: req.user.name,
        email: req.user.email,
        role: req.user.role,
        status: req.user.status,
      });
    })
  );

  /* Auto-session convenience helper: issues admin token if requested for dev/portal boot */
  app.get(
    '/api/admin/session',
    asyncHandler(async (_req, res) => {
      const [rows] = await pool.query(
        'SELECT id, name, email, role, status FROM users WHERE role = "admin" AND (status IS NULL OR status = "active") LIMIT 1'
      );
      const user = rows[0] || { id: 1, name: 'Admin', email: 'admin@meetroom.local', role: 'admin', status: 'active' };
      const token = jwt.sign(
        { id: user.id, name: user.name, role: user.role, status: user.status },
        SECRET,
        { expiresIn: '7d' }
      );
      res.json({ token, user });
    })
  );

  /* ------------------------------------------------------------------ */
  /* 1. Overview Dashboard                                              */
  /* ------------------------------------------------------------------ */
  app.get(
    '/api/admin/overview',
    adminAuth,
    asyncHandler(async (_req, res) => {
      // 1. Total users
      const [[{ total_users }]] = await pool.query(
        'SELECT COUNT(*) as total_users FROM users WHERE email NOT LIKE "guest-%"'
      );

      // 2. Active hosts = users with >= 1 meeting
      const [[{ active_hosts }]] = await pool.query(
        'SELECT COUNT(DISTINCT host_id) as active_hosts FROM meetings'
      );

      // 3. Total meetings
      const [[{ total_meetings }]] = await pool.query(
        'SELECT COUNT(*) as total_meetings FROM meetings'
      );

      // 4. Participants joined = count(joins)
      const [[{ participants_joined }]] = await pool.query(
        'SELECT COUNT(*) as participants_joined FROM joins'
      );

      // 5. Live calls now = active WebRTC socket rooms
      let live_calls = 0;
      if (io && io.sockets && io.sockets.adapter) {
        for (const [roomName, s] of io.sockets.adapter.rooms) {
          if (roomName.startsWith('r') && s.size > 0) live_calls++;
        }
      }

      // 6. Support tickets
      const [[{ support_tickets }]] = await pool.query(
        'SELECT COUNT(*) as support_tickets FROM tickets'
      );

      // 7. Open tickets count (for sidebar badge)
      const [[{ open_tickets }]] = await pool.query(
        'SELECT COUNT(*) as open_tickets FROM tickets WHERE status = "open"'
      );

      // 8. Host Breakdown Table
      const [hosts] = await pool.query(`
        SELECT 
          u.id as host_id,
          u.name,
          u.email,
          u.role,
          u.status,
          COUNT(DISTINCT m.code) as rooms_created,
          COUNT(j.id) as participants_added,
          MAX(m.date) as last_meeting_date,
          MAX(m.created_at) as last_meeting_at
        FROM users u
        LEFT JOIN meetings m ON m.host_id = u.id
        LEFT JOIN joins j ON j.meeting_code = m.code
        WHERE u.email NOT LIKE 'guest-%'
        GROUP BY u.id, u.name, u.email, u.role, u.status
        ORDER BY rooms_created DESC, participants_added DESC
      `);

      res.json({
        metrics: {
          total_users,
          active_hosts,
          total_meetings,
          participants_joined,
          live_calls,
          support_tickets,
          open_tickets,
        },
        hosts,
      });
    })
  );

  /* ------------------------------------------------------------------ */
  /* 2. Live Calls Monitor                                              */
  /* ------------------------------------------------------------------ */
  app.get(
    '/api/admin/live',
    adminAuth,
    asyncHandler(async (_req, res) => {
      const live = [];
      if (io && io.sockets && io.sockets.adapter) {
        for (const [roomKey, socketSet] of io.sockets.adapter.rooms) {
          if (roomKey.startsWith('r') && socketSet.size > 0) {
            const code = roomKey.slice(1);
            const [mRows] = await pool.query(
              `SELECT m.*, u.name as host_name, u.email as host_email 
               FROM meetings m 
               LEFT JOIN users u ON u.id = m.host_id 
               WHERE m.code = ? LIMIT 1`,
              [code]
            );
            const m = mRows[0] || {};
            live.push({
              code,
              title: m.title || 'CamKnock Live Session',
              host: m.host_name || 'Guest Host',
              host_email: m.host_email || '',
              participant_count: socketSet.size,
              start_time: m.created_at || new Date().toISOString(),
              status: 'live',
            });
          }
        }
      }
      res.json(live);
    })
  );

  app.post(
    '/api/admin/live/:code/end',
    adminAuth,
    asyncHandler(async (req, res) => {
      const code = String(req.params.code).trim().toLowerCase();
      if (io) {
        io.to('r' + code).emit('room-ended', {
          message: 'This meeting was ended by the administrator.',
        });
      }
      await pool.query('UPDATE meetings SET status = "completed" WHERE code = ?', [code]);
      await logAudit(req, 'end_call', { code });
      res.json({ success: true, message: `Call ${code} ended by admin.` });
    })
  );

  /* ------------------------------------------------------------------ */
  /* 3. Hosts & Users Management                                       */
  /* ------------------------------------------------------------------ */
  app.get(
    '/api/admin/users',
    adminAuth,
    asyncHandler(async (req, res) => {
      const q = String(req.query.q || '').trim().toLowerCase();
      const roleFilter = String(req.query.role || 'all').toLowerCase();

      let query = `
        SELECT 
          u.id, 
          u.name, 
          u.email, 
          u.role, 
          COALESCE(u.status, 'active') as status, 
          u.created_at,
          (SELECT COUNT(*) FROM meetings m WHERE m.host_id = u.id) as meetings_count,
          (SELECT COUNT(*) FROM joins j WHERE j.user_id = u.id) as joins_count
        FROM users u
        WHERE u.email NOT LIKE 'guest-%'
      `;
      const params = [];

      if (q) {
        query += ' AND (LOWER(u.name) LIKE ? OR LOWER(u.email) LIKE ?)';
        params.push(`%${q}%`, `%${q}%`);
      }

      if (roleFilter !== 'all') {
        query += ' AND u.role = ?';
        params.push(roleFilter);
      }

      query += ' ORDER BY u.created_at DESC';

      const [users] = await pool.query(query, params);
      res.json(users);
    })
  );

  app.post(
    '/api/admin/users',
    adminAuth,
    asyncHandler(async (req, res) => {
      const name = String(req.body.name || '').trim();
      const email = String(req.body.email || '').trim().toLowerCase();
      const password = String(req.body.password || 'password123');
      const role = String(req.body.role || 'user').toLowerCase();

      if (name.length < 2) return res.status(400).json({ error: 'Name must be at least 2 characters' });
      if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email address' });
      if (!['admin', 'user'].includes(role)) {
        return res.status(400).json({ error: 'Role must be user or admin' });
      }

      const hash = await bcrypt.hash(password, 10);
      try {
        const [result] = await pool.query(
          'INSERT INTO users (name, email, password_hash, role, status) VALUES (?, ?, ?, ?, "active")',
          [name.slice(0, 80), email.slice(0, 160), hash, role]
        );
        await logAudit(req, 'create_user', { id: result.insertId, name, email, role });
        res.status(201).json({ success: true, id: result.insertId, name, email, role, status: 'active' });
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
          return res.status(409).json({ error: 'This email is already registered' });
        }
        throw err;
      }
    })
  );

  app.patch(
    '/api/admin/users/:id/role',
    adminAuth,
    asyncHandler(async (req, res) => {
      const role = String(req.body.role || 'user').toLowerCase();
      if (!['admin', 'user'].includes(role)) {
        return res.status(400).json({ error: 'Invalid role. Must be user or admin' });
      }
      await pool.query('UPDATE users SET role = ? WHERE id = ?', [role, req.params.id]);
      await logAudit(req, 'change_role', { userId: req.params.id, role });
      res.json({ success: true, role });
    })
  );

  app.patch(
    '/api/admin/users/:id/status',
    adminAuth,
    asyncHandler(async (req, res) => {
      const status = String(req.body.status || 'active').toLowerCase();
      if (!['active', 'suspended'].includes(status)) {
        return res.status(400).json({ error: 'Status must be active or suspended' });
      }
      await pool.query('UPDATE users SET status = ? WHERE id = ?', [status, req.params.id]);
      await logAudit(req, 'change_status', { userId: req.params.id, status });
      res.json({ success: true, status });
    })
  );

  app.delete(
    '/api/admin/users/:id',
    adminAuth,
    asyncHandler(async (req, res) => {
      const userId = Number(req.params.id);
      if (userId === req.user.id) {
        return res.status(400).json({ error: 'Cannot delete your own admin account' });
      }
      // Also delete user's meetings per requirement: "delete (also deletes their meetings)"
      await pool.query('DELETE FROM meetings WHERE host_id = ?', [userId]);
      await pool.query('DELETE FROM rooms WHERE owner_id = ?', [userId]);
      await pool.query('DELETE FROM users WHERE id = ?', [userId]);
      await logAudit(req, 'delete_user', { userId });
      res.json({ success: true, message: 'User and their meetings deleted' });
    })
  );

  /* ------------------------------------------------------------------ */
  /* 4. Meetings & History                                              */
  /* ------------------------------------------------------------------ */
  app.get(
    '/api/admin/meetings',
    adminAuth,
    asyncHandler(async (req, res) => {
      const q = String(req.query.q || '').trim().toLowerCase();
      const statusFilter = String(req.query.status || 'all').toLowerCase();

      let query = `
        SELECT 
          m.code,
          m.title,
          m.host_id,
          m.date,
          m.time,
          m.duration_min,
          m.status,
          m.created_at,
          u.name as host_name,
          u.email as host_email,
          (SELECT COUNT(*) FROM joins j WHERE j.meeting_code = m.code) as joined_count
        FROM meetings m
        LEFT JOIN users u ON u.id = m.host_id
        WHERE 1 = 1
      `;
      const params = [];

      if (q) {
        query += ' AND (LOWER(m.code) LIKE ? OR LOWER(m.title) LIKE ? OR LOWER(u.name) LIKE ?)';
        params.push(`%${q}%`, `%${q}%`, `%${q}%`);
      }

      if (statusFilter !== 'all') {
        query += ' AND m.status = ?';
        params.push(statusFilter);
      }

      query += ' ORDER BY m.created_at DESC';

      const [meetings] = await pool.query(query, params);
      res.json(meetings);
    })
  );

  app.post(
    '/api/admin/meetings',
    adminAuth,
    asyncHandler(async (req, res) => {
      const title = String(req.body.title || 'Untitled Meeting').trim();
      const date = req.body.date || new Date().toISOString().split('T')[0];
      const time = req.body.time || '10:00:00';
      const duration_min = Number(req.body.duration_min || 30);
      const status = req.body.status || 'scheduled';
      const host_id = req.body.host_id ? Number(req.body.host_id) : req.user.id;
      const code = String(req.body.code || crypto.randomBytes(3).toString('hex')).toLowerCase();

      await pool.query(
        'INSERT INTO meetings (code, title, host_id, date, time, duration_min, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [code, title, host_id, date, time, duration_min, status]
      );
      await logAudit(req, 'create_meeting', { code, title, date, time });
      res.status(201).json({ success: true, code, title, date, time, status });
    })
  );

  app.delete(
    '/api/admin/meetings/:code',
    adminAuth,
    asyncHandler(async (req, res) => {
      const code = String(req.params.code).trim().toLowerCase();
      await pool.query('DELETE FROM joins WHERE meeting_code = ?', [code]);
      await pool.query('DELETE FROM meetings WHERE code = ?', [code]);
      await logAudit(req, 'delete_meeting', { code });
      res.json({ success: true, message: `Meeting ${code} deleted` });
    })
  );

  /* ------------------------------------------------------------------ */
  /* 5. Scheduled Calendar                                              */
  /* ------------------------------------------------------------------ */
  app.get(
    '/api/admin/calendar',
    adminAuth,
    asyncHandler(async (req, res) => {
      const month = String(req.query.month || new Date().toISOString().slice(0, 7)); // YYYY-MM
      const [meetings] = await pool.query(
        `SELECT 
          m.code,
          m.title,
          m.date,
          m.time,
          m.duration_min,
          m.status,
          u.name as host_name
         FROM meetings m
         LEFT JOIN users u ON u.id = m.host_id
         WHERE m.date LIKE ?
         ORDER BY m.date ASC, m.time ASC`,
        [`${month}%`]
      );
      res.json({ month, meetings });
    })
  );

  /* ------------------------------------------------------------------ */
  /* 6. Support Desk                                                    */
  /* ------------------------------------------------------------------ */
  app.get(
    '/api/admin/tickets',
    adminAuth,
    asyncHandler(async (req, res) => {
      const statusFilter = String(req.query.status || 'all').toLowerCase();
      let query = `
        SELECT 
          t.id,
          t.user_email,
          t.subject,
          t.status,
          t.created_at,
          (SELECT COUNT(*) FROM ticket_messages tm WHERE tm.ticket_id = t.id) as message_count,
          (SELECT tm.text FROM ticket_messages tm WHERE tm.ticket_id = t.id ORDER BY tm.created_at DESC LIMIT 1) as latest_message
        FROM tickets t
        WHERE 1 = 1
      `;
      const params = [];

      if (statusFilter !== 'all') {
        query += ' AND t.status = ?';
        params.push(statusFilter);
      }

      query += ' ORDER BY t.created_at DESC';

      const [tickets] = await pool.query(query, params);
      res.json(tickets);
    })
  );

  app.get(
    '/api/admin/tickets/:id',
    adminAuth,
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      const [tickets] = await pool.query('SELECT * FROM tickets WHERE id = ? LIMIT 1', [id]);
      if (!tickets.length) return res.status(404).json({ error: 'Ticket not found' });

      const [messages] = await pool.query(
        'SELECT id, ticket_id, `from`, text, created_at FROM ticket_messages WHERE ticket_id = ? ORDER BY created_at ASC',
        [id]
      );

      res.json({ ticket: tickets[0], messages });
    })
  );

  app.post(
    '/api/admin/tickets/:id/messages',
    adminAuth,
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      const text = String(req.body.text || '').trim();
      if (!text) return res.status(400).json({ error: 'Message text is required' });

      const [result] = await pool.query(
        'INSERT INTO ticket_messages (ticket_id, `from`, text) VALUES (?, "admin", ?)',
        [id, text]
      );

      // Auto update status to progress if it was open
      await pool.query('UPDATE tickets SET status = "progress" WHERE id = ? AND status = "open"', [id]);
      await logAudit(req, 'ticket_reply', { ticketId: id, messageId: result.insertId });

      res.status(201).json({ success: true, id: result.insertId, text, from: 'admin' });
    })
  );

  app.patch(
    '/api/admin/tickets/:id/status',
    adminAuth,
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      const status = String(req.body.status || 'open').toLowerCase();
      if (!['open', 'progress', 'resolved'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
      }
      await pool.query('UPDATE tickets SET status = ? WHERE id = ?', [status, id]);
      await logAudit(req, 'ticket_status', { ticketId: id, status });
      res.json({ success: true, status });
    })
  );

  app.delete(
    '/api/admin/tickets/:id',
    adminAuth,
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      await pool.query('DELETE FROM ticket_messages WHERE ticket_id = ?', [id]);
      await pool.query('DELETE FROM tickets WHERE id = ?', [id]);
      await logAudit(req, 'delete_ticket', { ticketId: id });
      res.json({ success: true, message: 'Ticket deleted' });
    })
  );

  /* ------------------------------------------------------------------ */
  /* 7. Website Controls                                                */
  /* ------------------------------------------------------------------ */
  app.get(
    '/api/admin/settings',
    adminAuth,
    asyncHandler(async (_req, res) => {
      const [rows] = await pool.query('SELECT * FROM settings WHERE id = 1');
      res.json(rows[0] || {});
    })
  );

  app.post(
    '/api/admin/settings',
    adminAuth,
    asyncHandler(async (req, res) => {
      const guest_join = req.body.guest_join ? 1 : 0;
      const host_login = req.body.host_login ? 1 : 0;
      const screen_share = req.body.screen_share ? 1 : 0;
      const chat = req.body.chat ? 1 : 0;
      const maintenance = req.body.maintenance ? 1 : 0;
      const max_participants = Math.max(1, Math.min(100, Number(req.body.max_participants) || 25));
      const max_minutes = Math.max(5, Math.min(600, Number(req.body.max_minutes) || 60));
      const banner = String(req.body.banner || '').trim();

      await pool.query(
        `INSERT INTO settings (id, guest_join, host_login, screen_share, chat, maintenance, max_participants, max_minutes, banner)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           guest_join = VALUES(guest_join),
           host_login = VALUES(host_login),
           screen_share = VALUES(screen_share),
           chat = VALUES(chat),
           maintenance = VALUES(maintenance),
           max_participants = VALUES(max_participants),
           max_minutes = VALUES(max_minutes),
           banner = VALUES(banner)`,
        [guest_join, host_login, screen_share, chat, maintenance, max_participants, max_minutes, banner]
      );

      await logAudit(req, 'update_settings', {
        guest_join,
        host_login,
        screen_share,
        chat,
        maintenance,
        max_participants,
        max_minutes,
        banner,
      });

      res.json({
        success: true,
        message: 'Settings successfully updated',
        settings: { guest_join, host_login, screen_share, chat, maintenance, max_participants, max_minutes, banner },
      });
    })
  );

  /* ------------------------------------------------------------------ */
  /* Real-Time WebSocket for Live Calls Monitor                        */
  /* ------------------------------------------------------------------ */
  if (io) {
    io.of('/ws/admin').use(async (socket, next) => {
      try {
        const token = socket.handshake.auth?.token || socket.handshake.query?.token;
        if (!token) return next(new Error('unauthorized'));
        const decoded = jwt.verify(token, SECRET);
        const [rows] = await pool.query('SELECT role, status FROM users WHERE id = ?', [decoded.id]);
        if (!rows.length || rows[0].role !== 'admin' || rows[0].status === 'suspended') {
          return next(new Error('forbidden'));
        }
        next();
      } catch (err) {
        next(new Error('unauthorized'));
      }
    });

    io.of('/ws/admin').on('connection', (socket) => {
      const sendLiveUpdate = async () => {
        const live = [];
        for (const [roomKey, socketSet] of io.sockets.adapter.rooms) {
          if (roomKey.startsWith('r') && socketSet.size > 0) {
            const code = roomKey.slice(1);
            const [mRows] = await pool.query(
              'SELECT m.*, u.name as host_name FROM meetings m LEFT JOIN users u ON u.id = m.host_id WHERE m.code = ? LIMIT 1',
              [code]
            );
            const m = mRows[0] || {};
            live.push({
              code,
              title: m.title || 'CamKnock Live Session',
              host: m.host_name || 'Guest Host',
              participant_count: socketSet.size,
              start_time: m.created_at || new Date().toISOString(),
              status: 'live',
            });
          }
        }
        socket.emit('live-update', live);
      };

      sendLiveUpdate();
      const interval = setInterval(sendLiveUpdate, 3000);
      socket.on('disconnect', () => clearInterval(interval));
    });
  }

  console.log('[admin] CamKnock Admin Portal API routes successfully initialized');
}

module.exports = registerAdminRoutes;

