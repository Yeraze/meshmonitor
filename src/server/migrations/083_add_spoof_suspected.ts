/**
 * Migration 083: Add spoof/impersonation flags (issue #2584)
 *
 * Adds a boolean flag to two tables, marking packets/messages that claim to
 * originate from this source's locally-connected node but arrived over the air
 * (RF reception metadata / travelled hops) and were not recently sent by us —
 * i.e. a likely impersonation of our local node.
 *
 *   messages.spoofSuspected     (camelCase, matches the messages table style)
 *   packet_log.spoof_suspected  (snake_case, matches the packet_log table style)
 *
 * Both default to false/0; existing rows are treated as not-suspected. The
 * detection logic lives in src/server/utils/spoofDetection.ts.
 *
 * Implements: https://github.com/Yeraze/meshmonitor/issues/2584
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 083 (SQLite): Adding spoof-suspected flags...');

    const addColumn = (table: string, ddl: string) => {
      try {
        db.exec(ddl);
        logger.debug(`Added spoof flag to ${table}`);
      } catch (e: any) {
        if (e.message?.includes('duplicate column')) {
          logger.debug(`${table} spoof flag already exists, skipping`);
        } else {
          logger.warn(`Could not add spoof flag to ${table}:`, e.message);
        }
      }
    };

    addColumn('messages', 'ALTER TABLE messages ADD COLUMN spoofSuspected INTEGER DEFAULT 0');
    addColumn('packet_log', 'ALTER TABLE packet_log ADD COLUMN spoof_suspected INTEGER DEFAULT 0');

    logger.info('Migration 083 complete (SQLite): spoof-suspected flags added');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 083 down: Not implemented (destructive column drops)');
  }
};

// ============ PostgreSQL ============

export async function runMigration083Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info('Running migration 083 (PostgreSQL): Adding spoof-suspected flags...');

  try {
    await client.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS "spoofSuspected" BOOLEAN DEFAULT FALSE');
    await client.query('ALTER TABLE packet_log ADD COLUMN IF NOT EXISTS spoof_suspected BOOLEAN DEFAULT FALSE');
    logger.debug('Ensured spoof-suspected flags exist on messages and packet_log');
  } catch (error: any) {
    logger.error('Migration 083 (PostgreSQL) failed:', error.message);
    throw error;
  }

  logger.info('Migration 083 complete (PostgreSQL): spoof-suspected flags added');
}

// ============ MySQL ============

export async function runMigration083Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info('Running migration 083 (MySQL): Adding spoof-suspected flags...');

  const ensureColumn = async (table: string, column: string, ddl: string) => {
    const [rows] = await pool.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column]
    );
    if (!Array.isArray(rows) || rows.length === 0) {
      await pool.query(ddl);
      logger.debug(`Added ${column} to ${table}`);
    } else {
      logger.debug(`${table}.${column} already exists, skipping`);
    }
  };

  try {
    await ensureColumn('messages', 'spoofSuspected', 'ALTER TABLE messages ADD COLUMN spoofSuspected BOOLEAN DEFAULT FALSE');
    await ensureColumn('packet_log', 'spoof_suspected', 'ALTER TABLE packet_log ADD COLUMN spoof_suspected BOOLEAN DEFAULT FALSE');
  } catch (error: any) {
    logger.error('Migration 083 (MySQL) failed:', error.message);
    throw error;
  }

  logger.info('Migration 083 complete (MySQL): spoof-suspected flags added');
}
