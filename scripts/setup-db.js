#!/usr/bin/env node
'use strict';

/**
 * Idempotent database bootstrap.
 * Usage: npm run db:setup
 *
 * Reads the same .env as the server, creates the database if needed,
 * applies schema.sql and prints the resulting tables.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const DB_NAME = process.env.DB_NAME || 'meetroom';

if (!/^[A-Za-z0-9_]+$/.test(DB_NAME)) {
  console.error('DB_NAME may only contain letters, numbers and underscores.');
  process.exit(1);
}

const connectionConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  multipleStatements: true,
};

async function main() {
  console.log(`Connecting to MySQL at ${connectionConfig.host}:${connectionConfig.port}…`);
  const connection = await mysql.createConnection(connectionConfig);

  await connection.query(
    `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` ` +
      'CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'
  );
  console.log(`Database "${DB_NAME}" is ready.`);

  const schemaPath = path.join(__dirname, '..', 'schema.sql');
  const schema = fs
    .readFileSync(schemaPath, 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

  await connection.query(schema);
  console.log('schema.sql applied.');

  const [tables] = await connection.query('SHOW TABLES FROM ??', [DB_NAME]);
  const names = tables.map((row) => Object.values(row)[0]);
  console.log(`Tables (${names.length}): ${names.join(', ')}`);

  await connection.end();
}

main().catch((error) => {
  console.error('Database setup failed:', error.code || error.message);
  if (error.code === 'ER_ACCESS_DENIED_ERROR') {
    console.error('Check DB_USER / DB_PASSWORD in .env.');
  }
  process.exit(1);
});
