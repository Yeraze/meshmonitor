/**
 * Migration 243: drop the MySQL single-column UNIQUE on
 * `user_notification_preferences.userId` that 051 missed.
 *
 * The MySQL baseline declared `userId INT NOT NULL UNIQUE`, which MySQL names
 * `userId`. 051 only dropped `idx_user_notification_preferences_userId`, so a
 * database built from the baseline kept a one-row-per-user limit and could not
 * hold per-source preference rows. SQLite and PostgreSQL are not affected.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (_db: Database): void => {
    // SQLite and PostgreSQL never had this index.
  },
};

export async function runMigration243Postgres(_client: unknown): Promise<void> {
  // No-op.
}

export async function runMigration243Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  const [tables] = await pool.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_notification_preferences'`,
  );
  if (!Array.isArray(tables) || tables.length === 0) return;

  // Unique, non-primary indexes made of exactly the one column `userId`.
  const [rows] = await pool.query(
    `SELECT INDEX_NAME FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_notification_preferences'
       AND NON_UNIQUE = 0 AND INDEX_NAME <> 'PRIMARY'
     GROUP BY INDEX_NAME
     HAVING COUNT(*) = 1 AND MAX(COLUMN_NAME) = 'userId'`,
  );
  for (const row of rows as Array<{ INDEX_NAME: string }>) {
    // The users FK needs an index on userId, so swap in a plain one atomically.
    await pool.query(
      `ALTER TABLE user_notification_preferences
         ADD INDEX idx_user_notification_preferences_userId_plain (userId),
         DROP INDEX \`${row.INDEX_NAME}\``,
    );
    logger.info(`Migration 243 (MySQL): dropped single-column unique index ${row.INDEX_NAME}`);
  }
}
