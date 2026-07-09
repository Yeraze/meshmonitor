/**
 * Migration idempotency helpers.
 *
 * Use these in NEW migrations instead of hand-rolling the three-idiom
 * per-dialect try/catch / IF NOT EXISTS / information_schema patterns.
 * Do NOT apply to existing migrations — history must stay intact.
 *
 * # SQLite
 *   `addColumnIfMissing(db, table, column, ddl)` — catches the
 *   "duplicate column" error that SQLite raises when the column already
 *   exists; re-throws anything else.
 *
 * # PostgreSQL
 *   `addColumnIfMissingPostgres(client, table, column, ddl)` — delegates to
 *   the native `ADD COLUMN IF NOT EXISTS` clause; one round-trip, no
 *   information_schema pre-check needed.
 *   SQLite and PostgreSQL both support `CREATE TABLE IF NOT EXISTS` and
 *   `CREATE INDEX IF NOT EXISTS` natively, so no table/index helpers are
 *   provided for those dialects.
 *
 * # MySQL
 *   `addColumnIfMissingMysql(pool, table, column, ddl)` — queries
 *   `information_schema.COLUMNS` before issuing `ALTER TABLE`.
 *   `createTableIfMissingMysql(pool, table, createDdl)` — queries
 *   `information_schema.TABLES` before issuing `CREATE TABLE`.
 *   MySQL has no `CREATE INDEX IF NOT EXISTS` syntax; add indexes inline
 *   in the `CREATE TABLE` DDL passed to `createTableIfMissingMysql` (the
 *   same technique used by existing migrations 108 / 110).
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

// ─── SQLite ────────────────────────────────────────────────────────────────────

/**
 * Idempotently adds a column to an existing SQLite table.
 *
 * SQLite does not support `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, so this
 * helper catches the "duplicate column" error and treats it as a no-op.
 * All other errors are re-thrown.
 *
 * @param db     - better-sqlite3 Database instance
 * @param table  - Table name
 * @param column - Column name (used in log messages only)
 * @param ddl    - Full column definition **including** the column name,
 *                 e.g. `'notes TEXT'`, `'positionSource TEXT'`,
 *                 `'count INTEGER DEFAULT 0'`
 *
 * @example
 * addColumnIfMissing(db, 'nodes', 'notes', 'notes TEXT');
 * addColumnIfMissing(db, 'nodes', 'isUnmessagable', 'isUnmessagable INTEGER DEFAULT 0');
 */
export function addColumnIfMissing(
  db: Database,
  table: string,
  column: string,
  ddl: string,
): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    logger.debug(`Migration helper (SQLite): added ${table}.${column}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- caught error shape unknown
  } catch (e: any) {
    if (e.message?.includes('duplicate column')) {
      logger.debug(`Migration helper (SQLite): ${table}.${column} already present, skipping`);
    } else {
      throw e;
    }
  }
}

// ─── PostgreSQL ────────────────────────────────────────────────────────────────

/**
 * Idempotently adds a column to an existing PostgreSQL table.
 *
 * Delegates to the native `ADD COLUMN IF NOT EXISTS` syntax — a single
 * round-trip with no information_schema pre-check required.
 *
 * @param client - pg PoolClient (within a transaction or direct)
 * @param table  - Table name
 * @param column - Column name (used in log messages only)
 * @param ddl    - Full column definition **including** the (quoted) column
 *                 name, e.g. `'"notes" TEXT'`, `'"positionSource" TEXT'`,
 *                 `'"count" INTEGER DEFAULT 0'`
 *
 * @example
 * await addColumnIfMissingPostgres(client, 'nodes', 'notes', '"notes" TEXT');
 */
export async function addColumnIfMissingPostgres(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pg PoolClient: tight coupling to pg package not warranted in helpers
  client: any,
  table: string,
  column: string,
  ddl: string,
): Promise<void> {
  await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${ddl}`);
  logger.debug(`Migration helper (PostgreSQL): ensured ${table}.${column}`);
}

// ─── MySQL ─────────────────────────────────────────────────────────────────────

/**
 * Idempotently adds a column to an existing MySQL table.
 *
 * MySQL lacks `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, so this helper
 * queries `information_schema.COLUMNS` first and skips the `ALTER TABLE`
 * if the column is already present.  The connection is always released in a
 * `finally` block.
 *
 * @param pool   - mysql2 Pool
 * @param table  - Table name
 * @param column - Column name (used in the information_schema query and logs)
 * @param ddl    - Full column definition **including** the column name,
 *                 e.g. `'notes VARCHAR(2000)'`, `'positionSource VARCHAR(16)'`,
 *                 `'count INT DEFAULT 0'`
 *
 * @example
 * await addColumnIfMissingMysql(pool, 'nodes', 'notes', 'notes VARCHAR(2000)');
 */
export async function addColumnIfMissingMysql(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mysql2 Pool: tight coupling not warranted in helpers
  pool: any,
  table: string,
  column: string,
  ddl: string,
): Promise<void> {
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column],
    );
    if (Array.isArray(rows) && rows.length === 0) {
      await conn.query(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
      logger.debug(`Migration helper (MySQL): added ${table}.${column}`);
    } else {
      logger.debug(`Migration helper (MySQL): ${table}.${column} already present, skipping`);
    }
  } finally {
    conn.release();
  }
}

/**
 * Idempotently creates a MySQL table only if it does not already exist.
 *
 * Queries `information_schema.TABLES` before issuing `CREATE TABLE` so the
 * outcome is logged clearly.  The connection is always released in a
 * `finally` block.
 *
 * Because MySQL has no `CREATE INDEX IF NOT EXISTS` syntax, add any required
 * indexes as inline `INDEX` / `UNIQUE KEY` clauses inside the `CREATE TABLE`
 * DDL (the same technique used by existing migrations 108 and 110).
 *
 * @param pool      - mysql2 Pool
 * @param table     - Table name (used in the information_schema query and logs)
 * @param createDdl - Full `CREATE TABLE tableName (…)` statement.
 *                    Include inline `INDEX` / `UNIQUE KEY` clauses here.
 *
 * @example
 * await createTableIfMissingMysql(pool, 'my_events', `
 *   CREATE TABLE my_events (
 *     id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 *     sourceId VARCHAR(255) NOT NULL,
 *     timestamp BIGINT NOT NULL,
 *     INDEX my_events_source_idx (sourceId, timestamp)
 *   )
 * `);
 */
export async function createTableIfMissingMysql(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mysql2 Pool: tight coupling not warranted in helpers
  pool: any,
  table: string,
  createDdl: string,
): Promise<void> {
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [table],
    );
    if (Array.isArray(rows) && rows.length === 0) {
      await conn.query(createDdl);
      logger.debug(`Migration helper (MySQL): created table ${table}`);
    } else {
      logger.debug(`Migration helper (MySQL): table ${table} already exists, skipping`);
    }
  } finally {
    conn.release();
  }
}
