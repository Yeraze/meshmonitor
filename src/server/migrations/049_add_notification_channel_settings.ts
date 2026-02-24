/**
 * Migration 049: Add missing notification channel settings columns
 *
 * This migration adds the enabledChannels, monitoredNodes, whitelist, and blacklist
 * columns to user_notification_preferences that were missing from the PostgreSQL
 * and MySQL CREATE TABLE statements.
 *
 * These columns exist in the Drizzle schema but were not included in the raw
 * SQL create statements, causing queries to fail on existing PostgreSQL/MySQL databases.
 */

import type Database from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database.Database): void => {
    logger.debug('Running migration 049: Add notification channel settings columns...');

    // SQLite: Check if columns exist and add them if not
    // SQLite column names are different (snake_case)
    const tableInfo = db.prepare("PRAGMA table_info(user_notification_preferences)").all() as Array<{ name: string }>;
    const existingColumns = new Set(tableInfo.map(col => col.name));

    // SQLite uses snake_case column names
    if (!existingColumns.has('enabled_channels')) {
      db.exec(`ALTER TABLE user_notification_preferences ADD COLUMN enabled_channels TEXT`);
      logger.debug('  Added enabled_channels column');
    }

    if (!existingColumns.has('monitored_nodes')) {
      db.exec(`ALTER TABLE user_notification_preferences ADD COLUMN monitored_nodes TEXT`);
      logger.debug('  Added monitored_nodes column');
    }

    if (!existingColumns.has('whitelist')) {
      db.exec(`ALTER TABLE user_notification_preferences ADD COLUMN whitelist TEXT`);
      logger.debug('  Added whitelist column');
    }

    if (!existingColumns.has('blacklist')) {
      db.exec(`ALTER TABLE user_notification_preferences ADD COLUMN blacklist TEXT`);
      logger.debug('  Added blacklist column');
    }

    logger.debug('Migration 049 completed successfully');
  },

  down: (_db: Database.Database): void => {
    logger.debug('Reverting migration 049: No-op (SQLite does not support DROP COLUMN easily)');
    // No-op: removing these columns is complex and unnecessary
  }
};

/**
 * PostgreSQL migration: Add missing notification channel settings columns
 */
export async function runMigration049Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.debug('Running migration 049 (PostgreSQL): Add notification channel settings columns');

  try {
    // Check which columns already exist
    const checkResult = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'user_notification_preferences'
        AND column_name IN ('enabledChannels', 'monitoredNodes', 'whitelist', 'blacklist')
    `);

    const existingColumns = new Set(checkResult.rows.map(r => r.column_name));

    // Add missing columns
    if (!existingColumns.has('enabledChannels')) {
      await client.query(`ALTER TABLE user_notification_preferences ADD COLUMN "enabledChannels" TEXT`);
      logger.debug('  Added enabledChannels column');
    }

    if (!existingColumns.has('monitoredNodes')) {
      await client.query(`ALTER TABLE user_notification_preferences ADD COLUMN "monitoredNodes" TEXT`);
      logger.debug('  Added monitoredNodes column');
    }

    if (!existingColumns.has('whitelist')) {
      await client.query(`ALTER TABLE user_notification_preferences ADD COLUMN whitelist TEXT`);
      logger.debug('  Added whitelist column');
    }

    if (!existingColumns.has('blacklist')) {
      await client.query(`ALTER TABLE user_notification_preferences ADD COLUMN blacklist TEXT`);
      logger.debug('  Added blacklist column');
    }

    logger.debug('Migration 049 (PostgreSQL) complete');
  } catch (error) {
    logger.error('Migration 049 (PostgreSQL) failed:', error);
    throw error;
  }
}

/**
 * MySQL migration: Add missing notification channel settings columns
 */
export async function runMigration049Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.debug('Running migration 049 (MySQL): Add notification channel settings columns');

  try {
    const connection = await pool.getConnection();
    try {
      // Check which columns already exist
      const [columns] = await connection.query(`
        SELECT COLUMN_NAME
        FROM information_schema.columns
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'user_notification_preferences'
          AND COLUMN_NAME IN ('enabledChannels', 'monitoredNodes', 'whitelist', 'blacklist')
      `);

      const existingColumns = new Set((columns as Array<{ COLUMN_NAME: string }>).map(r => r.COLUMN_NAME));

      // Add missing columns
      if (!existingColumns.has('enabledChannels')) {
        await connection.query(`ALTER TABLE user_notification_preferences ADD COLUMN enabledChannels TEXT`);
        logger.debug('  Added enabledChannels column');
      }

      if (!existingColumns.has('monitoredNodes')) {
        await connection.query(`ALTER TABLE user_notification_preferences ADD COLUMN monitoredNodes TEXT`);
        logger.debug('  Added monitoredNodes column');
      }

      if (!existingColumns.has('whitelist')) {
        await connection.query(`ALTER TABLE user_notification_preferences ADD COLUMN whitelist TEXT`);
        logger.debug('  Added whitelist column');
      }

      if (!existingColumns.has('blacklist')) {
        await connection.query(`ALTER TABLE user_notification_preferences ADD COLUMN blacklist TEXT`);
        logger.debug('  Added blacklist column');
      }

      logger.debug('Migration 049 (MySQL) complete');
    } finally {
      connection.release();
    }
  } catch (error) {
    logger.error('Migration 049 (MySQL) failed:', error);
    throw error;
  }
}
