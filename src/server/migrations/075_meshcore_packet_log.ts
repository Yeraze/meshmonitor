/**
 * Migration 075: Create meshcore_packet_log table.
 *
 * Stores one row per OTA packet observed via the MeshCore companion
 * `LogRxData` (0x88) push, powering the MeshCore Packet Monitor. Mirrors
 * the Meshtastic `packet_log` table but tuned to the MeshCore wire format
 * (payload type, route type, relay-hash chain, SNR/RSSI). Capture is
 * opt-in via the `meshcore_packet_log_enabled` setting.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 075';
const TABLE = 'meshcore_packet_log';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TABLE}...`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sourceId TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        payloadType INTEGER NOT NULL,
        payloadTypeName TEXT,
        routeType INTEGER,
        routeTypeName TEXT,
        pathLenRaw INTEGER,
        hopCount INTEGER,
        pathHops TEXT,
        snr REAL,
        rssi INTEGER,
        payloadSize INTEGER,
        rawHex TEXT,
        createdAt INTEGER NOT NULL
      )
    `);

    db.exec(`CREATE INDEX IF NOT EXISTS idx_mcpl_source_ts ON ${TABLE}(sourceId, timestamp)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_mcpl_payload_type ON ${TABLE}(payloadType)`);

    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (db: Database): void => {
    logger.info(`${LABEL} down (SQLite): dropping ${TABLE}`);
    db.exec(`DROP TABLE IF EXISTS ${TABLE}`);
  },
};

// ============ PostgreSQL ============

export async function runMigration075Postgres(client: any): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TABLE}...`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      "sourceId" TEXT NOT NULL,
      "timestamp" BIGINT NOT NULL,
      "payloadType" INTEGER NOT NULL,
      "payloadTypeName" TEXT,
      "routeType" INTEGER,
      "routeTypeName" TEXT,
      "pathLenRaw" INTEGER,
      "hopCount" INTEGER,
      "pathHops" TEXT,
      snr REAL,
      rssi INTEGER,
      "payloadSize" INTEGER,
      "rawHex" TEXT,
      "createdAt" BIGINT NOT NULL
    )
  `);

  await client.query(`CREATE INDEX IF NOT EXISTS idx_mcpl_source_ts ON ${TABLE}("sourceId", "timestamp")`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_mcpl_payload_type ON ${TABLE}("payloadType")`);

  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration075Mysql(pool: any): Promise<void> {
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
          timestamp BIGINT NOT NULL,
          payloadType INT NOT NULL,
          payloadTypeName VARCHAR(32),
          routeType INT,
          routeTypeName VARCHAR(32),
          pathLenRaw INT,
          hopCount INT,
          pathHops VARCHAR(512),
          snr DOUBLE,
          rssi INT,
          payloadSize INT,
          rawHex TEXT,
          createdAt BIGINT NOT NULL,
          INDEX idx_mcpl_source_ts (sourceId, timestamp),
          INDEX idx_mcpl_payload_type (payloadType)
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
