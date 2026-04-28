/**
 * Migration 037: Backfill missing user_map_preferences columns on PostgreSQL/MySQL.
 *
 * Pre-baseline (v3.7) PostgreSQL/MySQL deployments created user_map_preferences
 * via Drizzle's pre-Drizzle-ORM raw SQL with only base columns and no `id`
 * primary key. The v3.7 baseline (migration 001) creates the table with the
 * full schema, but only when the table does not already exist — `CREATE TABLE
 * IF NOT EXISTS` is a no-op on pre-existing tables.
 *
 * After PR #2681 moved getMapPreferences to Drizzle, the generated
 * `SELECT *`-style query references every schema column, including `id`,
 * `createdAt`, and `updatedAt`. PG fails with `column "id" does not exist`
 * for those legacy tables.
 *
 * This migration idempotently ensures `id`, `createdAt`, and `updatedAt`
 * exist on PG/MySQL `user_map_preferences`. If a primary key already exists
 * but is not `id`, it is dropped first so `id` can become the new PK.
 *
 * SQLite is unaffected: the bootstrap in src/services/database.ts creates
 * the table with the correct schema before any migration runs.
 */
import type { Database } from 'better-sqlite3';

export const migration = {
  // No-op on SQLite: bootstrap already creates user_map_preferences with id,
  // createdAt, and updatedAt before migrations run.
  up(_db: Database): void {
    // intentionally empty
  },
};

export async function runMigration037Postgres(client: any): Promise<void> {
  const tableExists = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_name = 'user_map_preferences' LIMIT 1`
  );
  if (tableExists.rows.length === 0) {
    return;
  }

  const idCol = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_name = 'user_map_preferences' AND column_name = 'id' LIMIT 1`
  );
  if (idCol.rows.length === 0) {
    const pk = await client.query(
      `SELECT constraint_name FROM information_schema.table_constraints
       WHERE table_name = 'user_map_preferences' AND constraint_type = 'PRIMARY KEY' LIMIT 1`
    );
    if (pk.rows.length > 0) {
      const name = pk.rows[0].constraint_name;
      await client.query(`ALTER TABLE user_map_preferences DROP CONSTRAINT "${name}"`);
    }
    await client.query(`ALTER TABLE user_map_preferences ADD COLUMN id SERIAL PRIMARY KEY`);
  }

  const createdAtCol = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_name = 'user_map_preferences' AND column_name = 'createdAt' LIMIT 1`
  );
  if (createdAtCol.rows.length === 0) {
    await client.query(`ALTER TABLE user_map_preferences ADD COLUMN "createdAt" BIGINT`);
  }

  const updatedAtCol = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_name = 'user_map_preferences' AND column_name = 'updatedAt' LIMIT 1`
  );
  if (updatedAtCol.rows.length === 0) {
    await client.query(`ALTER TABLE user_map_preferences ADD COLUMN "updatedAt" BIGINT`);
  }
}

export async function runMigration037Mysql(pool: any): Promise<void> {
  const [tables] = await pool.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_map_preferences'`
  );
  if ((tables as any[]).length === 0) {
    return;
  }

  const [idRows] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_map_preferences' AND COLUMN_NAME = 'id'`
  );
  if ((idRows as any[]).length === 0) {
    const [pkRows] = await pool.query(
      `SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_map_preferences'
         AND CONSTRAINT_TYPE = 'PRIMARY KEY'`
    );
    if ((pkRows as any[]).length > 0) {
      // Issue #2836: legacy MySQL deployments primary-key the table on a
      // single column (typically `userId`) that is also referenced by an FK
      // back to `users.id`. MySQL backs the FK with the PK's index; dropping
      // the PK without first creating a non-PK index over the FK column
      // leaves the FK "incorrectly formed" and ALTER fails with errno 150.
      // Pre-create non-PK indexes covering every FK column on this table so
      // each FK retains a backing index when the PK is dropped. Idempotent
      // via information_schema check.
      const [fkRows] = await pool.query(
        `SELECT COLUMN_NAME, CONSTRAINT_NAME
         FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_map_preferences'
           AND REFERENCED_TABLE_NAME IS NOT NULL`
      );
      for (const fk of (fkRows as any[])) {
        const colName: string = fk.COLUMN_NAME;
        const indexName = `idx_ump_${colName}`;
        const [existingIdx] = await pool.query(
          `SELECT INDEX_NAME FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_map_preferences'
             AND COLUMN_NAME = ? AND INDEX_NAME != 'PRIMARY' LIMIT 1`,
          [colName]
        );
        if ((existingIdx as any[]).length === 0) {
          await pool.query(
            `ALTER TABLE user_map_preferences ADD INDEX \`${indexName}\` (\`${colName}\`)`
          );
        }
      }
      await pool.query(`ALTER TABLE user_map_preferences DROP PRIMARY KEY`);
    }
    await pool.query(`ALTER TABLE user_map_preferences ADD COLUMN id INT AUTO_INCREMENT PRIMARY KEY FIRST`);
  }

  const [createdAtRows] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_map_preferences' AND COLUMN_NAME = 'createdAt'`
  );
  if ((createdAtRows as any[]).length === 0) {
    await pool.query(`ALTER TABLE user_map_preferences ADD COLUMN createdAt BIGINT`);
  }

  const [updatedAtRows] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_map_preferences' AND COLUMN_NAME = 'updatedAt'`
  );
  if ((updatedAtRows as any[]).length === 0) {
    await pool.query(`ALTER TABLE user_map_preferences ADD COLUMN updatedAt BIGINT`);
  }
}
