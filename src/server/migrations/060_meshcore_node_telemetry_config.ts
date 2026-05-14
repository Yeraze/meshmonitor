/**
 * Migration 060: Per-node telemetry-retrieval config on `meshcore_nodes`.
 *
 * Adds three nullable columns the new MeshCore remote-telemetry
 * scheduler reads on each tick:
 *
 *   telemetryEnabled         BOOLEAN  (false by default)
 *   telemetryIntervalMinutes INTEGER  (60 default; 0 disables this row)
 *   lastTelemetryRequestAt   BIGINT   (ms; null until first attempt)
 *
 * Backfill is unnecessary — the absence of `telemetryEnabled=true`
 * means the scheduler will never pick the row. Existing rows therefore
 * keep their current behaviour without explicit migration work.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 060';

interface ColumnSpec {
  name: string;
  sqliteType: string;
  postgresType: string;
  mysqlType: string;
}

const COLUMNS: ColumnSpec[] = [
  {
    name: 'telemetryEnabled',
    sqliteType: 'INTEGER DEFAULT 0',
    postgresType: 'BOOLEAN DEFAULT FALSE',
    mysqlType: 'TINYINT(1) DEFAULT 0',
  },
  {
    name: 'telemetryIntervalMinutes',
    sqliteType: 'INTEGER DEFAULT 60',
    postgresType: 'INTEGER DEFAULT 60',
    mysqlType: 'INT DEFAULT 60',
  },
  {
    name: 'lastTelemetryRequestAt',
    sqliteType: 'INTEGER',
    postgresType: 'BIGINT',
    mysqlType: 'BIGINT',
  },
];

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding per-node telemetry-retrieval columns to meshcore_nodes...`);

    for (const col of COLUMNS) {
      try {
        db.exec(`ALTER TABLE meshcore_nodes ADD COLUMN ${col.name} ${col.sqliteType}`);
        logger.debug(`${LABEL} (SQLite): added meshcore_nodes.${col.name}`);
      } catch (e: any) {
        if (e.message?.includes('duplicate column')) {
          logger.debug(`${LABEL} (SQLite): meshcore_nodes.${col.name} already exists, skipping`);
        } else {
          logger.error(`${LABEL} (SQLite): could not add meshcore_nodes.${col.name}:`, e.message);
          throw e;
        }
      }
    }
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration060Postgres(client: any): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding per-node telemetry-retrieval columns...`);

  for (const col of COLUMNS) {
    await client.query(
      `ALTER TABLE meshcore_nodes ADD COLUMN IF NOT EXISTS "${col.name}" ${col.postgresType}`,
    );
    logger.debug(`${LABEL} (PostgreSQL): ensured meshcore_nodes.${col.name}`);
  }
}

// ============ MySQL ============

export async function runMigration060Mysql(pool: any): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding per-node telemetry-retrieval columns...`);

  const conn = await pool.getConnection();
  try {
    for (const col of COLUMNS) {
      const [rows] = await conn.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'meshcore_nodes' AND COLUMN_NAME = ?`,
        [col.name],
      );
      if (!Array.isArray(rows) || rows.length === 0) {
        await conn.query(`ALTER TABLE meshcore_nodes ADD COLUMN ${col.name} ${col.mysqlType}`);
        logger.debug(`${LABEL} (MySQL): added meshcore_nodes.${col.name}`);
      } else {
        logger.debug(`${LABEL} (MySQL): meshcore_nodes.${col.name} already exists, skipping`);
      }
    }
  } finally {
    conn.release();
  }
}
