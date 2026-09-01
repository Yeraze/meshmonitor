/**
 * Migration 156: Per-node time-sync config on `meshcore_nodes`.
 *
 * Adds three nullable columns the new MeshCore time-sync scheduler
 * (`MeshCoreTimeSyncScheduler`, issue #4916) reads on each tick. Deliberately
 * a SEPARATE column set from the migration-060 telemetry trio and the
 * migration-153 neighbours trio, for the same reason those two are separate
 * from each other: a time-sync push must never reset the telemetry or
 * neighbours cadence, and vice versa.
 *
 *   timeSyncEnabled          BOOLEAN  (false by default)
 *   timeSyncIntervalMinutes  INTEGER  (720 = 12h default; 0 disables this row)
 *   lastTimeSyncAt           BIGINT   (ms; null until first attempt)
 *
 * The 12h default is deliberately far slower than the Meshtastic auto
 * time-sync default (15 min). One MeshCore repeater sync costs FOUR packets
 * on the air, not one — `ensureSavedLogin()` does not cache, so every sync is
 * a login DM plus its reply, then the `time <epoch>` CliData DM plus its
 * reply — and each of those floods when the target's out_path is unknown.
 * Repeater RTC drift is seconds-to-minutes per day, so 12h has ample margin.
 *
 * `lastTimeSyncAt` lives in the DATABASE rather than on the scheduler
 * instance on purpose: an in-memory stamp would be cleared by every restart
 * and by every settings save that re-arms the scheduler, so a user editing
 * the config page would re-trigger a sync burst across their whole mesh
 * (CLAUDE.md, "Does a save reset a safety timer?").
 *
 * Backfill is unnecessary — without `timeSyncEnabled=true` the scheduler
 * never picks the row, so existing rows keep their current behaviour.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 156';

interface ColumnSpec {
  name: string;
  sqliteType: string;
  postgresType: string;
  mysqlType: string;
}

const COLUMNS: ColumnSpec[] = [
  {
    name: 'timeSyncEnabled',
    sqliteType: 'INTEGER DEFAULT 0',
    postgresType: 'BOOLEAN DEFAULT FALSE',
    mysqlType: 'TINYINT(1) DEFAULT 0',
  },
  {
    name: 'timeSyncIntervalMinutes',
    sqliteType: 'INTEGER DEFAULT 720',
    postgresType: 'INTEGER DEFAULT 720',
    mysqlType: 'INT DEFAULT 720',
  },
  {
    name: 'lastTimeSyncAt',
    sqliteType: 'INTEGER',
    postgresType: 'BIGINT',
    mysqlType: 'BIGINT',
  },
];

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding per-node time-sync columns to meshcore_nodes...`);

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

export async function runMigration156Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding per-node time-sync columns...`);

  for (const col of COLUMNS) {
    await client.query(
      `ALTER TABLE meshcore_nodes ADD COLUMN IF NOT EXISTS "${col.name}" ${col.postgresType}`,
    );
    logger.debug(`${LABEL} (PostgreSQL): ensured meshcore_nodes.${col.name}`);
  }
}

// ============ MySQL ============

export async function runMigration156Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding per-node time-sync columns...`);

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
