/**
 * Migration 016: Rename legacy system_backup_history columns
 *
 * Pre-3.7 databases created system_backup_history with columns:
 *   dirname, type, size, table_count, meshmonitor_version, schema_version
 *
 * The v3.7 baseline uses CREATE TABLE IF NOT EXISTS with new names, which
 * doesn't alter an existing table. This migration renames the old columns:
 *   dirname → backupPath
 *   type → backupType
 *   size → totalSize
 *   table_count → tableCount
 *   meshmonitor_version → appVersion
 *   schema_version → schemaVersion
 *
 * Also adds the rowCount column if missing.
 *
 * Fixes: https://github.com/Yeraze/meshmonitor/issues/2419
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

// Column rename mapping: old → new
const COLUMN_RENAMES: [string, string][] = [
  ['dirname', 'backupPath'],
  ['type', 'backupType'],
  ['size', 'totalSize'],
  ['table_count', 'tableCount'],
  ['meshmonitor_version', 'appVersion'],
  ['schema_version', 'schemaVersion'],
];

// ============ SQLite ============

function sqliteColumnExists(db: Database, table: string, column: string): boolean {
  const rows = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return rows.some(r => r.name === column);
}

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 016 (SQLite): Renaming legacy system_backup_history columns...');

    for (const [oldName, newName] of COLUMN_RENAMES) {
      if (sqliteColumnExists(db, 'system_backup_history', oldName)) {
        try {
          db.exec(`ALTER TABLE system_backup_history RENAME COLUMN ${oldName} TO ${newName}`);
          logger.debug(`Renamed system_backup_history.${oldName} → ${newName}`);
        } catch (e: any) {
          logger.warn(`Could not rename ${oldName} → ${newName}:`, e.message);
        }
      } else {
        logger.debug(`system_backup_history.${oldName} does not exist (already renamed or new install), skipping`);
      }
    }

    // Add rowCount if missing
    if (!sqliteColumnExists(db, 'system_backup_history', 'rowCount')) {
      try {
        db.exec('ALTER TABLE system_backup_history ADD COLUMN rowCount INTEGER');
        logger.debug('Added rowCount column to system_backup_history');
      } catch (e: any) {
        if (e.message?.includes('duplicate column')) {
          logger.debug('system_backup_history.rowCount already exists, skipping');
        } else {
          logger.warn('Could not add rowCount to system_backup_history:', e.message);
        }
      }
    }

    logger.info('Migration 016 complete (SQLite): system_backup_history columns aligned');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 016 down: Not implemented (destructive column renames)');
  }
};

// ============ PostgreSQL ============

export async function runMigration016Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info('Running migration 016 (PostgreSQL): Renaming legacy system_backup_history columns...');

  try {
    for (const [oldName, newName] of COLUMN_RENAMES) {
      const res = await client.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'system_backup_history' AND column_name = $1
      `, [oldName]);

      if (res.rows.length > 0) {
        await client.query(`ALTER TABLE system_backup_history RENAME COLUMN "${oldName}" TO "${newName}"`);
        logger.debug(`Renamed system_backup_history.${oldName} → ${newName}`);
      } else {
        logger.debug(`system_backup_history.${oldName} does not exist, skipping`);
      }
    }

    // Add rowCount if missing
    await client.query('ALTER TABLE system_backup_history ADD COLUMN IF NOT EXISTS "rowCount" INTEGER');
    logger.debug('Ensured rowCount exists on system_backup_history');
  } catch (error: any) {
    logger.error('Migration 016 (PostgreSQL) failed:', error.message);
    throw error;
  }

  logger.info('Migration 016 complete (PostgreSQL): system_backup_history columns aligned');
}

// ============ MySQL ============

export async function runMigration016Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info('Running migration 016 (MySQL): Renaming legacy system_backup_history columns...');

  try {
    for (const [oldName, newName] of COLUMN_RENAMES) {
      const [rows] = await pool.query(`
        SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'system_backup_history'
          AND COLUMN_NAME = ?
      `, [oldName]);

      if (Array.isArray(rows) && rows.length > 0) {
        await pool.query(`ALTER TABLE system_backup_history RENAME COLUMN ${oldName} TO ${newName}`);
        logger.debug(`Renamed system_backup_history.${oldName} → ${newName}`);
      } else {
        logger.debug(`system_backup_history.${oldName} does not exist, skipping`);
      }
    }

    // Add rowCount if missing
    const [rcRows] = await pool.query(`
      SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'system_backup_history'
        AND COLUMN_NAME = 'rowCount'
    `);
    if (!Array.isArray(rcRows) || rcRows.length === 0) {
      await pool.query('ALTER TABLE system_backup_history ADD COLUMN rowCount INTEGER');
      logger.debug('Added rowCount to system_backup_history');
    } else {
      logger.debug('system_backup_history.rowCount already exists, skipping');
    }
  } catch (error: any) {
    logger.error('Migration 016 (MySQL) failed:', error.message);
    throw error;
  }

  logger.info('Migration 016 complete (MySQL): system_backup_history columns aligned');
}
