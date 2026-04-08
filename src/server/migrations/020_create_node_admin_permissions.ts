/**
 * Migration 020: Create node_admin_permissions table
 *
 * Allows admins to grant non-admin users remote admin access to specific
 * mesh nodes. Each row links a userId to a nodeNum, enabling delegated
 * node management without full admin privileges. Local node operations
 * remain admin-only for security.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 020 (SQLite): Creating node_admin_permissions table...');

    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS node_admin_permissions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          node_num INTEGER NOT NULL,
          granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          granted_at INTEGER NOT NULL,
          UNIQUE(user_id, node_num)
        )
      `);
      logger.debug('Created node_admin_permissions table');
    } catch (e: any) {
      if (e.message?.includes('already exists')) {
        logger.debug('node_admin_permissions table already exists, skipping');
      } else {
        logger.warn('Could not create node_admin_permissions:', e.message);
      }
    }

    logger.info('Migration 020 complete (SQLite): node_admin_permissions created');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 020 down: Not implemented (destructive table drops)');
  }
};

// ============ PostgreSQL ============

export async function runMigration020Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info('Running migration 020 (PostgreSQL): Creating node_admin_permissions table...');

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS node_admin_permissions (
        id SERIAL PRIMARY KEY,
        "userId" INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "nodeNum" BIGINT NOT NULL,
        "grantedBy" INTEGER REFERENCES users(id) ON DELETE SET NULL,
        "grantedAt" BIGINT NOT NULL,
        UNIQUE("userId", "nodeNum")
      )
    `);
    logger.debug('Ensured node_admin_permissions table exists');
  } catch (error: any) {
    logger.error('Migration 020 (PostgreSQL) failed:', error.message);
    throw error;
  }

  logger.info('Migration 020 complete (PostgreSQL): node_admin_permissions created');
}

// ============ MySQL ============

export async function runMigration020Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info('Running migration 020 (MySQL): Creating node_admin_permissions table...');

  try {
    const [rows] = await pool.query(`
      SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'node_admin_permissions'
    `);
    if (!Array.isArray(rows) || rows.length === 0) {
      await pool.query(`
        CREATE TABLE node_admin_permissions (
          id SERIAL PRIMARY KEY,
          userId INT NOT NULL,
          nodeNum BIGINT NOT NULL,
          grantedBy INT,
          grantedAt BIGINT NOT NULL,
          UNIQUE(userId, nodeNum),
          FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (grantedBy) REFERENCES users(id) ON DELETE SET NULL
        )
      `);
      logger.debug('Created node_admin_permissions table');
    } else {
      logger.debug('node_admin_permissions table already exists, skipping');
    }
  } catch (error: any) {
    logger.error('Migration 020 (MySQL) failed:', error.message);
    throw error;
  }

  logger.info('Migration 020 complete (MySQL): node_admin_permissions created');
}
