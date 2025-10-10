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
  }
}

/**
 * Get session configuration
 */
export function getSessionConfig(): session.SessionOptions {
  // Use DATABASE_PATH env var if set, otherwise default to /data/meshmonitor.db
  const dbPath = process.env.DATABASE_PATH || '/data/meshmonitor.db';

  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    logger.warn('⚠️  SESSION_SECRET not set! Using insecure default. Set SESSION_SECRET in production!');
  }

  const sessionMaxAge = parseInt(process.env.SESSION_MAX_AGE || '86400000'); // Default 24 hours

  // Create session database path
  const sessionDbPath = path.join(path.dirname(dbPath), 'sessions.db');
  const sessionDb = new Database(sessionDbPath);

  return {
    store: new SqliteStore({
      client: sessionDb,
      expired: {
        clear: true,
        intervalMs: 900000 // Clear expired sessions every 15 minutes
      }
    }),
    secret: sessionSecret || 'insecure-dev-secret-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
      maxAge: sessionMaxAge
    },
    name: 'meshmonitor.sid' // Custom session cookie name
  };
}
