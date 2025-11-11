/**
 * Migration 023: Add password_locked flag to users table
 *
 * Adds a password_locked column to the users table to allow administrators
 * to prevent password changes for specific accounts. This is useful for
 * shared/anonymous accounts where password changes should be restricted.
 *
 * This enables:
 * - Preventing password changes for shared accounts
 * - Administrator control over which accounts can modify passwords
 * - Protection against accidental password changes on shared logins
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database): void => {
    logger.debug('Running migration 023: Add password_locked flag to users table');

    try {
      // STEP 0: Disable foreign key constraints during migration
      db.exec('PRAGMA foreign_keys = OFF');

      // STEP 1: Create new users table with password_locked column
      db.exec(`
        CREATE TABLE users_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT,
          email TEXT,
          display_name TEXT,
          auth_provider TEXT NOT NULL DEFAULT 'local',
          oidc_subject TEXT UNIQUE,
          is_admin INTEGER NOT NULL DEFAULT 0,
          is_active INTEGER NOT NULL DEFAULT 1,
          password_locked INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          last_login_at INTEGER,
          created_by INTEGER,
          FOREIGN KEY (created_by) REFERENCES users_new(id),
          CHECK (auth_provider IN ('local', 'oidc')),
          CHECK (is_admin IN (0, 1)),
          CHECK (is_active IN (0, 1)),
          CHECK (password_locked IN (0, 1)),
          CHECK (
            (auth_provider = 'local' AND password_hash IS NOT NULL) OR
            (auth_provider = 'oidc' AND oidc_subject IS NOT NULL)
          )
        )
      `);
      logger.debug('✅ Created users_new table with password_locked column');

      // STEP 2: Copy data from old table to new table
      db.exec(`
        INSERT INTO users_new (
          id, username, password_hash, email, display_name,
          auth_provider, oidc_subject, is_admin, is_active,
          password_locked, created_at, last_login_at, created_by
        )
        SELECT
          id, username, password_hash, email, display_name,
          auth_provider, oidc_subject, is_admin, is_active,
          0, created_at, last_login_at, created_by
        FROM users
      `);
      logger.debug('✅ Copied users data (password_locked defaults to 0)');

      // STEP 3: Drop old table and rename new table
      db.exec(`DROP TABLE users`);
      db.exec(`ALTER TABLE users_new RENAME TO users`);
      logger.debug('✅ Replaced users table');

      // STEP 4: Recreate indices
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
        CREATE INDEX IF NOT EXISTS idx_users_oidc_subject ON users(oidc_subject);
        CREATE INDEX IF NOT EXISTS idx_users_auth_provider ON users(auth_provider);
        CREATE INDEX IF NOT EXISTS idx_users_is_active ON users(is_active);
        CREATE INDEX IF NOT EXISTS idx_users_password_locked ON users(password_locked);
      `);
      logger.debug('✅ Recreated users indices with password_locked index');

      // STEP 5: Re-enable foreign key constraints
      db.exec('PRAGMA foreign_keys = ON');
      logger.debug('✅ Re-enabled foreign key constraints');

      logger.debug('✅ Migration 023 completed successfully');
      logger.debug('ℹ️  All existing users have password_locked = 0 (unlocked)');
    } catch (error: any) {
      // Re-enable foreign keys even on error
      try {
        db.exec('PRAGMA foreign_keys = ON');
      } catch {}
      logger.error('❌ Migration 023 failed:', error);
      throw error;
    }
  },

  down: (db: Database): void => {
    logger.debug('Reverting migration 023: Remove password_locked flag from users table');

    try {
      // STEP 1: Create users table without password_locked column
      db.exec(`
        CREATE TABLE users_new (
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
          FOREIGN KEY (created_by) REFERENCES users_new(id),
          CHECK (auth_provider IN ('local', 'oidc')),
          CHECK (is_admin IN (0, 1)),
          CHECK (is_active IN (0, 1)),
          CHECK (
            (auth_provider = 'local' AND password_hash IS NOT NULL) OR
            (auth_provider = 'oidc' AND oidc_subject IS NOT NULL)
          )
        )
      `);

      // STEP 2: Copy data back (excluding password_locked column)
      db.exec(`
        INSERT INTO users_new (
          id, username, password_hash, email, display_name,
          auth_provider, oidc_subject, is_admin, is_active,
          created_at, last_login_at, created_by
        )
        SELECT
          id, username, password_hash, email, display_name,
          auth_provider, oidc_subject, is_admin, is_active,
          created_at, last_login_at, created_by
        FROM users
      `);

      // STEP 3: Drop old table and rename new table
      db.exec(`DROP TABLE users`);
      db.exec(`ALTER TABLE users_new RENAME TO users`);

      // STEP 4: Recreate indices (without password_locked index)
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
        CREATE INDEX IF NOT EXISTS idx_users_oidc_subject ON users(oidc_subject);
        CREATE INDEX IF NOT EXISTS idx_users_auth_provider ON users(auth_provider);
        CREATE INDEX IF NOT EXISTS idx_users_is_active ON users(is_active);
      `);

      logger.debug('✅ Migration 023 reverted');
    } catch (error) {
      logger.error('❌ Migration 023 rollback failed:', error);
      throw error;
    }
  }
};
