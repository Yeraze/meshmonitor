/**
 * Custom SQLite Session Store
 *
 * MIT-licensed replacement for better-sqlite3-session-store (GPL-3.0).
 * Implements the express-session Store interface using better-sqlite3 directly.
 */

import { Store } from 'express-session';
import type { SessionData } from 'express-session';
import Database from 'better-sqlite3';

interface SqliteSessionStoreOptions {
  /** better-sqlite3 database instance */
  db: Database.Database;
  /** Interval in ms to clear expired sessions (default: 900000 = 15 min) */
  clearInterval?: number;
}

export class SqliteSessionStore extends Store {
  private db: Database.Database;
  private clearTimer: ReturnType<typeof setInterval> | null = null;

  // Prepared statements for performance
  private stmtGet: Database.Statement;
  private stmtSet: Database.Statement;
  private stmtDestroy: Database.Statement;
  private stmtTouch: Database.Statement;
  private stmtClear: Database.Statement;

  constructor(options: SqliteSessionStoreOptions) {
    super();
    this.db = options.db;

    // Migrate from old better-sqlite3-session-store schema if needed.
    // The old store used different column names; drop and recreate since sessions are transient.
    this.migrateSchema();

    // Create sessions table if it doesn't exist
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expired INTEGER NOT NULL
      )
    `);

    // Create index on expired for cleanup queries
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_expired ON sessions (expired)
    `);

    // Prepare statements
    this.stmtGet = this.db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expired > ?');
    this.stmtSet = this.db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expired) VALUES (?, ?, ?)');
    this.stmtDestroy = this.db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.stmtTouch = this.db.prepare('UPDATE sessions SET expired = ? WHERE sid = ?');
    this.stmtClear = this.db.prepare('DELETE FROM sessions WHERE expired <= ?');

    // Start periodic cleanup
    const interval = options.clearInterval ?? 900000;
    if (interval > 0) {
      this.clearTimer = setInterval(() => this.clearExpired(), interval);
      // Don't prevent process exit
      if (this.clearTimer.unref) {
        this.clearTimer.unref();
      }
    }
  }

  get(sid: string, callback: (err?: Error | null, session?: SessionData | null) => void): void {
    try {
      const row = this.stmtGet.get(sid, Date.now()) as { sess: string } | undefined;
      if (row) {
        callback(null, JSON.parse(row.sess));
      } else {
        callback(null, null);
      }
    } catch (err) {
      callback(err as Error);
    }
  }

  set(sid: string, session: SessionData, callback?: (err?: Error | null) => void): void {
    try {
      const maxAge = session.cookie?.maxAge ?? 86400000; // Default 24h
      const expired = Date.now() + maxAge;
      this.stmtSet.run(sid, JSON.stringify(session), expired);
      callback?.(null);
    } catch (err) {
      callback?.(err as Error);
    }
  }

  destroy(sid: string, callback?: (err?: Error | null) => void): void {
    try {
      this.stmtDestroy.run(sid);
      callback?.(null);
    } catch (err) {
      callback?.(err as Error);
    }
  }

  touch(sid: string, session: SessionData, callback?: (err?: Error | null) => void): void {
    try {
      const maxAge = session.cookie?.maxAge ?? 86400000;
      const expired = Date.now() + maxAge;
      this.stmtTouch.run(expired, sid);
      callback?.(null);
    } catch (err) {
      callback?.(err as Error);
    }
  }

  /**
   * Handle migration from old better-sqlite3-session-store schema.
   * The old store created a 'sessions' table with different columns.
   * Since sessions are transient, we simply drop and let the new schema be created.
   */
  private migrateSchema(): void {
    try {
      const tableInfo = this.db.pragma('table_info(sessions)') as Array<{ name: string }>;
      if (tableInfo.length > 0) {
        const columns = tableInfo.map(col => col.name);
        // Our schema uses: sid, sess, expired
        // Old schema used different column names (e.g., id, data, expires)
        if (!columns.includes('sid') || !columns.includes('sess') || !columns.includes('expired')) {
          this.db.exec('DROP TABLE sessions');
        }
      }
    } catch {
      // If we can't check, the CREATE TABLE IF NOT EXISTS will handle it
    }
  }

  private clearExpired(): void {
    try {
      this.stmtClear.run(Date.now());
    } catch {
      // Silently ignore cleanup errors
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
