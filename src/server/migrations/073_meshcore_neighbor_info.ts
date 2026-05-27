/**
 * Migration 073: Create meshcore_neighbor_info table.
 *
 * Stores parsed neighbor data from MeshCore repeaters' CLI `neighbors`
 * command. Each row records one neighbor relationship: the reporting
 * repeater's publicKey → one neighbor's publicKey, with SNR and
 * last-heard-seconds-ago at query time.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 073';
const TABLE = 'meshcore_neighbor_info';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TABLE}...`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sourceId TEXT NOT NULL,
        publicKey TEXT NOT NULL,
        neighborPublicKey TEXT NOT NULL,
        snr REAL,
        lastHeardSecs INTEGER,
        timestamp INTEGER NOT NULL,
        createdAt INTEGER NOT NULL
      )
    `);

    db.exec(`CREATE INDEX IF NOT EXISTS idx_mcni_source_pk ON ${TABLE}(sourceId, publicKey)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_mcni_timestamp ON ${TABLE}(timestamp)`);

    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (db: Database): void => {
    logger.info(`${LABEL} down (SQLite): dropping ${TABLE}`);
    db.exec(`DROP TABLE IF EXISTS ${TABLE}`);
  },
};

// ============ PostgreSQL ============

export async function runMigration073Postgres(client: any): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TABLE}...`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      "sourceId" TEXT NOT NULL,
      "publicKey" TEXT NOT NULL,
      "neighborPublicKey" TEXT NOT NULL,
      snr REAL,
      "lastHeardSecs" INTEGER,
      "timestamp" INTEGER NOT NULL,
      "createdAt" INTEGER NOT NULL
    )
  `);

  await client.query(`CREATE INDEX IF NOT EXISTS idx_mcni_source_pk ON ${TABLE}("sourceId", "publicKey")`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_mcni_timestamp ON ${TABLE}("timestamp")`);

  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration073Mysql(pool: any): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${TABLE}...`);

  const conn = await pool.getConnection();
  try {
    const [existRows] = await conn.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [TABLE],
    );
    if ((existRows as any[]).length === 0) {
      await conn.query(`
        CREATE TABLE ${TABLE} (
          id SERIAL PRIMARY KEY,
          sourceId VARCHAR(255) NOT NULL,
          publicKey VARCHAR(64) NOT NULL,
          neighborPublicKey VARCHAR(64) NOT NULL,
          snr DOUBLE,
          lastHeardSecs INT,
          timestamp INT NOT NULL,
          createdAt INT NOT NULL,
          INDEX idx_mcni_source_pk (sourceId, publicKey),
          INDEX idx_mcni_timestamp (timestamp)
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
