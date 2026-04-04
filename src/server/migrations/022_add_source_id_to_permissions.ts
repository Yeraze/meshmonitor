/**
 * Migration 022: Add sourceId column to permissions table (Phase 3)
 *
 * Adds a nullable TEXT `sourceId` to `permissions` so permissions can be
 * scoped to a specific source. NULL = global (applies to all sources).
 *
 * Check logic (implemented in repository): source-specific permission first,
 * fall back to global (NULL sourceId).
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 022 (SQLite): Adding sourceId to permissions...');

    try {
      db.exec(`ALTER TABLE permissions ADD COLUMN sourceId TEXT`);
      logger.debug('Added sourceId to permissions');
    } catch (e: any) {
      if (e.message?.includes('duplicate column')) {
        logger.debug('permissions.sourceId already exists, skipping');
      } else {
        logger.warn('Could not add sourceId to permissions:', e.message);
      }
    }

    db.exec(`CREATE INDEX IF NOT EXISTS idx_permissions_source_id ON permissions(sourceId)`);
    logger.info('Migration 022 complete (SQLite)');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 022 down: Not implemented');
  },
};

// ============ PostgreSQL ============

export async function runMigration022Postgres(client: any): Promise<void> {
  logger.info('Running migration 022 (PostgreSQL): Adding sourceId to permissions...');

  await client.query(
    `ALTER TABLE permissions ADD COLUMN IF NOT EXISTS "sourceId" TEXT`
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_permissions_source_id ON permissions("sourceId")`
  );

  logger.info('Migration 022 complete (PostgreSQL)');
}

// ============ MySQL ============

export async function runMigration022Mysql(pool: any): Promise<void> {
  logger.info('Running migration 022 (MySQL): Adding sourceId to permissions...');

  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'permissions' AND COLUMN_NAME = 'sourceId'`
    );
    if (!Array.isArray(rows) || rows.length === 0) {
      // Use VARCHAR(36) — UUIDs are 36 chars and MySQL cannot index TEXT columns
      await conn.query(`ALTER TABLE permissions ADD COLUMN sourceId VARCHAR(36)`);
      logger.debug('Added sourceId to permissions');
    } else {
      logger.debug('permissions.sourceId already exists, skipping');
    }

    const [idxRows] = await conn.query(
      `SELECT COUNT(*) as cnt FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'permissions' AND INDEX_NAME = 'idx_permissions_source_id'`
    );
    if (!(idxRows as any)[0]?.cnt) {
      await conn.query(`CREATE INDEX idx_permissions_source_id ON permissions(sourceId)`);
    }
  } finally {
    conn.release();
  }

  logger.info('Migration 022 complete (MySQL)');
}
