/**
 * Migration 047: Add missing `selectedLayer` column to user_map_preferences on
 * PostgreSQL/MySQL.
 *
 * Pre-baseline (v3.6 and earlier) PG/MySQL deployments created
 * `user_map_preferences` with a `selectedNodeNum` column and NO `selectedLayer`.
 * The v3.7 baseline replaced `selectedNodeNum` with `selectedLayer`, but
 * `CREATE TABLE IF NOT EXISTS` is a no-op on the pre-existing legacy table.
 * Migration 007 backfilled other missing columns (map_tileset, show_*) but
 * never added `selectedLayer`.
 *
 * Current Drizzle `getMapPreferences` selects every schema column, so PG
 * fails on legacy tables with `column "selectedLayer" does not exist`. This
 * migration idempotently adds the column. The stale `selectedNodeNum` column
 * is left in place (nullable, harmless).
 *
 * SQLite is unaffected: bootstrap + migration 046 ensure the column exists.
 */
import type { Database } from 'better-sqlite3';

export const migration = {
  up(_db: Database): void {
    // intentionally empty — SQLite handled by bootstrap + migration 046
  },
};

export async function runMigration047Postgres(client: any): Promise<void> {
  const tableExists = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_name = 'user_map_preferences' LIMIT 1`
  );
  if (tableExists.rows.length === 0) {
    return;
  }

  const col = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_name = 'user_map_preferences' AND column_name = 'selectedLayer' LIMIT 1`
  );
  if (col.rows.length === 0) {
    await client.query(`ALTER TABLE user_map_preferences ADD COLUMN "selectedLayer" TEXT`);
  }
}

export async function runMigration047Mysql(pool: any): Promise<void> {
  const [tables] = await pool.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_map_preferences'`
  );
  if ((tables as any[]).length === 0) {
    return;
  }

  const [rows] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_map_preferences'
       AND COLUMN_NAME = 'selectedLayer'`
  );
  if ((rows as any[]).length === 0) {
    await pool.query(`ALTER TABLE user_map_preferences ADD COLUMN selectedLayer VARCHAR(64)`);
  }
}
