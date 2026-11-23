/**
 * Migration 246: drop `solar_estimates` (#6523).
 *
 * The forecast.solar cache (one install-wide panel forecast) is replaced by
 * per-node Open-Meteo sunlight in `solar_irradiance` (migration 245). Nothing
 * reads the old table any more. `DROP TABLE IF EXISTS` is idempotent on all
 * three backends; an old system backup that still lists the table is skipped
 * with a warning on restore (it is no longer in BACKUP_TABLES).
 */
import type { Database } from 'better-sqlite3';

const TABLE = 'solar_estimates';

export const migration = {
  up: (db: Database): void => {
    db.exec(`DROP TABLE IF EXISTS ${TABLE}`);
  },
};

export async function runMigration246Postgres(client: import('pg').PoolClient): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS ${TABLE}`);
}

export async function runMigration246Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  await pool.query(`DROP TABLE IF EXISTS ${TABLE}`);
}
