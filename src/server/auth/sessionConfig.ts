/**
 * Session Configuration
 *
 * Configures Express session with database-appropriate storage.
 * Selects SQLite, PostgreSQL, or MySQL session store based on DATABASE_URL.
 */

import session from 'express-session';
import { createRequire } from 'node:module';
import { logger } from '../../utils/logger.js';
import { getEnvironmentConfig } from '../config/environment.js';
import { DrizzleSessionStore } from './sessionStore.js';
import { parseMySQLUrl } from '../../db/drivers/mysql.js';

// createRequire allows loading CJS modules (connect-pg-simple, express-mysql-session) from ESM
const require = createRequire(import.meta.url);

// Extend session data type
declare module 'express-session' {
  interface SessionData {
    userId?: number;
    username?: string;
    authProvider?: 'local' | 'oidc' | 'proxy';
    isAdmin?: boolean;
    // OIDC-specific fields
    oidcState?: string;
    oidcCodeVerifier?: string;
    oidcNonce?: string;
    // CSRF protection
    csrfToken?: string;
    // MFA pending verification
    pendingMfaUserId?: number;
  }
}

// Cached session middleware for sharing between Express and Socket.io
let sessionMiddleware: ReturnType<typeof session> | null = null;

/**
 * Create the appropriate session store based on the configured database type.
 */
function createSessionStore(): session.Store {
  const env = getEnvironmentConfig();
  const dbType = env.databaseType;

  if (dbType === 'postgres' && env.databaseUrl) {
    return createPostgresStore(env.databaseUrl);
  }

  if (dbType === 'mysql' && env.databaseUrl) {
    return createMySQLStore(env.databaseUrl, env.databasePath);
  }

  // Default: SQLite session store
  return createSqliteStore(env.databasePath);
}

/**
 * Create a PostgreSQL session store.
 */
function createPostgresStore(databaseUrl: string): session.Store {
  const connectPgSimple = require('connect-pg-simple');
  const pgSession = connectPgSimple(session);
  const pg = require('pg');
  const pool = new pg.Pool({ connectionString: databaseUrl });
  logger.info('🔐 Session store: PostgreSQL (connect-pg-simple)');
  return new pgSession({ pool, tableName: 'session', createTableIfMissing: true });
}

/**
 * Create a MySQL/MariaDB session store.
 */
function createMySQLStore(databaseUrl: string, databasePath: string): session.Store {
  const expressMySQLSession = require('express-mysql-session');
  const MySQLStore = expressMySQLSession(session);
  const parsed = parseMySQLUrl(databaseUrl);
  if (!parsed) {
    logger.error('Failed to parse MySQL DATABASE_URL for session store. Falling back to SQLite.');
    return createSqliteStore(databasePath);
  }
  logger.info('🔐 Session store: MySQL/MariaDB (express-mysql-session)');
  return new MySQLStore({
    host: parsed.host,
    port: parsed.port,
    user: parsed.user,
    password: parsed.password,
    database: parsed.database,
    clearExpired: true,
    checkExpirationInterval: 900000, // 15 minutes
    createDatabaseTable: true,
  });
}

/**
 * Create an SQLite session store backed by the main database via Drizzle.
 */
function createSqliteStore(_databasePath: string): session.Store {
  logger.info('🔐 Session store: SQLite (DrizzleSessionStore via main DB)');
  return new DrizzleSessionStore({ clearInterval: 900000 });
}

/**
 * Get session configuration
 */
export function getSessionConfig(): session.SessionOptions {
  const env = getEnvironmentConfig();

  const store = createSessionStore();

  // Log configuration summary for troubleshooting
  logger.info('🔐 Session configuration:');
  logger.info(`   - Cookie name: ${env.sessionCookieName}`);
  logger.info(`   - Session maxAge: ${env.sessionMaxAge}ms (${Math.round(env.sessionMaxAge / 3600000)}h)`);
  logger.info(`   - Session rolling: ${env.sessionRolling}`);
  logger.info(`   - Cookie secure: ${env.cookieSecure}`);
  logger.info(`   - Cookie sameSite: ${env.cookieSameSite}`);
  logger.info(`   - Environment: ${env.nodeEnv}`);

  // `secure: env.cookieSecure` is intentionally runtime-configurable so
  // installations running behind HTTP-terminating reverse proxies can still
  // keep sessions working. Operators deploying over HTTPS must set
  // COOKIE_SECURE=true — the environment loader emits a loud warning in
  // production when it is left unset. See src/server/config/environment.ts.
  return {
    store,
    secret: env.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: env.sessionRolling, // Reset session expiry on each request
    cookie: {
      httpOnly: true,
      secure: env.cookieSecure,
      sameSite: env.cookieSameSite,
      maxAge: env.sessionMaxAge
    },
    name: env.sessionCookieName // Custom session cookie name
  };
}

/**
 * Get the shared session middleware
 * Creates and caches the middleware on first call for sharing between Express and Socket.io
 */
export function getSessionMiddleware(): ReturnType<typeof session> {
  if (!sessionMiddleware) {
    sessionMiddleware = session(getSessionConfig());
  }
  return sessionMiddleware;
}
