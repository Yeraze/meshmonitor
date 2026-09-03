/**
 * Multi-Backend Test Factory
 *
 * Shared utility for creating test database connections across SQLite, PostgreSQL, and MySQL.
 * Provides a unified interface for multi-database repository testing.
 *
 * Usage:
 *   const backend = createSqliteBackend(sql);
 *   const backend = await createPostgresBackend(sql);
 *   const backend = await createMysqlBackend(sql);
 */
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import pg from 'pg';
import mysql from 'mysql2/promise';
import * as schema from '../schema/index.js';
import { DatabaseType } from '../types.js';

const { Pool: PgPool } = pg;

// ---------------------------------------------------------------------------
// Availability probes
//
// Each test file skips its PostgreSQL / MySQL describe block via
// `describe.skipIf(!postgresAvailable)` so the vitest summary accurately
// reflects how many tests actually ran. These probes are evaluated once per
// process at module load time (Node's module cache guarantees single
// evaluation even if many test files import this file concurrently).
// ---------------------------------------------------------------------------

async function probePostgres(): Promise<boolean> {
  try {
    const pool = new PgPool({
      host: 'localhost',
      port: 5433,
      user: 'test',
      password: 'test',
      database: 'meshmonitor_test',
      connectionTimeoutMillis: 3000,
    });
    const client = await pool.connect();
    client.release();
    await pool.end();
    return true;
  } catch {
    return false;
  }
}

async function probeMysql(): Promise<boolean> {
  try {
    const pool = mysql.createPool({
      host: 'localhost',
      port: 3307,
      user: 'test',
      password: 'test',
      database: 'meshmonitor_test',
      connectionLimit: 1,
      connectTimeout: 3000,
    });
    const conn = await pool.getConnection();
    conn.release();
    await pool.end();
    return true;
  } catch {
    return false;
  }
}

/**
 * True when the PostgreSQL test container is reachable on port 5433.
 * Computed once per process. Use with `describe.skipIf(!postgresAvailable)`.
 */
export const postgresAvailable: boolean = await probePostgres();

/**
 * True when the MySQL test container is reachable on port 3307.
 * Computed once per process. Use with `describe.skipIf(!mysqlAvailable)`.
 */
export const mysqlAvailable: boolean = await probeMysql();

// ---------------------------------------------------------------------------
// Per-suite fixture isolation — READ THIS BEFORE ADDING A PG/MySQL SUITE
//
// Both test containers expose exactly ONE database (`meshmonitor_test`), and
// Vitest runs test files in parallel forks. So any two suites that
// `DROP TABLE` / `CREATE TABLE` the *same table name* will drop that table out
// from under each other mid-test. The failure looks like:
//
//   PostgreSQL: relation "meshcore_nodes" does not exist
//   MySQL:      Table 'meshmonitor_test.meshcore_nodes' doesn't exist
//
// and it is NOT flake, NOT order-dependence, and NOT environmental — it is a
// fixture race. Migrations 153 and 156 hit exactly this and it was written off
// as "pre-existing and environmental" twice before anyone ran the two files
// together and saw it reproduce 100% of the time. Each file passes alone; only
// the pair fails.
//
// The fix is ISOLATION, not serialization. `createIsolatedPostgresDatabase` /
// `createIsolatedMysqlDatabase` hand a suite its own throwaway database
// (`meshmonitor_test_<key>_<token>`), so nothing it drops can be visible to
// another worker. Migration and repository code only ever uses unqualified
// table names, so it keeps working untouched.
//
// If you are adding a new suite that talks to :5433 / :3307, use these helpers
// (or pass `isolationKey` to `createPostgresBackend` / `createMysqlBackend`).
// Do NOT hand-roll a pool pointed at `meshmonitor_test` and do NOT reach for
// `fileParallelism: false` — that slows every CI leg to paper over one file's
// fixture bug.
//
// The database name also carries a random per-process token, so two test runs
// pointed at the same containers — an agent worktree plus the main checkout,
// which happens constantly in this repo — cannot collide either. A run that is
// SIGKILLed skips its `afterAll` and leaves its databases behind; they are
// empty and harmless in what are throwaway containers, and recreating the
// containers clears them.
// ---------------------------------------------------------------------------

