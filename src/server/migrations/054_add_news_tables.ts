/**
 * Migration 054: Add news cache and user news status tables
 *
 * Creates two new tables:
 * - news_cache: Stores the cached news feed from meshmonitor.org
 * - user_news_status: Tracks which news items each user has seen/dismissed
 *
 * This enables the News Popup feature that shows announcements to users.
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database): void => {
    logger.debug('Running migration 054: Add news tables');

    try {
      // Create news_cache table
      db.exec(`
        CREATE TABLE IF NOT EXISTS news_cache (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          feedData TEXT NOT NULL,
          fetchedAt INTEGER NOT NULL,
          sourceUrl TEXT NOT NULL
        )
      `);

      // Create user_news_status table
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_news_status (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          userId INTEGER NOT NULL,
          lastSeenNewsId TEXT,
          dismissedNewsIds TEXT,
          updatedAt INTEGER NOT NULL,
          FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
        )
      `);

      // Create index on userId for faster lookups
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_user_news_status_userId ON user_news_status(userId)
      `);

      logger.debug('Migration 054 completed: news tables created');
    } catch (error) {
      logger.error('Migration 054 failed:', error);
      throw error;
    }
  },

  down: (db: Database): void => {
    logger.debug('Running migration 054 down: Remove news tables');

    try {
      db.exec(`DROP TABLE IF EXISTS user_news_status`);
      db.exec(`DROP TABLE IF EXISTS news_cache`);

      logger.debug('Migration 054 rollback completed');
    } catch (error) {
      logger.error('Migration 054 rollback failed:', error);
      throw error;
    }
  }
};

/**
 * PostgreSQL migration: Add news tables
 */
export async function runMigration054Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.debug('Running migration 054 (PostgreSQL): Add news tables');

  try {
    // Check if news_cache table already exists
    const newsCacheExists = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'news_cache'
      )
    `);

    if (!newsCacheExists.rows[0].exists) {
      await client.query(`
        CREATE TABLE news_cache (
          id SERIAL PRIMARY KEY,
          "feedData" TEXT NOT NULL,
          "fetchedAt" BIGINT NOT NULL,
          "sourceUrl" TEXT NOT NULL
        )
      `);
      logger.debug('Created news_cache table');
    }

    // Check if user_news_status table already exists
    const userNewsStatusExists = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'user_news_status'
      )
    `);

    if (!userNewsStatusExists.rows[0].exists) {
      await client.query(`
        CREATE TABLE user_news_status (
          id SERIAL PRIMARY KEY,
          "userId" INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          "lastSeenNewsId" TEXT,
          "dismissedNewsIds" TEXT,
          "updatedAt" BIGINT NOT NULL
        )
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_user_news_status_userId ON user_news_status("userId")
      `);
      logger.debug('Created user_news_status table');
    }

    logger.debug('Migration 054 (PostgreSQL): news tables created');
  } catch (error) {
    logger.error('Migration 054 (PostgreSQL) failed:', error);
    throw error;
  }
}

/**
 * MySQL migration: Add news tables
 */
export async function runMigration054Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.debug('Running migration 054 (MySQL): Add news tables');

  try {
    const connection = await pool.getConnection();
    try {
      // Check if news_cache table exists
      const [newsCacheTables] = await connection.query(`
        SELECT TABLE_NAME FROM information_schema.tables
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'news_cache'
      `);

      if ((newsCacheTables as any[]).length === 0) {
        await connection.query(`
          CREATE TABLE news_cache (
            id INT AUTO_INCREMENT PRIMARY KEY,
            feedData TEXT NOT NULL,
            fetchedAt BIGINT NOT NULL,
            sourceUrl VARCHAR(512) NOT NULL
          )
        `);
        logger.debug('Created news_cache table');
      }

      // Check if user_news_status table exists
      const [userNewsStatusTables] = await connection.query(`
        SELECT TABLE_NAME FROM information_schema.tables
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'user_news_status'
      `);

      if ((userNewsStatusTables as any[]).length === 0) {
        await connection.query(`
          CREATE TABLE user_news_status (
            id INT AUTO_INCREMENT PRIMARY KEY,
            userId INT NOT NULL,
            lastSeenNewsId VARCHAR(128),
            dismissedNewsIds TEXT,
            updatedAt BIGINT NOT NULL,
            FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
          )
        `);

        await connection.query(`
          CREATE INDEX idx_user_news_status_userId ON user_news_status(userId)
        `);
        logger.debug('Created user_news_status table');
      }

      logger.debug('Migration 054 (MySQL): news tables created');
    } finally {
      connection.release();
    }
  } catch (error) {
    logger.error('Migration 054 (MySQL) failed:', error);
    throw error;
  }
}
