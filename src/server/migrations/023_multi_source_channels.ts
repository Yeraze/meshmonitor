/**
 * Migration 023: Multi-source channels table rebuild
 *
 * Changes channels table from single `id INTEGER PRIMARY KEY` to a surrogate
 * `pk` primary key with a UNIQUE constraint on `(sourceId, id)`.
 *
 * This allows each source to have its own independent set of channel slots
 * (0-7) without overwriting each other's data.
 *
 * Data is preserved: existing rows keep their id and sourceId values.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 023 (SQLite): Rebuilding channels table for multi-source...');

    // Idempotent check: if pk column already exists, skip
    const cols = db.prepare(`PRAGMA table_info(channels)`).all() as any[];
    if (cols.some((c: any) => c.name === 'pk')) {
      logger.info('Migration 023 (SQLite): channels.pk already exists, skipping');
      return;
    }

    // SQLite does not support DROP PRIMARY KEY or ADD CONSTRAINT on existing tables.
    // The only safe way is: create new table → copy data → drop old → rename.
    db.exec(`
      CREATE TABLE IF NOT EXISTS channels_new (
        pk         INTEGER PRIMARY KEY AUTOINCREMENT,
        id         INTEGER NOT NULL,
        name       TEXT NOT NULL,
        psk        TEXT,
        role       INTEGER,
        uplinkEnabled    INTEGER NOT NULL DEFAULT 1,
        downlinkEnabled  INTEGER NOT NULL DEFAULT 1,
        positionPrecision INTEGER,
        createdAt  INTEGER NOT NULL,
        updatedAt  INTEGER NOT NULL,
        sourceId   TEXT,
        UNIQUE(sourceId, id)
      )
    `);

    // Copy all existing rows (sourceId may be NULL — UNIQUE constraint in SQLite
    // treats each NULL as distinct, so legacy rows survive the copy).
    db.exec(`
      INSERT INTO channels_new (id, name, psk, role, uplinkEnabled, downlinkEnabled,
                                positionPrecision, createdAt, updatedAt, sourceId)
      SELECT id, name, psk, role, uplinkEnabled, downlinkEnabled,
             positionPrecision, createdAt, updatedAt, sourceId
      FROM channels
    `);

    db.exec(`DROP TABLE channels`);
    db.exec(`ALTER TABLE channels_new RENAME TO channels`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_channels_source_id ON channels(sourceId)`);

    logger.info('Migration 023 complete (SQLite)');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 023 down: Not implemented (destructive schema reversal)');
  },
};

// ============ PostgreSQL ============

export async function runMigration023Postgres(client: any): Promise<void> {
  logger.info('Running migration 023 (PostgreSQL): Rebuilding channels table for multi-source...');

  // Idempotent check: if pk column already exists, skip
  const colCheck = await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'channels' AND column_name = 'pk'
  `);
  if (colCheck.rows.length > 0) {
    logger.info('Migration 023 (PostgreSQL): channels.pk already exists, skipping');
    return;
  }

  // Drop existing primary key on id
  await client.query(`
    ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_pkey
  `);

  // Add surrogate serial pk
  await client.query(`
    ALTER TABLE channels ADD COLUMN pk SERIAL PRIMARY KEY
  `);

  // Add unique constraint on (sourceId, id)
  await client.query(`
    ALTER TABLE channels
      ADD CONSTRAINT channels_source_id_uniq UNIQUE ("sourceId", id)
  `);

  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_channels_source_id ON channels("sourceId")`
  );

  logger.info('Migration 023 complete (PostgreSQL)');
}

// ============ MySQL ============

export async function runMigration023Mysql(pool: any): Promise<void> {
  logger.info('Running migration 023 (MySQL): Rebuilding channels table for multi-source...');

  const conn = await pool.getConnection();
  try {
    // Idempotent check
    const [pkRows] = await conn.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'channels' AND COLUMN_NAME = 'pk'`
    );
    if (Array.isArray(pkRows) && pkRows.length > 0) {
      logger.info('Migration 023 (MySQL): channels.pk already exists, skipping');
      return;
    }

    // Drop existing PK (MySQL requires the PK to be named 'PRIMARY')
    await conn.query(`ALTER TABLE channels DROP PRIMARY KEY`);

    // Add surrogate auto-increment pk as new PK
    await conn.query(`
      ALTER TABLE channels ADD COLUMN pk INT AUTO_INCREMENT PRIMARY KEY FIRST
    `);

    // Add unique constraint on (sourceId, id)
    await conn.query(`
      ALTER TABLE channels ADD UNIQUE KEY channels_source_id_uniq (sourceId, id)
    `);

    await conn.query(
      `CREATE INDEX idx_channels_source_id ON channels(sourceId)`
    ).catch(() => {
      logger.debug('idx_channels_source_id already exists');
    });
  } finally {
    conn.release();
  }

  logger.info('Migration 023 complete (MySQL)');
}
