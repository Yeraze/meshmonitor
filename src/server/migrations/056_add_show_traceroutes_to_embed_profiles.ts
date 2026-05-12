/**
 * Migration 056: Add showTraceroutes column to embed_profiles
 *
 * Embed profiles can already gate traceroute exposure indirectly via tile
 * choices, but the /api/embed/<profileId>/traceroutes endpoint always
 * returned full node-position enriched traceroute segments — leaking mesh
 * topology to anyone with a valid profileId. Adds an explicit per-profile
 * showTraceroutes flag (default false) so operators opt in rather than
 * out. The embed public route checks this flag and 404s when disabled.
 *
 * Idempotent across SQLite/PostgreSQL/MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 056 (SQLite): Adding showTraceroutes to embed_profiles...');

    try {
      db.exec(
        `ALTER TABLE embed_profiles ADD COLUMN showTraceroutes INTEGER NOT NULL DEFAULT 0`
      );
      logger.debug('Added showTraceroutes to embed_profiles');
    } catch (e: any) {
      if (e.message?.includes('duplicate column')) {
        logger.debug('embed_profiles.showTraceroutes already exists, skipping');
      } else {
        logger.warn('Could not add showTraceroutes to embed_profiles:', e.message);
      }
    }

    logger.info('Migration 056 complete (SQLite)');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 056 down: Not implemented');
  },
};

// ============ PostgreSQL ============

export async function runMigration056Postgres(client: any): Promise<void> {
  logger.info('Running migration 056 (PostgreSQL): Adding showTraceroutes to embed_profiles...');

  await client.query(
    `ALTER TABLE embed_profiles ADD COLUMN IF NOT EXISTS "showTraceroutes" BOOLEAN NOT NULL DEFAULT FALSE`
  );

  logger.info('Migration 056 complete (PostgreSQL)');
}

// ============ MySQL ============

export async function runMigration056Mysql(pool: any): Promise<void> {
  logger.info('Running migration 056 (MySQL): Adding showTraceroutes to embed_profiles...');

  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'embed_profiles' AND COLUMN_NAME = 'showTraceroutes'`
    );
    if (!Array.isArray(rows) || rows.length === 0) {
      await conn.query(
        `ALTER TABLE embed_profiles ADD COLUMN showTraceroutes BOOLEAN NOT NULL DEFAULT FALSE`
      );
      logger.debug('Added showTraceroutes to embed_profiles');
    } else {
      logger.debug('embed_profiles.showTraceroutes already exists, skipping');
    }
  } finally {
    conn.release();
  }

  logger.info('Migration 056 complete (MySQL)');
}
