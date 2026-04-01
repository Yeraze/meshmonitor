/**
 * Migration 018: Add per-channel and per-DM notification mute columns
 *
 * Adds two nullable TEXT columns to user_notification_preferences for storing
 * JSON-encoded mute rules per channel and per DM conversation.
 *
 * Schema:
 *   mutedChannels: JSON array of { channelId: number, muteUntil: number | null }
 *   mutedDMs:      JSON array of { nodeUuid: string,  muteUntil: number | null }
 *
 * muteUntil is a Unix timestamp in ms; null means muted indefinitely.
 * Expiry is evaluated at read-time — no server-side cron required.
 *
 * Implements: https://github.com/Yeraze/meshmonitor/issues/2545
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 018 (SQLite): Adding mute columns to user_notification_preferences...');

    try {
      db.exec('ALTER TABLE user_notification_preferences ADD COLUMN muted_channels TEXT');
      logger.debug('Added muted_channels column');
    } catch (e: any) {
      if (e.message?.includes('duplicate column')) {
        logger.debug('user_notification_preferences.muted_channels already exists, skipping');
      } else {
        logger.warn('Could not add muted_channels:', e.message);
      }
    }

    try {
      db.exec('ALTER TABLE user_notification_preferences ADD COLUMN muted_dms TEXT');
      logger.debug('Added muted_dms column');
    } catch (e: any) {
      if (e.message?.includes('duplicate column')) {
        logger.debug('user_notification_preferences.muted_dms already exists, skipping');
      } else {
        logger.warn('Could not add muted_dms:', e.message);
      }
    }

    logger.info('Migration 018 complete (SQLite): mute columns added');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 018 down: Not implemented (destructive column drops)');
  }
};

// ============ PostgreSQL ============

export async function runMigration018Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info('Running migration 018 (PostgreSQL): Adding mute columns to user_notification_preferences...');

  try {
    await client.query('ALTER TABLE user_notification_preferences ADD COLUMN IF NOT EXISTS "mutedChannels" TEXT');
    await client.query('ALTER TABLE user_notification_preferences ADD COLUMN IF NOT EXISTS "mutedDMs" TEXT');
    logger.debug('Ensured mutedChannels/mutedDMs exist on user_notification_preferences');
  } catch (error: any) {
    logger.error('Migration 018 (PostgreSQL) failed:', error.message);
    throw error;
  }

  logger.info('Migration 018 complete (PostgreSQL): mute columns added');
}

// ============ MySQL ============

export async function runMigration018Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info('Running migration 018 (MySQL): Adding mute columns to user_notification_preferences...');

  try {
    const [channelsRows] = await pool.query(`
      SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_notification_preferences' AND COLUMN_NAME = 'mutedChannels'
    `);
    if (!Array.isArray(channelsRows) || channelsRows.length === 0) {
      await pool.query('ALTER TABLE user_notification_preferences ADD COLUMN mutedChannels TEXT');
      logger.debug('Added mutedChannels to user_notification_preferences');
    } else {
      logger.debug('user_notification_preferences.mutedChannels already exists, skipping');
    }

    const [dmsRows] = await pool.query(`
      SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_notification_preferences' AND COLUMN_NAME = 'mutedDMs'
    `);
    if (!Array.isArray(dmsRows) || dmsRows.length === 0) {
      await pool.query('ALTER TABLE user_notification_preferences ADD COLUMN mutedDMs TEXT');
      logger.debug('Added mutedDMs to user_notification_preferences');
    } else {
      logger.debug('user_notification_preferences.mutedDMs already exists, skipping');
    }
  } catch (error: any) {
    logger.error('Migration 018 (MySQL) failed:', error.message);
    throw error;
  }

  logger.info('Migration 018 complete (MySQL): mute columns added');
}
