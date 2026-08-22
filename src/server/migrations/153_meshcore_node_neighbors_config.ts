/**
 * Migration 153: Per-node neighbours-retrieval config on `meshcore_nodes`.
 *
 * Adds three nullable columns the new MeshCore neighbours scheduler
 * (`MeshCoreNeighboursScheduler`, issue #4618) reads on each tick — a
 * direct mirror of the migration-060 telemetry-retrieval trio, kept as a
 * SEPARATE set of columns so a neighbours poll never resets the telemetry
 * cadence (and vice versa):
 *
 *   neighborsEnabled          BOOLEAN  (false by default)
 *   neighborsIntervalMinutes  INTEGER  (60 default; 0 disables this row)
 *   lastNeighborsRequestAt    BIGINT   (ms; null until first attempt)
 *
 * Backfill is unnecessary — the absence of `neighborsEnabled=true` means
 * the scheduler will never pick the row. Existing rows therefore keep
 * their current behaviour without explicit migration work.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 153';

interface ColumnSpec {
  name: string;
  sqliteType: string;
  postgresType: string;
  mysqlType: string;
}

const COLUMNS: ColumnSpec[] = [
  {
    name: 'neighborsEnabled',
    sqliteType: 'INTEGER DEFAULT 0',
    postgresType: 'BOOLEAN DEFAULT FALSE',
    mysqlType: 'TINYINT(1) DEFAULT 0',
  },
  {
    name: 'neighborsIntervalMinutes',
    sqliteType: 'INTEGER DEFAULT 60',
    postgresType: 'INTEGER DEFAULT 60',
    mysqlType: 'INT DEFAULT 60',
  },
  {
    name: 'lastNeighborsRequestAt',
    sqliteType: 'INTEGER',
    postgresType: 'BIGINT',
    mysqlType: 'BIGINT',
  },
];

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding per-node neighbours-retrieval columns to meshcore_nodes...`);

    for (const col of COLUMNS) {
      try {
        db.exec(`ALTER TABLE meshcore_nodes ADD COLUMN ${col.name} ${col.sqliteType}`);
        logger.debug(`${LABEL} (SQLite): added meshcore_nodes.${col.name}`);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (message.includes('duplicate column')) {
          logger.debug(`${LABEL} (SQLite): meshcore_nodes.${col.name} already exists, skipping`);
        } else {
          logger.error(`${LABEL} (SQLite): could not add meshcore_nodes.${col.name}:`, message);
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

export async function runMigration153Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding per-node neighbours-retrieval columns...`);

  for (const col of COLUMNS) {
    await client.query(
      `ALTER TABLE meshcore_nodes ADD COLUMN IF NOT EXISTS "${col.name}" ${col.postgresType}`,
    );
    logger.debug(`${LABEL} (PostgreSQL): ensured meshcore_nodes.${col.name}`);
  }
}

// ============ MySQL ============

export async function runMigration153Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding per-node neighbours-retrieval columns...`);

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
