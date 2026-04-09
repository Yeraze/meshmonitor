/**
 * Migration 026: Add sourceId to auto_distance_delete_log
 *
 * Phase 2d of the multi-source automation refactor. Makes the
 * auto-delete-by-distance log per-source so each source's manual
 * "Run Now" results are scoped independently.
 *
 * auto_distance_delete_log:
 *   - add nullable sourceId column (no unique constraint changes; log table)
 *
 * NULL sourceId = legacy/unscoped rows. Idempotent for all three backends.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 026 (SQLite): Adding sourceId to auto_distance_delete_log...');

    try {
      db.exec(`ALTER TABLE auto_distance_delete_log ADD COLUMN sourceId TEXT`);
      logger.debug('Added sourceId column to auto_distance_delete_log');
    } catch (e: any) {
      if (/duplicate column/i.test(e.message)) {
        logger.debug('auto_distance_delete_log.sourceId already exists, skipping');
      } else {
        throw e;
      }
    }

    try {
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_auto_distance_delete_log_source_id ON auto_distance_delete_log(sourceId)`
      );
    } catch (e: any) {
      logger.debug(`Could not create auto_distance_delete_log sourceId index: ${e.message}`);
    }

    logger.info('Migration 026 complete (SQLite)');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 026 down: Not implemented (column drops are destructive)');
  },
};

// ============ PostgreSQL ============

export async function runMigration026Postgres(client: any): Promise<void> {
  logger.info('Running migration 026 (PostgreSQL): Adding sourceId to auto_distance_delete_log...');

  await client.query(
    `ALTER TABLE auto_distance_delete_log ADD COLUMN IF NOT EXISTS "sourceId" TEXT`
  );

  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_auto_distance_delete_log_source_id ON auto_distance_delete_log("sourceId")`
  );

  logger.info('Migration 026 complete (PostgreSQL)');
}

// ============ MySQL ============

export async function runMigration026Mysql(pool: any): Promise<void> {
  logger.info('Running migration 026 (MySQL): Adding sourceId to auto_distance_delete_log...');

  const conn = await pool.getConnection();
  try {
    const [colRows] = await conn.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auto_distance_delete_log' AND COLUMN_NAME = 'sourceId'`
    );
    if (!Array.isArray(colRows) || colRows.length === 0) {
      await conn.query(`ALTER TABLE auto_distance_delete_log ADD COLUMN sourceId VARCHAR(64)`);
      logger.debug('Added sourceId to auto_distance_delete_log');
    }

    const [idxRows] = await conn.query(
      `SELECT COUNT(*) as cnt FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
      ['auto_distance_delete_log', 'idx_auto_distance_delete_log_source_id']
    );
    if (!(idxRows as any)[0]?.cnt) {
      await conn.query(
        `CREATE INDEX idx_auto_distance_delete_log_source_id ON auto_distance_delete_log(sourceId)`
      );
      logger.debug('Created index idx_auto_distance_delete_log_source_id');
    }
  } finally {
    conn.release();
  }

  logger.info('Migration 026 complete (MySQL)');
}
