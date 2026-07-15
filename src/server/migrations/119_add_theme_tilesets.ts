/**
 * Migration 119: Add per-theme map tileset preferences (#4096).
 *
 * Users who never moved away from the legacy OSM default receive the new
 * light/dark defaults. Any non-default legacy selection, including a custom
 * tileset ID, is preserved for both themes.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const TABLE = 'user_map_preferences';
const LIGHT_COLUMN = 'map_tileset_light';
const DARK_COLUMN = 'map_tileset_dark';

const backfillSql = `
  UPDATE ${TABLE}
  SET ${LIGHT_COLUMN} = COALESCE(
        ${LIGHT_COLUMN},
        CASE WHEN map_tileset IS NULL OR map_tileset = 'osm' THEN 'osm' ELSE map_tileset END
      ),
      ${DARK_COLUMN} = COALESCE(
        ${DARK_COLUMN},
        CASE WHEN map_tileset IS NULL OR map_tileset = 'osm' THEN 'cartoDark' ELSE map_tileset END
      )
`;

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 119 (SQLite): adding per-theme map tilesets...');

    for (const column of [LIGHT_COLUMN, DARK_COLUMN]) {
      try {
        db.exec(`ALTER TABLE ${TABLE} ADD COLUMN ${column} TEXT`);
      } catch (error: unknown) {
        if (!(error instanceof Error) || !error.message.includes('duplicate column')) throw error;
      }
    }

    db.exec(backfillSql);
    logger.info('Migration 119 complete (SQLite): per-theme map tilesets added');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 119 down: not implemented (column drops are destructive)');
  },
};

export async function runMigration119Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info('Running migration 119 (PostgreSQL): adding per-theme map tilesets...');
  await client.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS ${LIGHT_COLUMN} TEXT`);
  await client.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS ${DARK_COLUMN} TEXT`);
  await client.query(backfillSql);
  logger.info('Migration 119 complete (PostgreSQL): per-theme map tilesets added');
}

export async function runMigration119Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info('Running migration 119 (MySQL): adding per-theme map tilesets...');

  for (const column of [LIGHT_COLUMN, DARK_COLUMN]) {
    const [rows] = await pool.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [TABLE, column],
    );
    if (!Array.isArray(rows) || rows.length === 0) {
      await pool.query(`ALTER TABLE ${TABLE} ADD COLUMN ${column} VARCHAR(255)`);
    }
  }

  await pool.query(backfillSql);
  logger.info('Migration 119 complete (MySQL): per-theme map tilesets added');
}