/** Shared connection parameters for the PostgreSQL test container. */
const PG_TEST_CONN = {
  host: 'localhost',
  port: 5433,
  user: 'test',
  password: 'test',
} as const;

/**
 * Admin connection for the MySQL test container.
 *
 * `CREATE DATABASE` needs root: the official MySQL image only grants the
 * `test` user rights on `meshmonitor_test` itself (and escapes the `_` in that
 * grant, so it does not cover `meshmonitor_test_*` either).
 *
 * The root password is not consistent across the ways this container gets
 * started — CI and the `docker run` in CLAUDE.md use `root`, while
 * `docker-compose.test.yml` uses `test` — so resolve it once by probing.
 * `MYSQL_TEST_ROOT_PASSWORD` overrides.
 */
const MYSQL_ROOT_PASSWORD_CANDIDATES = [
  process.env.MYSQL_TEST_ROOT_PASSWORD,
  'root',
  'test',
].filter((p): p is string => typeof p === 'string' && p.length > 0);

let mysqlRootPassword: string | null = null;

async function resolveMysqlRootPassword(): Promise<string> {
  if (mysqlRootPassword !== null) return mysqlRootPassword;
  let lastError: unknown;
  for (const password of MYSQL_ROOT_PASSWORD_CANDIDATES) {
    try {
      const conn = await mysql.createConnection({
        host: 'localhost',
        port: 3307,
        user: 'root',
        password,
        connectTimeout: 15000,
      });
      await conn.end();
      mysqlRootPassword = password;
      return password;
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(
    'Could not authenticate to the MySQL test container as root — needed to ' +
      'create per-suite fixture databases. Set MYSQL_TEST_ROOT_PASSWORD. ' +
      `Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function mysqlAdminConfig() {
  return {
    host: 'localhost',
    port: 3307,
    user: 'root',
    password: await resolveMysqlRootPassword(),
  };
}

/** The shared database both containers are created with. Used only as an admin entrypoint. */
const SHARED_TEST_DB = 'meshmonitor_test';

/**
 * Random suffix, fixed for the life of this worker process.
 *
 * Keeps two concurrent test runs against the same containers from claiming the
 * same fixture database. Identifiers cap at 63 bytes (PostgreSQL) / 64 (MySQL);
 * `meshmonitor_test_` (17) + key (≤30) + `_` + token (6) = ≤54.
 */
const RUN_TOKEN = randomBytes(3).toString('hex');

function isolatedDatabaseName(isolationKey: string): string {
  if (!/^[a-z0-9_]{1,30}$/.test(isolationKey)) {
    throw new Error(
      `Invalid test isolation key ${JSON.stringify(isolationKey)} — ` +
        'must be 1-30 chars of [a-z0-9_] (it becomes part of a database name).',
    );
  }
  return `${SHARED_TEST_DB}_${isolationKey}_${RUN_TOKEN}`;
}

/** A throwaway per-suite database plus the pool bound to it. */
export interface IsolatedPostgresDatabase {
  pool: pg.Pool;
  databaseName: string;
  /** Closes the pool and drops the database. Call from `afterAll`. */
  cleanup: () => Promise<void>;
}

/** A throwaway per-suite database plus the pool bound to it. */
export interface IsolatedMysqlDatabase {
  pool: mysql.Pool;
  databaseName: string;
  /** Closes the pool and drops the database. Call from `afterAll`. */
  cleanup: () => Promise<void>;
}

/**
 * Create a private PostgreSQL database for one test suite.
 *
 * @param isolationKey - Stable per-suite slug, e.g. `'mig153'`. Becomes the
 *                       database name `meshmonitor_test_<key>_<token>`, so it must be
 *                       unique across the whole test suite.
 */
export async function createIsolatedPostgresDatabase(
  isolationKey: string,
): Promise<IsolatedPostgresDatabase> {
  const databaseName = isolatedDatabaseName(isolationKey);

  const admin = new PgPool({
    ...PG_TEST_CONN,
    database: SHARED_TEST_DB,
    connectionTimeoutMillis: 5000,
  });
  try {
    // A previous crashed run can leave the database behind — start clean.
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }

  const pool = new PgPool({
    ...PG_TEST_CONN,
    database: databaseName,
    connectionTimeoutMillis: 5000,
  });

  return {
    pool,
    databaseName,
    cleanup: async () => {
      await pool.end();
      const dropper = new PgPool({
        ...PG_TEST_CONN,
        database: SHARED_TEST_DB,
        connectionTimeoutMillis: 5000,
      });
      try {
        await dropper.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      } finally {
        await dropper.end();
      }
    },
  };
}

/**
 * Create a private MySQL database for one test suite.
 *
 * @param isolationKey - Stable per-suite slug, e.g. `'mig153'`. Becomes the
 *                       database name `meshmonitor_test_<key>_<token>`, so it must be
 *                       unique across the whole test suite.
 */
export async function createIsolatedMysqlDatabase(
  isolationKey: string,
): Promise<IsolatedMysqlDatabase> {
  const databaseName = isolatedDatabaseName(isolationKey);

  const adminConfig = await mysqlAdminConfig();

  const admin = await mysql.createConnection({
    ...adminConfig,
    connectTimeout: 15000,
  });
  try {
    await admin.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
    await admin.query(`CREATE DATABASE \`${databaseName}\``);
  } finally {
    await admin.end();
  }

  const pool = mysql.createPool({
    ...adminConfig,
    database: databaseName,
    connectionLimit: 5,
    connectTimeout: 15000,
  });

  return {
    pool,
    databaseName,
    cleanup: async () => {
      await pool.end();
      const dropper = await mysql.createConnection({
        ...adminConfig,
        connectTimeout: 15000,
      });
      try {
        await dropper.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
      } finally {
        await dropper.end();
      }
    },
  };
}

/**
 * A test backend wrapping a Drizzle database instance with helpers.
 */
export interface TestBackend {
  /** The database dialect */
  dbType: DatabaseType;
  /** Drizzle database instance (any dialect) */
  drizzleDb: any;
  /** Execute raw SQL (for table creation, truncation, etc.) */
  exec: (sql: string) => Promise<void>;
  /** Close the database connection */
  close: () => Promise<void>;
  /** Whether this backend is available for testing */
  available: boolean;
  /** Reason the backend was skipped (when available === false) */
  skipReason?: string;
}

/**
 * Create an in-memory SQLite test backend. Always available.
 */
export function createSqliteBackend(createTablesSql: string): TestBackend {
  const db = new Database(':memory:');
  db.exec(createTablesSql);
  const drizzleDb = drizzleSqlite(db, { schema });

  return {
    dbType: 'sqlite',
    drizzleDb,
    exec: async (sql: string) => {
      db.exec(sql);
    },
    close: async () => {
      db.close();
    },
    available: true,
  };
}

/**
 * Create a PostgreSQL test backend. Connects to test PG on port 5433.
 * Gracefully skips if unavailable (unless CI, where it throws).
 *
 * @param isolationKey - When given, the suite gets its OWN throwaway database
 *   (`meshmonitor_test_<key>_<token>`) instead of the shared `meshmonitor_test`, and
 *   `close()` drops it. Pass this whenever the suite's tables could collide
 *   with another suite's — see the "Per-suite fixture isolation" banner above.
 */
export async function createPostgresBackend(
  createTablesSql: string,
  isolationKey?: string,
): Promise<TestBackend> {
  try {
    const isolated = isolationKey
      ? await createIsolatedPostgresDatabase(isolationKey)
      : null;

    const pool = isolated
      ? isolated.pool
      : new PgPool({
          host: 'localhost',
          port: 5433,
          user: 'test',
          password: 'test',
          database: 'meshmonitor_test',
          connectionTimeoutMillis: 5000,
        });

    // Test connection
    const client = await pool.connect();
    client.release();

    // Create tables
    await pool.query(createTablesSql);

    const drizzleDb = drizzlePostgres(pool, { schema });

    return {
      dbType: 'postgres',
      drizzleDb,
      exec: async (sql: string) => {
        await pool.query(sql);
      },
      close: async () => {
        if (isolated) {
          await isolated.cleanup();
        } else {
          await pool.end();
        }
      },
      available: true,
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    if (process.env.CI === 'true') {
      throw new Error(
        `PostgreSQL test backend failed: ${errMsg}`
      );
    }
    return {
      dbType: 'postgres',
      drizzleDb: null,
      exec: async () => {},
      close: async () => {},
      available: false,
      skipReason:
        'PostgreSQL not available on port 5433. ' +
        'Run: docker run -d --name meshmonitor-test-postgres -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=meshmonitor_test -p 5433:5432 postgres:16',
    };
  }
}

/**
 * Create a MySQL test backend. Connects to test MySQL on port 3307.
 * Gracefully skips if unavailable (unless CI, where it throws).
 *
 * @param isolationKey - When given, the suite gets its OWN throwaway database
 *   (`meshmonitor_test_<key>_<token>`) instead of the shared `meshmonitor_test`, and
 *   `close()` drops it. Pass this whenever the suite's tables could collide
 *   with another suite's — see the "Per-suite fixture isolation" banner above.
 */
export async function createMysqlBackend(
  createTablesSql: string,
  isolationKey?: string,
): Promise<TestBackend> {
  try {
    const isolated = isolationKey ? await createIsolatedMysqlDatabase(isolationKey) : null;

    const pool = isolated
      ? isolated.pool
      : mysql.createPool({
          host: 'localhost',
          port: 3307,
          user: 'test',
          password: 'test',
          database: 'meshmonitor_test',
          connectionLimit: 5,
          connectTimeout: 15000,
        });

    // Test connection with retry (MySQL containers can be slow to accept connections)
    let conn;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        conn = await pool.getConnection();
        conn.release();
        break;
      } catch (e) {
        if (attempt === 2) throw e;
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    // Create tables (split by semicolons for MySQL multi-statement)
    const statements = createTablesSql.split(';').map(s => s.trim()).filter(Boolean);
    for (const stmt of statements) {
      await pool.query(stmt);
    }

    const drizzleDb = drizzleMysql(pool, { schema, mode: 'default' });

    return {
      dbType: 'mysql',
      drizzleDb,
      exec: async (sql: string) => {
        const stmts = sql.split(';').map(s => s.trim()).filter(Boolean);
        for (const stmt of stmts) {
          await pool.query(stmt);
        }
      },
      close: async () => {
        if (isolated) {
          await isolated.cleanup();
        } else {
          await pool.end();
        }
      },
      available: true,
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    if (process.env.CI === 'true') {
      throw new Error(
        `MySQL test backend failed: ${errMsg}`
      );
    }
    return {
      dbType: 'mysql',
      drizzleDb: null,
      exec: async () => {},
      close: async () => {},
      available: false,
      skipReason:
        'MySQL not available on port 3307. ' +
        'Run: docker run -d --name meshmonitor-test-mysql -e MYSQL_ROOT_PASSWORD=test -e MYSQL_USER=test -e MYSQL_PASSWORD=test -e MYSQL_DATABASE=meshmonitor_test -p 3307:3306 mysql:8',
    };
  }
}

/**
 * Clear a table, handling different syntax per backend.
 */
export async function clearTable(backend: TestBackend, tableName: string): Promise<void> {
  if (!backend.available) return;

  switch (backend.dbType) {
    case 'sqlite':
      await backend.exec(`DELETE FROM ${tableName}`);
      break;
    case 'postgres':
      await backend.exec(`TRUNCATE TABLE ${tableName} RESTART IDENTITY CASCADE`);
      break;
    case 'mysql':
      await backend.exec(`SET FOREIGN_KEY_CHECKS = 0; TRUNCATE TABLE ${tableName}; SET FOREIGN_KEY_CHECKS = 1`);
      break;
  }
}
