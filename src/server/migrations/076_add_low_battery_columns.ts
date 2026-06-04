/**
 * Migration 076: Add low-battery notification columns
 *
 * Adds two columns to user_notification_preferences supporting per-user
 * low-battery alerts for monitored nodes:
 *   notifyOnLowBattery:  boolean, default false — toggles the alert
 *   lowBatteryThreshold: integer, default 20    — alert when batteryLevel < this %
 *
 * The set of monitored nodes is shared with the inactive-node feature
 * (monitored_nodes column). Only applies to Meshtastic nodes, which report
 * batteryLevel as a 0-100 percentage.
 *
 * Implements: https://github.com/Yeraze/meshmonitor/issues/3305
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 076 (SQLite): Adding low-battery columns to user_notification_preferences...');

    try {
      db.exec('ALTER TABLE user_notification_preferences ADD COLUMN notify_on_low_battery INTEGER DEFAULT 0');
      logger.debug('Added notify_on_low_battery column');
    } catch (e: any) {
      if (e.message?.includes('duplicate column')) {
        logger.debug('user_notification_preferences.notify_on_low_battery already exists, skipping');
      } else {
        logger.warn('Could not add notify_on_low_battery:', e.message);
      }
    }

    try {
      db.exec('ALTER TABLE user_notification_preferences ADD COLUMN low_battery_threshold INTEGER DEFAULT 20');
      logger.debug('Added low_battery_threshold column');
    } catch (e: any) {
      if (e.message?.includes('duplicate column')) {
        logger.debug('user_notification_preferences.low_battery_threshold already exists, skipping');
      } else {
        logger.warn('Could not add low_battery_threshold:', e.message);
      }
    }

    logger.info('Migration 076 complete (SQLite): low-battery columns added');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 076 down: Not implemented (destructive column drops)');
  }
};

// ============ PostgreSQL ============

export async function runMigration076Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info('Running migration 076 (PostgreSQL): Adding low-battery columns to user_notification_preferences...');

  try {
    await client.query('ALTER TABLE user_notification_preferences ADD COLUMN IF NOT EXISTS "notifyOnLowBattery" BOOLEAN DEFAULT FALSE');
    await client.query('ALTER TABLE user_notification_preferences ADD COLUMN IF NOT EXISTS "lowBatteryThreshold" INTEGER DEFAULT 20');
    logger.debug('Ensured notifyOnLowBattery/lowBatteryThreshold exist on user_notification_preferences');
  } catch (error: any) {
    logger.error('Migration 076 (PostgreSQL) failed:', error.message);
    throw error;
  }

  logger.info('Migration 076 complete (PostgreSQL): low-battery columns added');
}

// ============ MySQL ============

export async function runMigration076Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info('Running migration 076 (MySQL): Adding low-battery columns to user_notification_preferences...');

  try {
    const [notifyRows] = await pool.query(`
      SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_notification_preferences' AND COLUMN_NAME = 'notifyOnLowBattery'
    `);
    if (!Array.isArray(notifyRows) || notifyRows.length === 0) {
      await pool.query('ALTER TABLE user_notification_preferences ADD COLUMN notifyOnLowBattery BOOLEAN DEFAULT FALSE');
      logger.debug('Added notifyOnLowBattery to user_notification_preferences');
    } else {
      logger.debug('user_notification_preferences.notifyOnLowBattery already exists, skipping');
    }

    const [thresholdRows] = await pool.query(`
      SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_notification_preferences' AND COLUMN_NAME = 'lowBatteryThreshold'
    `);
    if (!Array.isArray(thresholdRows) || thresholdRows.length === 0) {
      await pool.query('ALTER TABLE user_notification_preferences ADD COLUMN lowBatteryThreshold INT DEFAULT 20');
      logger.debug('Added lowBatteryThreshold to user_notification_preferences');
    } else {
      logger.debug('user_notification_preferences.lowBatteryThreshold already exists, skipping');
    }
  } catch (error: any) {
    logger.error('Migration 076 (MySQL) failed:', error.message);
    throw error;
  }

  logger.info('Migration 076 complete (MySQL): low-battery columns added');
}
