CREATE DATABASE IF NOT EXISTS meetroom CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE meetroom;

-- Users table: stores registered users with bcrypt-hashed passwords
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  email VARCHAR(160) NOT NULL UNIQUE,
  password_hash VARCHAR(100) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_users_email (email)
) ENGINE=InnoDB;

-- Rooms table: stores meeting rooms, owned by a user
CREATE TABLE IF NOT EXISTS rooms (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(12) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  owner_id INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_rooms_code (code)
) ENGINE=InnoDB;

-- Room participants: tracks who's in each room
CREATE TABLE IF NOT EXISTS room_participants (
  id INT AUTO_INCREMENT PRIMARY KEY,
  room_id INT NOT NULL,
  user_id INT NOT NULL,
  joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  left_at TIMESTAMP NULL,
  UNIQUE KEY uniq_participant_room (room_id, user_id),
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_room_participants_room (room_id)
) ENGINE=InnoDB;

-- Messages table: in-room text chat history
CREATE TABLE IF NOT EXISTS messages (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  room_id INT NOT NULL,
  user_id INT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_messages_room (room_id),
  INDEX idx_messages_created (created_at)
) ENGINE=InnoDB;

-- Files table: uploaded files per room
CREATE TABLE IF NOT EXISTS files (
  id INT AUTO_INCREMENT PRIMARY KEY,
  room_id INT NOT NULL,
  user_id INT NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  stored_name VARCHAR(80) NOT NULL,
  size INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_files_room (room_id)
) ENGINE=InnoDB;

-- Whiteboard strokes: drawing data persisted for late joiners
CREATE TABLE IF NOT EXISTS strokes (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  room_id INT NOT NULL,
  data JSON NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_strokes_room (room_id),
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Seed script (run after schema to create admin user)
-- Usage: mysql -u root meetroom < seed.sql
-- This creates a default admin user; replace password as needed
INSERT IGNORE INTO users (name, email, password_hash) VALUES (
  'Admin',
  'admin@meetroom.local',
  '$2a$12$LQv3eHa7mN8.gE4LzCyVluY./PR3.j4R.zN4E.h1e.GG3RJF.eJR6' -- password: admin123
);