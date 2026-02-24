/**
 * Database Migration: Add Authentication Tables
 *
 * Creates tables for users, permissions, sessions, and audit logging
 */

import Database from 'better-sqlite3';

export function up(db: Database.Database): void {
  // Users table
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      email TEXT,
      display_name TEXT,
      auth_provider TEXT NOT NULL DEFAULT 'local',
      oidc_subject TEXT UNIQUE,
      is_admin INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      last_login_at INTEGER,
      created_by INTEGER,
      FOREIGN KEY (created_by) REFERENCES users(id),
      CHECK (auth_provider IN ('local', 'oidc')),
      CHECK (is_admin IN (0, 1)),
      CHECK (is_active IN (0, 1)),
      CHECK (
        (auth_provider = 'local' AND password_hash IS NOT NULL) OR
        (auth_provider = 'oidc' AND oidc_subject IS NOT NULL)
      )
    )
  `);

  // Indices for users table
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
    CREATE INDEX IF NOT EXISTS idx_users_oidc_subject ON users(oidc_subject);
    CREATE INDEX IF NOT EXISTS idx_users_auth_provider ON users(auth_provider);
    CREATE INDEX IF NOT EXISTS idx_users_is_active ON users(is_active);
  `);

  // Permissions table
  db.exec(`
    CREATE TABLE IF NOT EXISTS permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      resource TEXT NOT NULL,
      can_read INTEGER NOT NULL DEFAULT 0,
      can_write INTEGER NOT NULL DEFAULT 0,
      granted_at INTEGER NOT NULL,
      granted_by INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (granted_by) REFERENCES users(id),
      UNIQUE(user_id, resource),
      CHECK (can_read IN (0, 1)),
      CHECK (can_write IN (0, 1)),
      CHECK (resource IN (
        'dashboard', 'nodes', 'messages', 'settings',
        'configuration', 'info', 'automation'
      ))
    )
  `);

  // Indices for permissions table
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_permissions_user_id ON permissions(user_id);
    CREATE INDEX IF NOT EXISTS idx_permissions_resource ON permissions(resource);
  `);

  // Sessions table
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expire INTEGER NOT NULL
    )
  `);

  // Index for sessions table
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire);
  `);

  // Audit log table
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      resource TEXT,
      details TEXT,
      ip_address TEXT,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // Indices for audit_log table
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
  `);
}

export function down(db: Database.Database): void {
  // Drop tables in reverse order (respecting foreign keys)
  db.exec(`DROP TABLE IF EXISTS audit_log`);
  db.exec(`DROP TABLE IF EXISTS sessions`);
  db.exec(`DROP TABLE IF EXISTS permissions`);
  db.exec(`DROP TABLE IF EXISTS users`);
}

export const migration = {
  version: 1,
  name: 'add_auth_tables',
  up,
  down
};
