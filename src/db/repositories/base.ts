/**
 * Base Repository Class
 *
 * Provides common functionality for all repository implementations.
 * Supports both SQLite and PostgreSQL through Drizzle ORM.
 */
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../schema/index.js';
import { DatabaseType } from '../types.js';

// Specific database types for type narrowing
export type SQLiteDrizzle = BetterSQLite3Database<typeof schema>;
export type PostgresDrizzle = NodePgDatabase<typeof schema>;

// Union type for both database types
export type DrizzleDatabase = SQLiteDrizzle | PostgresDrizzle;

/**
 * Base repository providing common functionality
 */
export abstract class BaseRepository {
  protected readonly dbType: DatabaseType;

  // Store the specific typed databases
  protected readonly sqliteDb: SQLiteDrizzle | null;
  protected readonly postgresDb: PostgresDrizzle | null;

  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    this.dbType = dbType;

    // Type narrow at construction time
    if (dbType === 'sqlite') {
      this.sqliteDb = db as SQLiteDrizzle;
      this.postgresDb = null;
    } else {
      this.sqliteDb = null;
      this.postgresDb = db as PostgresDrizzle;
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
   * Get the SQLite database (throws if not SQLite)
   */
  protected getSqliteDb(): SQLiteDrizzle {
    if (!this.sqliteDb) {
      throw new Error('Cannot access SQLite database when using PostgreSQL');
    }
    return this.sqliteDb;
  }

  /**
   * Get the PostgreSQL database (throws if not PostgreSQL)
   */
  protected getPostgresDb(): PostgresDrizzle {
    if (!this.postgresDb) {
      throw new Error('Cannot access PostgreSQL database when using SQLite');
    }
    return this.postgresDb;
  }

  /**
   * Get current timestamp in milliseconds
   */
  protected now(): number {
    return Date.now();
  }

  /**
   * Normalize BigInt values to numbers (SQLite returns BigInt for large integers)
   */
  protected normalizeBigInts<T>(obj: T): T {
    if (obj === null || obj === undefined) return obj;

    if (typeof obj === 'bigint') {
      return Number(obj) as unknown as T;
    }

    if (typeof obj === 'object') {
      if (Array.isArray(obj)) {
        return obj.map(item => this.normalizeBigInts(item)) as unknown as T;
      }

      const normalized: Record<string, unknown> = {};
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
