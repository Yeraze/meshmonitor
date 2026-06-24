/**
 * Migration 102: MeshCore channel "heard repeaters" side table (#3700).
 *
 * Creates one per-source table:
 *   - meshcore_heard_repeaters: one row per (outgoing channel message, repeater
 *     relay-hash) inferred by self-echo correlation. When a nearby repeater
 *     re-floods our own GRP_TXT channel packet, our device hears the re-flood as
 *     an inbound OTA packet whose relay-hash chain names the relaying repeaters;
 *     we attribute those hashes to the most recent matching outgoing channel
 *     send within a short window. Best-effort by design.
 *
 * PER-SOURCE (`sourceId`). Unique on (sourceId, messageId, repeaterHash) so
 * repeated echoes of the same packet by the same repeater dedup; SNR is updated
 * to the max observed.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 102';
const TABLE = 'meshcore_heard_repeaters';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TABLE}...`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sourceId TEXT NOT NULL,
        messageId TEXT NOT NULL,
        repeaterHash TEXT NOT NULL,
        repeaterName TEXT,
        snr INTEGER,
        heardAt INTEGER NOT NULL,
        createdAt INTEGER NOT NULL
      )
    `);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS mchr_source_msg_hash_uniq ON ${TABLE}(sourceId, messageId, repeaterHash)`);
    db.exec(`CREATE INDEX IF NOT EXISTS mchr_source_msg_idx ON ${TABLE}(sourceId, messageId)`);

    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (db: Database): void => {
    logger.info(`${LABEL} down (SQLite): dropping ${TABLE}`);
    db.exec(`DROP TABLE IF EXISTS ${TABLE}`);
  },
};

// ============ PostgreSQL ============

export async function runMigration102Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TABLE}...`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id SERIAL PRIMARY KEY,
      "sourceId" TEXT NOT NULL,
      "messageId" TEXT NOT NULL,
      "repeaterHash" TEXT NOT NULL,
      "repeaterName" TEXT,
      snr INTEGER,
      "heardAt" BIGINT NOT NULL,
      "createdAt" BIGINT NOT NULL
    )
  `);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS mchr_source_msg_hash_uniq ON ${TABLE}("sourceId", "messageId", "repeaterHash")`);
  await client.query(`CREATE INDEX IF NOT EXISTS mchr_source_msg_idx ON ${TABLE}("sourceId", "messageId")`);

  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration102Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
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
          sourceId VARCHAR(64) NOT NULL,
          messageId VARCHAR(64) NOT NULL,
          repeaterHash VARCHAR(16) NOT NULL,
          repeaterName VARCHAR(128),
          snr INT,
          heardAt BIGINT NOT NULL,
          createdAt BIGINT NOT NULL,
          UNIQUE KEY mchr_source_msg_hash_uniq (sourceId, messageId, repeaterHash),
          KEY mchr_source_msg_idx (sourceId, messageId)
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
