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
import Database from 'better-sqlite3';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import pg from 'pg';
import mysql from 'mysql2/promise';
import * as schema from '../schema/index.js';
import { DatabaseType } from '../types.js';

const { Pool: PgPool } = pg;

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
 */
export async function createPostgresBackend(createTablesSql: string): Promise<TestBackend> {
  try {
    const pool = new PgPool({
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
        await pool.end();
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
 */
export async function createMysqlBackend(createTablesSql: string): Promise<TestBackend> {
  try {
    const pool = mysql.createPool({
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
        await pool.end();
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
