/**
 * SQLite Driver Configuration for Drizzle ORM
 * Uses better-sqlite3 for synchronous SQLite operations
 */
import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../schema/index.js';
import { logger } from '../../utils/logger.js';
import fs from 'fs';
import path from 'path';

export type SQLiteDatabase = BetterSQLite3Database<typeof schema>;

export interface SQLiteDriverOptions {
  databasePath: string;
  enableWAL?: boolean;
  enableForeignKeys?: boolean;
  busyTimeout?: number;
}

/**
 * Creates and configures a SQLite database connection using Drizzle ORM
 */
export function createSQLiteDriver(options: SQLiteDriverOptions): {
  db: SQLiteDatabase;
  rawDb: Database.Database;
  close: () => void;
} {
  const {
    databasePath,
    enableWAL = true,
    enableForeignKeys = true,
    busyTimeout = 5000,
  } = options;

  logger.debug(`[SQLite Driver] Initializing database at: ${databasePath}`);

  // Ensure database directory exists
  const dbDir = path.dirname(databasePath);
  if (!fs.existsSync(dbDir)) {
    logger.debug(`[SQLite Driver] Creating database directory: ${dbDir}`);
    fs.mkdirSync(dbDir, { recursive: true });
  }

  // Verify directory permissions
  try {
    fs.accessSync(dbDir, fs.constants.W_OK | fs.constants.R_OK);
    if (fs.existsSync(databasePath)) {
      fs.accessSync(databasePath, fs.constants.W_OK | fs.constants.R_OK);
    }
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    logger.error(`[SQLite Driver] Permission error: ${err.message}`);
    throw new Error(`Database directory access check failed: ${err.message}`);
  }

  // Create database connection
  const rawDb = new Database(databasePath);

  // Configure database pragmas
  if (enableWAL) {
    rawDb.pragma('journal_mode = WAL');
    logger.debug('[SQLite Driver] WAL mode enabled');
  }

  if (enableForeignKeys) {
    rawDb.pragma('foreign_keys = ON');
    logger.debug('[SQLite Driver] Foreign keys enabled');
  }

  rawDb.pragma(`busy_timeout = ${busyTimeout}`);
  logger.debug(`[SQLite Driver] Busy timeout set to ${busyTimeout}ms`);

  // Create Drizzle ORM instance
  const db = drizzle(rawDb, { schema });

  logger.info('[SQLite Driver] Database initialized successfully');

  return {
    db,
    rawDb,
    close: () => {
      logger.debug('[SQLite Driver] Closing database connection');
      rawDb.close();
    },
  };
}

/**
 * Get the database type identifier
 */
export function getSQLiteDriverType(): 'sqlite' {
  return 'sqlite';
}
