const mysql = require('mysql2/promise');
require('dotenv').config({ path: 'C:/Users/AA/Downloads/meetroom/meetroom/.env' });

async function migrate() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'meetroom',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'meetroom'
  });

  console.log('Connected to MySQL...');

  // 1. Add role column to users if not exists
  const [cols] = await conn.query("SHOW COLUMNS FROM users LIKE 'role'");
  if (cols.length === 0) {
    await conn.query("ALTER TABLE users ADD COLUMN role VARCHAR(30) NOT NULL DEFAULT 'user'");
    console.log('Added role column to users table');
  } else {
    console.log('role column already exists');
  }

  // 2. Set default roles for existing known accounts
  await conn.query("UPDATE users SET role = 'admin' WHERE email IN ('demo@camknock.app', 'admin@meetroom.local', 'roaimmehdi@gmail.com')");
  await conn.query("UPDATE users SET role = 'support' WHERE email IN ('codenexra@gmail.com', 'admin@autovexo.com')");
  await conn.query("UPDATE users SET role = 'host' WHERE email IN ('testuser99@example.com', 'demo@meetroom.app')");

  // 3. Create scheduled_meetings table
  await conn.query(`
    CREATE TABLE IF NOT EXISTS scheduled_meetings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      host_id INT NOT NULL,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      room_code VARCHAR(20) NOT NULL,
      scheduled_date DATE NOT NULL,
      scheduled_time TIME NOT NULL,
      duration_mins INT DEFAULT 30,
      timezone VARCHAR(50) DEFAULT 'UTC',
      status VARCHAR(20) DEFAULT 'scheduled',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_host (host_id),
      INDEX idx_date (scheduled_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  console.log('scheduled_meetings table checked/created');

  // 4. Create support_tickets table
  await conn.query(`
    CREATE TABLE IF NOT EXISTS support_tickets (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      email VARCHAR(160) NOT NULL,
      phone VARCHAR(40) DEFAULT NULL,
      subject VARCHAR(200) NOT NULL,
      message TEXT NOT NULL,
      priority VARCHAR(20) DEFAULT 'medium',
      status VARCHAR(30) DEFAULT 'open',
      assigned_to INT DEFAULT NULL,
      reply TEXT DEFAULT NULL,
      internal_notes TEXT DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Alter if columns missing
  const [ticketCols] = await conn.query("SHOW COLUMNS FROM support_tickets");
  const colNames = ticketCols.map(c => c.Field);
  if (!colNames.includes('priority')) {
    await conn.query("ALTER TABLE support_tickets ADD COLUMN priority VARCHAR(20) DEFAULT 'medium'");
  }
  if (!colNames.includes('reply')) {
    await conn.query("ALTER TABLE support_tickets ADD COLUMN reply TEXT DEFAULT NULL");
  }
  if (!colNames.includes('internal_notes')) {
    await conn.query("ALTER TABLE support_tickets ADD COLUMN internal_notes TEXT DEFAULT NULL");
  }
  console.log('support_tickets table checked/updated');

  // 5. Create platform_settings table
  await conn.query(`
    CREATE TABLE IF NOT EXISTS platform_settings (
      key_name VARCHAR(80) PRIMARY KEY,
      key_value TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await conn.query(`
    INSERT INTO platform_settings (key_name, key_value) VALUES 
    ('announcement_text', 'Introducing CamKnock 2.0: Instant WebRTC video calls, live screen sharing, and multiplayer whiteboard.'),
    ('support_phone', '+1 201-685-2107'),
    ('support_email', 'camknock@gmail.com'),
    ('max_participants', '50'),
    ('allow_guest_join', '1')
    ON DUPLICATE KEY UPDATE key_value = VALUES(key_value);
  `);
  console.log('platform_settings table checked/updated');

  // Sample support tickets if table empty
  const [tickets] = await conn.query('SELECT COUNT(*) as c FROM support_tickets');
  if (tickets[0].c === 0) {
    await conn.query(`
      INSERT INTO support_tickets (name, email, phone, subject, message, status) VALUES
      ('Sarah Jenkins', 'sarah.j@example.com', '+1 201-685-2107', 'HD Screen Sharing on Safari', 'Can I share 4K screens from Safari on Mac? Love the CamKnock speed!', 'resolved'),
      ('David Miller', 'david.m@example.com', '+1 201-685-2107', 'Whiteboard Export Question', 'How do I export PNG from multiplayer whiteboard during live calls?', 'in_progress'),
      ('Elena Rostova', 'elena@techcorp.de', '+1 201-685-2107', 'Enterprise Support Inquiry', 'We want to schedule 50+ person meetings for our marketing team.', 'open')
    `);
    console.log('Inserted sample support tickets');
  }

  // Sample scheduled meetings if table empty
  const [sched] = await conn.query('SELECT COUNT(*) as c FROM scheduled_meetings');
  if (sched[0].c === 0) {
    const [adminUser] = await conn.query("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
    const hostId = adminUser[0] ? adminUser[0].id : 1;
    await conn.query(`
      INSERT INTO scheduled_meetings (host_id, title, description, room_code, scheduled_date, scheduled_time, duration_mins) VALUES
      (?, 'Weekly Product Sync', 'Discussing CamKnock 2.0 release roadmap & WebRTC performance.', 'prod-sync', CURDATE(), '14:00:00', 45),
      (?, 'Client Presentation & Demo', 'Live demo of browser-native whiteboard and zero-download join.', 'demo-live', DATE_ADD(CURDATE(), INTERVAL 1 DAY), '10:30:00', 60),
      (?, 'Engineering Architecture Review', 'Screen sharing code audit and DTLS-SRTP encryption setup.', 'eng-arch', DATE_ADD(CURDATE(), INTERVAL 2 DAY), '16:00:00', 30)
    `, [hostId, hostId, hostId]);
    console.log('Inserted sample scheduled meetings');
  }

  await conn.end();
  console.log('Migration finished successfully!');
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});

