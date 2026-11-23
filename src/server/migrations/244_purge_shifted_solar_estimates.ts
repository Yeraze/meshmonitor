/**
 * Migration 244: delete every stored forecast.solar estimate (#6523).
 *
 * Before #6523 the service parsed forecast.solar's offset-less local timestamps
 * in the container's TZ, so stored rows are shifted by the gap between that TZ
 * and the panel location's. They can't be corrected in place (the location's
 * zone at fetch time is unknown), and the next hourly fetch refills the table
 * with correct UTC rows, so drop them once.
 */
import type { Database } from 'better-sqlite3';

export const migration = {
  up: (db: Database): void => {
    db.exec('DELETE FROM solar_estimates');
  },
};

export async function runMigration244Postgres(client: import('pg').PoolClient): Promise<void> {
  await client.query('DELETE FROM solar_estimates');
}

export async function runMigration244Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  await pool.query('DELETE FROM solar_estimates');
}
