/**
 * Database Migration: Add API Keys Table
 *
 * Creates table for API key management to support external API access
 */

import Database from 'better-sqlite3';

export function up(db: Database.Database): void {
  // API Keys table
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      key_preview TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      is_active INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      CHECK (is_active IN (0, 1))
    )
  `);

  // Indices for api_keys table
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
    CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash);
    CREATE INDEX IF NOT EXISTS idx_api_keys_is_active ON api_keys(is_active);
  `);

  // Only allow one active API key per user
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_user_active
    ON api_keys(user_id) WHERE is_active = 1;
  `);
}

export function down(db: Database.Database): void {
  db.exec(`DROP TABLE IF EXISTS api_keys`);
}

export const migration = { up, down };
