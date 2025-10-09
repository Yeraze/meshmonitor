/**
 * Session Configuration
 *
 * Configures Express session with SQLite storage
 */

import session from 'express-session';
import connectSqlite3 from 'connect-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SqliteStore = connectSqlite3(session);

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
  }
}

/**
 * Get session configuration
 */
export function getSessionConfig(): session.SessionOptions {
  // Use DATABASE_PATH env var if set, otherwise fall back to NODE_ENV logic
  const dbPath = process.env.DATABASE_PATH || (
    process.env.NODE_ENV === 'production'
      ? '/data/meshmonitor.db'
      : path.join(__dirname, '../../../data/meshmonitor.db')
  );

  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    logger.warn('⚠️  SESSION_SECRET not set! Using insecure default. Set SESSION_SECRET in production!');
  }

  const sessionMaxAge = parseInt(process.env.SESSION_MAX_AGE || '86400000'); // Default 24 hours

  return {
    store: new SqliteStore({
      db: 'sessions.db',
      dir: path.dirname(dbPath),
      table: 'sessions'
    }),
    secret: sessionSecret || 'insecure-dev-secret-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: sessionMaxAge
    },
    name: 'meshmonitor.sid' // Custom session cookie name
  };
}
