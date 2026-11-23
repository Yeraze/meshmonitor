/**
 * Migration 245: create `solar_irradiance` (#6523).
 *
 * Global cache of hourly Open-Meteo sunlight + cloud cover per grid cell. See
 * `src/db/schema/solarIrradiance.ts` for why it carries no `sourceId`.
 * `sirr_ts_idx` serves the retention sweep (`timestamp < cutoff`). Starts empty;
 * idempotent on all three backends.
 */
import type { Database } from 'better-sqlite3';
import { createTableIfMissingMysql } from './helpers.js';

const TABLE = 'solar_irradiance';
const TS_INDEX = 'sirr_ts_idx';

export const migration = {
  up: (db: Database): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        cellKey TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        shortwaveRadiation REAL,
        cloudCover REAL,
        fetchedAt INTEGER NOT NULL,
        PRIMARY KEY (cellKey, timestamp)
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS ${TS_INDEX} ON ${TABLE}(timestamp)`);
  },
};

export async function runMigration245Postgres(client: import('pg').PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      "cellKey" TEXT NOT NULL,
      "timestamp" BIGINT NOT NULL,
      "shortwaveRadiation" DOUBLE PRECISION,
      "cloudCover" DOUBLE PRECISION,
      "fetchedAt" BIGINT NOT NULL,
      PRIMARY KEY ("cellKey", "timestamp")
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS ${TS_INDEX} ON ${TABLE}("timestamp")`);
}

export async function runMigration245Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  await createTableIfMissingMysql(pool, TABLE, `
    CREATE TABLE ${TABLE} (
      cellKey VARCHAR(48) NOT NULL,
      timestamp BIGINT NOT NULL,
      shortwaveRadiation DOUBLE,
      cloudCover DOUBLE,
      fetchedAt BIGINT NOT NULL,
      PRIMARY KEY (cellKey, timestamp),
      INDEX ${TS_INDEX} (timestamp)
    )
  `);
}
