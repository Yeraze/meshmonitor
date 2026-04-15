/**
 * Drizzle-backed Session Store
 *
 * Replaces SqliteSessionStore (which used a separate sessions.db file and raw SQL).
 * Delegates to DatabaseService, which uses Drizzle ORM against the main database.
 * Zero raw SQL — table creation handled by migration 001.
 *
 * Note: Existing SQLite deployments will lose their sessions.db contents on
 * upgrade. Users will need to re-login once. Sessions are transient, so this
 * is acceptable.
 */

import { Store } from 'express-session';
import type { SessionData } from 'express-session';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';

interface DrizzleSessionStoreOptions {
  /** Interval in ms between expired-session cleanup runs (default: 900000 = 15 min). Set 0 to disable. */
  clearInterval?: number;
}

export class DrizzleSessionStore extends Store {
  private clearTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: DrizzleSessionStoreOptions = {}) {
    super();
    const interval = options.clearInterval ?? 900_000;
    if (interval > 0) {
      this.clearTimer = setInterval(() => this.clearExpired(), interval);
      this.clearTimer.unref?.();
    }
  }

  get(sid: string, callback: (err?: Error | null, session?: SessionData | null) => void): void {
    databaseService.getSessionAsync(sid)
      .then(row => {
        if (!row) return callback(null, null);
        if (row.expire < Date.now()) {
          databaseService.deleteSessionAsync(sid).catch(() => {});
          return callback(null, null);
        }
        try {
          callback(null, JSON.parse(row.sess) as SessionData);
        } catch (err) {
          callback(err as Error);
        }
      })
      .catch(err => callback(err));
  }

  set(sid: string, session: SessionData, callback?: (err?: Error | null) => void): void {
    const maxAge = session.cookie?.maxAge ?? 86_400_000;
    const expire = Date.now() + maxAge;
    databaseService.setSessionAsync(sid, JSON.stringify(session), expire)
      .then(() => callback?.(null))
      .catch(err => callback?.(err));
  }

  destroy(sid: string, callback?: (err?: Error | null) => void): void {
    databaseService.deleteSessionAsync(sid)
      .then(() => callback?.(null))
      .catch(err => callback?.(err));
  }

  touch(sid: string, session: SessionData, callback?: (err?: Error | null) => void): void {
    // Re-save with extended expiry via set()
    this.set(sid, session, callback);
  }

  private async clearExpired(): Promise<void> {
    try {
      await databaseService.cleanupExpiredSessionsAsync();
    } catch (err) {
      logger.warn('Session cleanup error:', err);
    }
  }

  /** Stop the cleanup timer (for graceful shutdown) */
  close(): void {
    if (this.clearTimer) {
      clearInterval(this.clearTimer);
      this.clearTimer = null;
    }
  }
}
