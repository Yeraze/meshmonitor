/**
 * Migration 027: Add sourceId to auto_key_repair_log
 *
 * Phase 2e of the multi-source automation refactor. Makes the
 * auto-key-management key-repair log per-source so each source's
 * repair attempts are tracked independently.
 *
 * auto_key_repair_log:
 *   - add nullable sourceId column
 *
 * NULL sourceId = legacy/unscoped rows. Idempotent for all three backends.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 027 (SQLite): Adding sourceId to auto_key_repair_log...');

    // Table may not exist yet if auto-key management has never been enabled.
    const hasTable = db
      .prepare("SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name='auto_key_repair_log'")
      .get() as { count: number };
    if (hasTable.count === 0) {
      logger.debug('auto_key_repair_log table does not exist yet, skipping migration 027');
      return;
    }

    try {
      db.exec(`ALTER TABLE auto_key_repair_log ADD COLUMN sourceId TEXT`);
      logger.debug('Added sourceId column to auto_key_repair_log');
    } catch (e: any) {
      if (/duplicate column/i.test(e.message)) {
        logger.debug('auto_key_repair_log.sourceId already exists, skipping');
      } else {
        throw e;
      }
    }

    try {
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_auto_key_repair_log_source_id ON auto_key_repair_log(sourceId)`
      );
    } catch (e: any) {
      logger.debug(`Could not create auto_key_repair_log sourceId index: ${e.message}`);
    }

    logger.info('Migration 027 complete (SQLite)');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 027 down: Not implemented (column drops are destructive)');
  },
};

// ============ PostgreSQL ============

export async function runMigration027Postgres(client: any): Promise<void> {
  logger.info('Running migration 027 (PostgreSQL): Adding sourceId to auto_key_repair_log...');

  // Table may not exist yet if auto-key management has never been enabled.
  const tableCheck = await client.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'auto_key_repair_log'"
  );
  if (tableCheck.rows.length === 0) {
    logger.debug('auto_key_repair_log table does not exist yet, skipping migration 027');
    return;
  }

  await client.query(
    `ALTER TABLE auto_key_repair_log ADD COLUMN IF NOT EXISTS "sourceId" TEXT`
  );

  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_auto_key_repair_log_source_id ON auto_key_repair_log("sourceId")`
  );

  logger.info('Migration 027 complete (PostgreSQL)');
}

// ============ MySQL ============

export async function runMigration027Mysql(pool: any): Promise<void> {
  logger.info('Running migration 027 (MySQL): Adding sourceId to auto_key_repair_log...');

  const conn = await pool.getConnection();
  try {
    const [tableRows] = await conn.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auto_key_repair_log'`
    );
    if (!Array.isArray(tableRows) || tableRows.length === 0) {
      logger.debug('auto_key_repair_log table does not exist yet, skipping migration 027');
      return;
    }

    const [colRows] = await conn.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auto_key_repair_log' AND COLUMN_NAME = 'sourceId'`
    );
    if (!Array.isArray(colRows) || colRows.length === 0) {
      await conn.query(`ALTER TABLE auto_key_repair_log ADD COLUMN sourceId VARCHAR(64)`);
      logger.debug('Added sourceId to auto_key_repair_log');
    }

    const [idxRows] = await conn.query(
      `SELECT COUNT(*) as cnt FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
      ['auto_key_repair_log', 'idx_auto_key_repair_log_source_id']
    );
    if (!(idxRows as any)[0]?.cnt) {
      await conn.query(
        `CREATE INDEX idx_auto_key_repair_log_source_id ON auto_key_repair_log(sourceId)`
      );
      logger.debug('Created index idx_auto_key_repair_log_source_id');
    }
  } finally {
    conn.release();
  }

  logger.info('Migration 027 complete (MySQL)');
}
