/**
 * Migration 244: delete every stored forecast.solar estimate (#6523).
 *
 * Before #6523 the service parsed forecast.solar's offset-less local timestamps
 * in the container's TZ, so stored rows are shifted by the gap between that TZ
 * and the panel location's. They can't be corrected in place (the location's
 * zone at fetch time is unknown), and the next hourly fetch refills the table
 * with correct UTC rows, so drop them once.
 *
 * Migration 246 later drops the table. Restoring a backup taken before 244
 * brings back settings without this migration's key while the table stays
 * dropped, so each backend skips the delete when the table is gone.
 */
import type { Database } from 'better-sqlite3';

const TABLE = 'solar_estimates';

export const migration = {
  up: (db: Database): void => {
    const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(TABLE);
    if (exists) db.exec(`DELETE FROM ${TABLE}`);
  },
};

export async function runMigration244Postgres(client: import('pg').PoolClient): Promise<void> {
  const { rows } = await client.query(`SELECT to_regclass('${TABLE}') AS t`);
  if (rows[0]?.t) await client.query(`DELETE FROM ${TABLE}`);
}

export async function runMigration244Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [TABLE],
  );
  if (Number((rows as Array<{ n: unknown }>)[0]?.n) > 0) await pool.query(`DELETE FROM ${TABLE}`);
}
