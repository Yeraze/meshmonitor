/**
 * Migration 108: MeshCore saved-regions catalog (#3770).
 *
 * Creates `meshcore_saved_regions`: a GLOBAL (no sourceId) user-maintained list
 * of MeshCore region names. A "scope" is a transport code derived purely from a
 * region name (sha256("#region")[:16]), so the catalog is not source-scoped —
 * it mirrors the global-by-design `channel_database` / `automations` tables.
 *
 * `name` is normalized (lowercase, no leading '#', letters/digits/hyphen) and
 * UNIQUE so the list is de-duplicated.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 108';
const TABLE = 'meshcore_saved_regions';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TABLE}...`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        note TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS meshcore_saved_regions_name_idx ON ${TABLE}(name)`);

    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (db: Database): void => {
    logger.info(`${LABEL} down (SQLite): dropping ${TABLE}`);
    db.exec(`DROP TABLE IF EXISTS ${TABLE}`);
  },
};

// ============ PostgreSQL ============

export async function runMigration108Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TABLE}...`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      note TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS meshcore_saved_regions_name_idx ON ${TABLE}(name)`);

  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration108Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${TABLE}...`);

  const conn = await pool.getConnection();
  try {
    const [exists] = await conn.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [TABLE],
    );
    if ((exists as any[]).length === 0) {
      await conn.query(`
        CREATE TABLE ${TABLE} (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(64) NOT NULL,
          note VARCHAR(255),
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL,
          UNIQUE KEY meshcore_saved_regions_name_idx (name)
        )
      `);
    } else {
      logger.debug(`${TABLE} already exists, skipping create`);
    }
  } finally {
    conn.release();
  }

  logger.info(`${LABEL} complete (MySQL)`);
}
