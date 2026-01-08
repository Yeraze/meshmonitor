/**
 * Database Factory
 *
 * This module provides a unified interface for creating database connections
 * supporting SQLite, PostgreSQL, and MySQL/MariaDB backends.
 *
 * Usage:
 * ```typescript
 * import { createDatabase, getDatabaseType } from './db/index.js';
 *
 * // Create database based on environment config
 * const { db, close } = await createDatabase();
 *
 * // Or specify explicitly
 * const { db, close } = await createDatabase({
 *   type: 'postgres',
 *   postgresUrl: 'postgres://user:pass@localhost/meshmonitor'
 * });
 *
 * // MySQL/MariaDB
 * const { db, close } = await createDatabase({
 *   type: 'mysql',
 *   mysqlUrl: 'mysql://user:pass@localhost/meshmonitor'
 * });
 * ```
 */

import { createSQLiteDriver, SQLiteDatabase } from './drivers/sqlite.js';
import { createPostgresDriver, PostgresDatabase } from './drivers/postgres.js';
import { createMySQLDriver, MySQLDatabase } from './drivers/mysql.js';
import { DatabaseConfig, DatabaseType } from './types.js';
import { getEnvironmentConfig } from '../server/config/environment.js';
import { logger } from '../utils/logger.js';

// Re-export types
export * from './types.js';
export * from './schema/index.js';
export * from './repositories/index.js';
export type { SQLiteDatabase } from './drivers/sqlite.js';
export type { PostgresDatabase } from './drivers/postgres.js';
export type { MySQLDatabase } from './drivers/mysql.js';

/**
 * Union type for all database types
 */
export type Database = SQLiteDatabase | PostgresDatabase | MySQLDatabase;

/**
 * Database connection result
 */
export interface DatabaseConnection {
  db: Database;
  type: DatabaseType;
  close: () => void | Promise<void>;
}

/**
 * Detect database type from environment configuration
 */
export function detectDatabaseType(): DatabaseType {
  const config = getEnvironmentConfig();

  // Check for DATABASE_URL first
  if (config.databaseUrl) {
    const url = config.databaseUrl.toLowerCase();
    if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
      return 'postgres';
    }
    if (url.startsWith('mysql://') || url.startsWith('mariadb://')) {
      return 'mysql';
    }
  }

  // Default to SQLite
  return 'sqlite';
}

/**
 * Get database configuration from environment
 */
export function getDatabaseConfig(): DatabaseConfig {
  const config = getEnvironmentConfig();
  const type = detectDatabaseType();

  return {
    type,
    sqlitePath: config.databasePath,
    postgresUrl: type === 'postgres' ? config.databaseUrl : undefined,
    postgresMaxConnections: 10,
    postgresSsl: false,
    mysqlUrl: type === 'mysql' ? config.databaseUrl : undefined,
    mysqlMaxConnections: 10,
  };
}

/**
 * Create a database connection based on configuration
 *
 * @param config - Optional database configuration. If not provided, uses environment config.
 * @returns Database connection with close function
 */
export async function createDatabase(config?: Partial<DatabaseConfig>): Promise<DatabaseConnection> {
  const finalConfig: DatabaseConfig = {
    ...getDatabaseConfig(),
    ...config,
  };

  logger.info(`[Database Factory] Creating ${finalConfig.type} database connection`);

  if (finalConfig.type === 'postgres') {
    if (!finalConfig.postgresUrl) {
      throw new Error('PostgreSQL URL is required when type is "postgres"');
    }

    const { db, close } = await createPostgresDriver({
      connectionString: finalConfig.postgresUrl,
      maxConnections: finalConfig.postgresMaxConnections,
      ssl: finalConfig.postgresSsl,
    });

    return {
      db,
      type: 'postgres',
      close,
    };
  }

  if (finalConfig.type === 'mysql') {
    if (!finalConfig.mysqlUrl) {
      throw new Error('MySQL URL is required when type is "mysql"');
    }

    const { db, close } = await createMySQLDriver({
      connectionString: finalConfig.mysqlUrl,
      maxConnections: finalConfig.mysqlMaxConnections,
    });

    return {
      db,
      type: 'mysql',
      close,
    };
  }

  // Default to SQLite
  if (!finalConfig.sqlitePath) {
    throw new Error('SQLite path is required when type is "sqlite"');
  }

  const { db, close } = createSQLiteDriver({
    databasePath: finalConfig.sqlitePath,
  });

  return {
    db,
    type: 'sqlite',
    close,
  };
}

/**
 * Check if a database connection is PostgreSQL
 */
export function isPostgres(db: Database): db is PostgresDatabase {
  // PostgresDatabase uses node-postgres which has different internal structure
  return 'query' in db && typeof (db as any).query === 'function';
}

/**
 * Check if a database connection is MySQL
 */
export function isMySQL(db: Database): db is MySQLDatabase {
  // MySQLDatabase uses mysql2 which has execute method
  return 'execute' in db && typeof (db as any).execute === 'function';
}

/**
 * Check if a database connection is SQLite
 */
export function isSQLite(db: Database): db is SQLiteDatabase {
  return !isPostgres(db) && !isMySQL(db);
}

/**
 * Get the current database type from environment
 */
export function getDatabaseType(): DatabaseType {
  return detectDatabaseType();
}
