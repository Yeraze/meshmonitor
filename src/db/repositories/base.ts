/**
 * Base Repository Class
 *
 * Provides common functionality for all repository implementations.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { MySql2Database } from 'drizzle-orm/mysql2';
import * as schema from '../schema/index.js';
import { DatabaseType } from '../types.js';

// Specific database types for type narrowing
export type SQLiteDrizzle = BetterSQLite3Database<typeof schema>;
export type PostgresDrizzle = NodePgDatabase<typeof schema>;
export type MySQLDrizzle = MySql2Database<typeof schema>;

// Union type for all database types
export type DrizzleDatabase = SQLiteDrizzle | PostgresDrizzle | MySQLDrizzle;

/**
 * Base repository providing common functionality
 */
export abstract class BaseRepository {
  protected readonly dbType: DatabaseType;

  // Store the specific typed databases
  protected readonly sqliteDb: SQLiteDrizzle | null;
  protected readonly postgresDb: PostgresDrizzle | null;
  protected readonly mysqlDb: MySQLDrizzle | null;

  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    this.dbType = dbType;

    // Type narrow at construction time
    if (dbType === 'sqlite') {
      this.sqliteDb = db as SQLiteDrizzle;
      this.postgresDb = null;
      this.mysqlDb = null;
    } else if (dbType === 'postgres') {
      this.sqliteDb = null;
      this.postgresDb = db as PostgresDrizzle;
      this.mysqlDb = null;
    } else {
      this.sqliteDb = null;
      this.postgresDb = null;
      this.mysqlDb = db as MySQLDrizzle;
    }
  }

  /**
   * Check if using SQLite
   */
  protected isSQLite(): boolean {
    return this.dbType === 'sqlite';
  }

  /**
   * Check if using PostgreSQL
   */
  protected isPostgres(): boolean {
    return this.dbType === 'postgres';
  }

  /**
   * Check if using MySQL
   */
  protected isMySQL(): boolean {
    return this.dbType === 'mysql';
  }

  /**
   * Get the SQLite database (throws if not SQLite)
   */
  protected getSqliteDb(): SQLiteDrizzle {
    if (!this.sqliteDb) {
      throw new Error('Cannot access SQLite database when using PostgreSQL or MySQL');
    }
    return this.sqliteDb;
  }

  /**
   * Get the PostgreSQL database (throws if not PostgreSQL)
   */
  protected getPostgresDb(): PostgresDrizzle {
    if (!this.postgresDb) {
      throw new Error('Cannot access PostgreSQL database when using SQLite or MySQL');
    }
    return this.postgresDb;
  }

  /**
   * Get the MySQL database (throws if not MySQL)
   */
  protected getMysqlDb(): MySQLDrizzle {
    if (!this.mysqlDb) {
      throw new Error('Cannot access MySQL database when using SQLite or PostgreSQL');
    }
    return this.mysqlDb;
  }

  /**
   * Get current timestamp in milliseconds
   */
  protected now(): number {
    return Date.now();
  }

  /**
   * Normalize BigInt values to numbers (SQLite returns BigInt for large integers)
   * Preserves prototype chains for Date objects and other special types
   */
  protected normalizeBigInts<T>(obj: T): T {
    if (obj === null || obj === undefined) return obj;

    if (typeof obj === 'bigint') {
      return Number(obj) as unknown as T;
    }

    if (typeof obj === 'object') {
      // Preserve Date objects and other built-in types
      if (obj instanceof Date) {
        return obj;
      }

      if (Array.isArray(obj)) {
        return obj.map(item => this.normalizeBigInts(item)) as unknown as T;
      }

      // For plain objects, create a new object with the same prototype
      const prototype = Object.getPrototypeOf(obj);
      const normalized = Object.create(prototype) as Record<string, unknown>;
      for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          normalized[key] = this.normalizeBigInts((obj as Record<string, unknown>)[key]);
        }
      }
      return normalized as T;
    }

    return obj;
  }
}
