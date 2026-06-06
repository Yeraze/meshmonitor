/**
 * Migration 080: Add low-battery voltage-threshold column
 *
 * Adds one column to user_notification_preferences supporting low-battery
 * alerts for MeshCore nodes, which report battery as a voltage (millivolts)
 * rather than a 0-100 percentage:
 *   lowBatteryVoltageThreshold: integer, default 3300 — alert when batteryMv < this
 *
 * The Meshtastic percentage threshold (lowBatteryThreshold, migration 076) is
 * left untouched. The monitored-node set is shared between both paths.
 *
 * Implements: https://github.com/Yeraze/meshmonitor/issues/3331
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 080 (SQLite): Adding low_battery_voltage_threshold to user_notification_preferences...');

    try {
      db.exec('ALTER TABLE user_notification_preferences ADD COLUMN low_battery_voltage_threshold INTEGER DEFAULT 3300');
      logger.debug('Added low_battery_voltage_threshold column');
    } catch (e: any) {
      if (e.message?.includes('duplicate column')) {
        logger.debug('user_notification_preferences.low_battery_voltage_threshold already exists, skipping');
      } else {
        logger.warn('Could not add low_battery_voltage_threshold:', e.message);
      }
    }

    logger.info('Migration 080 complete (SQLite): low-battery voltage threshold added');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 080 down: Not implemented (destructive column drops)');
  }
};

// ============ PostgreSQL ============

export async function runMigration080Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info('Running migration 080 (PostgreSQL): Adding low-battery voltage threshold to user_notification_preferences...');

  try {
    await client.query('ALTER TABLE user_notification_preferences ADD COLUMN IF NOT EXISTS "lowBatteryVoltageThreshold" INTEGER DEFAULT 3300');
    logger.debug('Ensured lowBatteryVoltageThreshold exists on user_notification_preferences');
  } catch (error: any) {
    logger.error('Migration 080 (PostgreSQL) failed:', error.message);
    throw error;
  }

  logger.info('Migration 080 complete (PostgreSQL): low-battery voltage threshold added');
}

// ============ MySQL ============

export async function runMigration080Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info('Running migration 080 (MySQL): Adding low-battery voltage threshold to user_notification_preferences...');

  try {
    const [rows] = await pool.query(`
      SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_notification_preferences' AND COLUMN_NAME = 'lowBatteryVoltageThreshold'
    `);
    if (!Array.isArray(rows) || rows.length === 0) {
      await pool.query('ALTER TABLE user_notification_preferences ADD COLUMN lowBatteryVoltageThreshold INT DEFAULT 3300');
      logger.debug('Added lowBatteryVoltageThreshold to user_notification_preferences');
    } else {
      logger.debug('user_notification_preferences.lowBatteryVoltageThreshold already exists, skipping');
    }
  } catch (error: any) {
    logger.error('Migration 080 (MySQL) failed:', error.message);
    throw error;
  }

  logger.info('Migration 080 complete (MySQL): low-battery voltage threshold added');
}
