/**
 * Migration 052: Add sourceId column to embed_profiles
 *
 * Adds a nullable `sourceId` column so each embed profile can be scoped to a
 * specific source. NULL = "all sources" (preserves the pre-migration
 * behaviour where embed routes returned data unfiltered across sources).
 *
 * Idempotent across SQLite/PostgreSQL/MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 052 (SQLite): Adding sourceId to embed_profiles...');

    try {
      db.exec(`ALTER TABLE embed_profiles ADD COLUMN sourceId TEXT`);
      logger.debug('Added sourceId to embed_profiles');
    } catch (e: any) {
      if (e.message?.includes('duplicate column')) {
        logger.debug('embed_profiles.sourceId already exists, skipping');
      } else {
        logger.warn('Could not add sourceId to embed_profiles:', e.message);
      }
    }

    db.exec(`CREATE INDEX IF NOT EXISTS idx_embed_profiles_source_id ON embed_profiles(sourceId)`);
    logger.info('Migration 052 complete (SQLite)');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 052 down: Not implemented');
  },
};

// ============ PostgreSQL ============

export async function runMigration052Postgres(client: any): Promise<void> {
  logger.info('Running migration 052 (PostgreSQL): Adding sourceId to embed_profiles...');

  await client.query(
    `ALTER TABLE embed_profiles ADD COLUMN IF NOT EXISTS "sourceId" TEXT`
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_embed_profiles_source_id ON embed_profiles("sourceId")`
  );

  logger.info('Migration 052 complete (PostgreSQL)');
}

// ============ MySQL ============

export async function runMigration052Mysql(pool: any): Promise<void> {
  logger.info('Running migration 052 (MySQL): Adding sourceId to embed_profiles...');

  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'embed_profiles' AND COLUMN_NAME = 'sourceId'`
    );
    if (!Array.isArray(rows) || rows.length === 0) {
      await conn.query(`ALTER TABLE embed_profiles ADD COLUMN sourceId VARCHAR(36)`);
      logger.debug('Added sourceId to embed_profiles');
    } else {
      logger.debug('embed_profiles.sourceId already exists, skipping');
    }

    const [idxRows] = await conn.query(
      `SELECT COUNT(*) as cnt FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'embed_profiles' AND INDEX_NAME = 'idx_embed_profiles_source_id'`
    );
    if (!(idxRows as any)[0]?.cnt) {
      await conn.query(`CREATE INDEX idx_embed_profiles_source_id ON embed_profiles(sourceId)`);
    }
  } finally {
    conn.release();
  }

  logger.info('Migration 052 complete (MySQL)');
}
