'use strict';
require('dotenv').config();
const mysql = require('mysql2/promise');

async function migrate() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'meetroom',
  });

  console.log('Connecting to MySQL...');

  // 1. Users table: status column
  const [userCols] = await pool.query('DESCRIBE users');
  const hasStatus = userCols.some((c) => c.Field === 'status');
  if (!hasStatus) {
    console.log('Adding status to users table...');
    await pool.query('ALTER TABLE users ADD COLUMN status VARCHAR(20) DEFAULT "active"');
  }

  // Ensure default admins have role='admin' and status='active'
  await pool.query(
    'UPDATE users SET role = "admin" WHERE email IN ("admin@meetroom.local", "demo@camknock.app", "roaimmehdi@gmail.com")'
  );
  await pool.query('UPDATE users SET status = "active" WHERE status IS NULL OR status = ""');

  // 2. Meetings table
  console.log('Ensuring meetings table...');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS meetings (
      code VARCHAR(20) PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      host_id INT NOT NULL,
      date DATE NULL,
      time TIME NULL,
      duration_min INT DEFAULT 30,
      status ENUM('scheduled', 'completed', 'live') DEFAULT 'live',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Migrate existing rooms into meetings
  await pool.query(`
    INSERT IGNORE INTO meetings (code, title, host_id, date, time, duration_min, status, created_at)
    SELECT 
      r.code, 
      COALESCE(r.name, 'CamKnock Meeting'), 
      COALESCE(r.owner_id, 1),
      DATE(r.created_at),
      TIME(r.created_at),
      30,
      'completed',
      r.created_at
    FROM rooms r
  `);

  // Migrate scheduled_meetings into meetings
  await pool.query(`
    INSERT IGNORE INTO meetings (code, title, host_id, date, time, duration_min, status, created_at)
    SELECT 
      COALESCE(NULLIF(room_code, ''), CONCAT('sm-', id)), 
      COALESCE(title, 'Scheduled Meeting'), 
      COALESCE(host_id, 1),
      scheduled_date,
      scheduled_time,
      COALESCE(duration_mins, 30),
      CASE WHEN status = 'upcoming' THEN 'scheduled' ELSE 'completed' END,
      created_at
    FROM scheduled_meetings
  `);

  // 3. Joins table
  console.log('Ensuring joins table...');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS joins (
      id INT AUTO_INCREMENT PRIMARY KEY,
      meeting_code VARCHAR(20) NOT NULL,
      name VARCHAR(120) NOT NULL,
      user_id INT NULL,
      joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX (meeting_code),
      INDEX (user_id)
    )
  `);

  // Migrate room_participants into joins
  await pool.query(`
    INSERT IGNORE INTO joins (id, meeting_code, name, user_id, joined_at)
    SELECT 
      p.id,
      r.code,
      COALESCE(u.name, 'Guest Participant'),
      p.user_id,
      p.joined_at
    FROM room_participants p
    JOIN rooms r ON r.id = p.room_id
    LEFT JOIN users u ON u.id = p.user_id
  `);

  // 4. Tickets table
  console.log('Ensuring tickets table...');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tickets (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_email VARCHAR(160) NOT NULL,
      subject VARCHAR(255) NOT NULL,
      status ENUM('open', 'progress', 'resolved') DEFAULT 'open',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Migrate support_tickets to tickets
  await pool.query(`
    INSERT IGNORE INTO tickets (id, user_email, subject, status, created_at)
    SELECT 
      id,
      COALESCE(email, 'user@camknock.com'),
      COALESCE(subject, 'Help Inquiry'),
      CASE 
        WHEN status = 'resolved' THEN 'resolved'
        WHEN status = 'in_progress' THEN 'progress'
        ELSE 'open'
      END,
      created_at
    FROM support_tickets
  `);

  // 5. Ticket_messages table
  console.log('Ensuring ticket_messages table...');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ticket_messages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      ticket_id INT NOT NULL,
      \`from\` ENUM('user', 'admin') NOT NULL,
      text TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX (ticket_id)
    )
  `);

  // Populate ticket_messages
  const [oldTickets] = await pool.query('SELECT id, message, reply, created_at FROM support_tickets');
  for (const ot of oldTickets) {
    const [msgCount] = await pool.query('SELECT COUNT(*) as c FROM ticket_messages WHERE ticket_id = ?', [ot.id]);
    if (msgCount[0].c === 0) {
      if (ot.message) {
        await pool.query('INSERT INTO ticket_messages (ticket_id, `from`, text, created_at) VALUES (?, "user", ?, ?)', [
          ot.id,
          ot.message,
          ot.created_at,
        ]);
      }
      if (ot.reply) {
        await pool.query('INSERT INTO ticket_messages (ticket_id, `from`, text, created_at) VALUES (?, "admin", ?, ?)', [
          ot.id,
          ot.reply,
          ot.created_at,
        ]);
      }
    }
  }

  // 6. Settings table
  console.log('Ensuring settings table...');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      id INT PRIMARY KEY DEFAULT 1,
      guest_join TINYINT(1) DEFAULT 1,
      host_login TINYINT(1) DEFAULT 1,
      screen_share TINYINT(1) DEFAULT 1,
      chat TINYINT(1) DEFAULT 1,
      maintenance TINYINT(1) DEFAULT 0,
      max_participants INT DEFAULT 25,
      max_minutes INT DEFAULT 60,
      banner TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`
    INSERT INTO settings (id, guest_join, host_login, screen_share, chat, maintenance, max_participants, max_minutes, banner)
    VALUES (1, 1, 1, 1, 1, 0, 25, 60, 'Welcome to CamKnock — Fast, secure and instant WebRTC video calling.')
    ON DUPLICATE KEY UPDATE id = 1
  `);

  // 7. Audit_logs table
  console.log('Ensuring audit_logs table...');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      admin_id INT,
      admin_email VARCHAR(160),
      action VARCHAR(100) NOT NULL,
      details TEXT,
      ip_address VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log('All migrations executed successfully!');
  await pool.end();
  process.exit(0);
}

migrate().catch((err) => {
  console.error('Migration error:', err);
  process.exit(1);
});

