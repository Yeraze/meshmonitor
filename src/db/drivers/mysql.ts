/**
 * MySQL Driver Configuration for Drizzle ORM
 * Uses mysql2 for async MySQL/MariaDB operations
 */
import mysql from 'mysql2/promise';
import { drizzle, MySql2Database } from 'drizzle-orm/mysql2';
import * as schema from '../schema/index.js';
import { logger } from '../../utils/logger.js';

export type MySQLDatabase = MySql2Database<typeof schema>;

export interface MySQLDriverOptions {
  connectionString: string;
  maxConnections?: number;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
}

/**
 * Creates and configures a MySQL database connection using Drizzle ORM
 */
export async function createMySQLDriver(options: MySQLDriverOptions): Promise<{
  db: MySQLDatabase;
  pool: mysql.Pool;
  close: () => Promise<void>;
}> {
  const {
    connectionString,
    maxConnections = 10,
    idleTimeoutMs = 30000,
    connectionTimeoutMs = 10000,
  } = options;

  logger.debug('[MySQL Driver] Initializing database connection');

  // Parse connection string to hide password in logs
  const maskedUrl = connectionString.replace(/:[^:@]+@/, ':****@');
  logger.debug(`[MySQL Driver] Connecting to: ${maskedUrl}`);

  // Parse connection string
  const parsed = parseMySQLUrl(connectionString);
  if (!parsed) {
    throw new Error('Invalid MySQL connection string');
  }

  // Create connection pool
  const pool = mysql.createPool({
    host: parsed.host,
    port: parsed.port,
    user: parsed.user,
    password: parsed.password,
    database: parsed.database,
    connectionLimit: maxConnections,
    idleTimeout: idleTimeoutMs,
    connectTimeout: connectionTimeoutMs,
    waitForConnections: true,
    queueLimit: 0,
  });

  // Test the connection
  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.query('SELECT NOW() as now');
    const result = rows as Array<{ now: Date }>;
    logger.debug(`[MySQL Driver] Connection test successful: ${result[0].now}`);
    connection.release();
  } catch (error: unknown) {
    const err = error as Error;
    logger.error(`[MySQL Driver] Connection test failed: ${err.message}`);
    await pool.end();
    throw new Error(`MySQL connection failed: ${err.message}`);
  }

  // Create Drizzle ORM instance
  const db = drizzle(pool, { schema, mode: 'default' });

  logger.info('[MySQL Driver] Database initialized successfully');

  return {
    db,
    pool,
    close: async () => {
      logger.debug('[MySQL Driver] Closing connection pool');
      await pool.end();
    },
  };
}

/**
 * Get the database type identifier
 */
export function getMySQLDriverType(): 'mysql' {
  return 'mysql';
}

/**
 * Parse a MySQL URL to extract components
 * Supports both mysql:// and mariadb:// protocols
 */
export function parseMySQLUrl(url: string): {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
} | null {
  try {
    // Replace mysql:// or mariadb:// with a standard protocol for URL parsing
    const normalizedUrl = url.replace(/^(mysql|mariadb):\/\//, 'http://');
    const parsed = new URL(normalizedUrl);
    return {
      host: parsed.hostname,
      port: parseInt(parsed.port || '3306', 10),
      database: parsed.pathname.slice(1), // Remove leading /
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    };
  } catch {
    return null;
  }
}
