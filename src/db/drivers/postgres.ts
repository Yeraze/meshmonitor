/**
 * PostgreSQL Driver Configuration for Drizzle ORM
 * Uses pg (node-postgres) for async PostgreSQL operations
 */
import { Pool, PoolConfig } from 'pg';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../schema/index.js';
import { logger } from '../../utils/logger.js';

export type PostgresDatabase = NodePgDatabase<typeof schema>;

export interface PostgresDriverOptions {
  connectionString: string;
  maxConnections?: number;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
  ssl?: boolean | { rejectUnauthorized: boolean };
}

/**
 * Creates and configures a PostgreSQL database connection using Drizzle ORM
 */
export async function createPostgresDriver(options: PostgresDriverOptions): Promise<{
  db: PostgresDatabase;
  pool: Pool;
  close: () => Promise<void>;
}> {
  const {
    connectionString,
    maxConnections = 10,
    idleTimeoutMs = 30000,
    connectionTimeoutMs = 10000,
    ssl,
  } = options;

  logger.debug('[PostgreSQL Driver] Initializing database connection');

  // Parse connection string to hide password in logs
  const maskedUrl = connectionString.replace(/:[^:@]+@/, ':****@');
  logger.debug(`[PostgreSQL Driver] Connecting to: ${maskedUrl}`);

  // Create connection pool configuration
  const poolConfig: PoolConfig = {
    connectionString,
    max: maxConnections,
    idleTimeoutMillis: idleTimeoutMs,
    connectionTimeoutMillis: connectionTimeoutMs,
  };

  // Configure SSL if specified
  if (ssl !== undefined) {
    poolConfig.ssl = ssl;
    logger.debug(`[PostgreSQL Driver] SSL enabled: ${JSON.stringify(ssl)}`);
  }

  // Create connection pool
  const pool = new Pool(poolConfig);

  // Test the connection
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW() as now');
    logger.debug(`[PostgreSQL Driver] Connection test successful: ${result.rows[0].now}`);
    client.release();
  } catch (error: unknown) {
    const err = error as Error;
    logger.error(`[PostgreSQL Driver] Connection test failed: ${err.message}`);
    await pool.end();
    throw new Error(`PostgreSQL connection failed: ${err.message}`);
  }

  // Handle pool errors
  pool.on('error', (err) => {
    logger.error('[PostgreSQL Driver] Unexpected pool error:', err);
  });

  pool.on('connect', () => {
    logger.debug('[PostgreSQL Driver] New client connected to pool');
  });

  // Create Drizzle ORM instance
  const db = drizzle(pool, { schema });

  logger.info('[PostgreSQL Driver] Database initialized successfully');

  return {
    db,
    pool,
    close: async () => {
      logger.debug('[PostgreSQL Driver] Closing connection pool');
      await pool.end();
    },
  };
}

/**
 * Get the database type identifier
 */
export function getPostgresDriverType(): 'postgres' {
  return 'postgres';
}

/**
 * Parse a DATABASE_URL to extract components
 */
export function parsePostgresUrl(url: string): {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
} | null {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: parseInt(parsed.port || '5432', 10),
      database: parsed.pathname.slice(1), // Remove leading /
      user: parsed.username,
      password: parsed.password,
    };
  } catch {
    return null;
  }
}
