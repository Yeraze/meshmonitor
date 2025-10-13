/**
 * Session Configuration
 *
 * Configures Express session with SQLite storage
 */

import session from 'express-session';
import BetterSqlite3Store from 'better-sqlite3-session-store';
import Database from 'better-sqlite3';
import path from 'path';
import { logger } from '../../utils/logger.js';
import { getEnvironmentConfig } from '../config/environment.js';

const SqliteStore = BetterSqlite3Store(session);

// Extend session data type
declare module 'express-session' {
  interface SessionData {
    userId?: number;
    username?: string;
    authProvider?: 'local' | 'oidc';
    isAdmin?: boolean;
    // OIDC-specific fields
    oidcState?: string;
    oidcCodeVerifier?: string;
    oidcNonce?: string;
    // CSRF protection
    csrfToken?: string;
  }
}

/**
 * Get session configuration
 */
export function getSessionConfig(): session.SessionOptions {
  const env = getEnvironmentConfig();

  // Create session database path
  const sessionDbPath = path.join(path.dirname(env.databasePath), 'sessions.db');
  const sessionDb = new Database(sessionDbPath);

  // Log configuration summary for troubleshooting
  logger.info('🔐 Session configuration:');
  logger.info(`   - Cookie secure: ${env.cookieSecure}`);
  logger.info(`   - Cookie sameSite: ${env.cookieSameSite}`);
  logger.info(`   - Environment: ${env.nodeEnv}`);

  return {
    store: new SqliteStore({
      client: sessionDb,
      expired: {
        clear: true,
        intervalMs: 900000 // Clear expired sessions every 15 minutes
      }
    }),
    secret: env.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: env.cookieSecure,
      sameSite: env.cookieSameSite,
      maxAge: env.sessionMaxAge
    },
    name: 'meshmonitor.sid' // Custom session cookie name
  };
}
