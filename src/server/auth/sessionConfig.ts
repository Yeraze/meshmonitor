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

  const nodeEnv = process.env.NODE_ENV || 'development';

  const sessionMaxAge = parseInt(process.env.SESSION_MAX_AGE || '86400000'); // Default 24 hours

  // Determine cookie security settings
  // COOKIE_SECURE can override the NODE_ENV default
  let cookieSecure: boolean;
  if (process.env.COOKIE_SECURE !== undefined) {
    cookieSecure = process.env.COOKIE_SECURE === 'true';
    if (!cookieSecure && process.env.NODE_ENV === 'production') {
      logger.warn('⚠️  COOKIE_SECURE=false in production! Sessions will work over HTTP but are less secure. Use HTTPS if possible.');
    }
  } else {
    // Default behavior: secure in production, insecure in development
    cookieSecure = process.env.NODE_ENV === 'production';
  }

  // Determine sameSite setting
  // COOKIE_SAMESITE can override the NODE_ENV default
  let cookieSameSite: 'strict' | 'lax' | 'none';
  if (process.env.COOKIE_SAMESITE) {
    const sameSite = process.env.COOKIE_SAMESITE.toLowerCase();
    if (sameSite === 'strict' || sameSite === 'lax' || sameSite === 'none') {
      cookieSameSite = sameSite;
    } else {
      logger.warn(`⚠️  Invalid COOKIE_SAMESITE value: ${process.env.COOKIE_SAMESITE}. Using default.`);
      cookieSameSite = process.env.NODE_ENV === 'production' ? 'strict' : 'lax';
    }
  } else {
    // Default behavior: strict in production, lax in development
    cookieSameSite = process.env.NODE_ENV === 'production' ? 'strict' : 'lax';
  }

  // Create session database path
  const sessionDbPath = path.join(path.dirname(dbPath), 'sessions.db');
  const sessionDb = new Database(sessionDbPath);

  // Log configuration summary for troubleshooting
  logger.info('🔐 Session configuration:');
  logger.info(`   - Cookie secure: ${cookieSecure}`);
  logger.info(`   - Cookie sameSite: ${cookieSameSite}`);
  logger.info(`   - Environment: ${nodeEnv}`);

  // Warn about potential issues with secure cookies
  if (cookieSecure && nodeEnv !== 'production') {
    logger.warn('');
    logger.warn('═══════════════════════════════════════════════════════════');
    logger.warn('⚠️  COOKIE CONFIGURATION WARNING');
    logger.warn('═══════════════════════════════════════════════════════════');
    logger.warn('   Secure cookies are enabled but NODE_ENV is not "production".');
    logger.warn('   ');
    logger.warn('   If you\'re accessing via HTTP (not HTTPS), session cookies');
    logger.warn('   will NOT be sent by the browser, causing authentication to fail.');
    logger.warn('   ');
    logger.warn('   Solutions:');
    logger.warn('   1. Access the application via HTTPS');
    logger.warn('   2. Set COOKIE_SECURE=false for HTTP access (less secure)');
    logger.warn('   3. Set NODE_ENV=production only if using HTTPS');
    logger.warn('═══════════════════════════════════════════════════════════');
    logger.warn('');
  }

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
      secure: cookieSecure,
      sameSite: cookieSameSite,
      maxAge: sessionMaxAge
    },
    name: 'meshmonitor.sid' // Custom session cookie name
  };
}
