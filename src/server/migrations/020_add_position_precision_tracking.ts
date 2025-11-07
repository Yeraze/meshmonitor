/**
 * Migration 020: Add position precision tracking
 *
 * Adds fields to track position precision metadata including:
 * - Which channel the position came from
 * - Precision bits (0-32, higher = more precise)
 * - GPS accuracy metrics (HDOP, accuracy in meters)
 * - Position update timestamp for smart upgrade/downgrade logic
 *
 * This enables the system to prefer high-precision positions from secondary
 * channels over approximate positions from the primary channel, and only
 * downgrade to lower precision if no update received in 12 hours.
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database): void => {
    logger.debug('Running migration 020: Add position precision tracking');

    try {
      // Check which columns already exist in nodes table
      const nodeColumns = db.pragma("table_info('nodes')") as Array<{ name: string }>;
      const existingNodeColumns = new Set(nodeColumns.map((col) => col.name));

      // Add position precision fields to nodes table
      const nodeColumnsToAdd = [
        { name: 'positionChannel', sql: 'ALTER TABLE nodes ADD COLUMN positionChannel INTEGER;' },
        { name: 'positionPrecisionBits', sql: 'ALTER TABLE nodes ADD COLUMN positionPrecisionBits INTEGER;' },
        { name: 'positionGpsAccuracy', sql: 'ALTER TABLE nodes ADD COLUMN positionGpsAccuracy REAL;' },
        { name: 'positionHdop', sql: 'ALTER TABLE nodes ADD COLUMN positionHdop REAL;' },
        { name: 'positionTimestamp', sql: 'ALTER TABLE nodes ADD COLUMN positionTimestamp INTEGER;' },
      ];

      for (const column of nodeColumnsToAdd) {
        if (!existingNodeColumns.has(column.name)) {
          db.exec(column.sql);
          logger.debug(`✅ Added ${column.name} column to nodes table`);
        } else {
          logger.debug(`✅ ${column.name} column already exists in nodes table, skipping`);
        }
      }

      // Check which columns already exist in telemetry table
      const telemetryColumns = db.pragma("table_info('telemetry')") as Array<{ name: string }>;
      const existingTelemetryColumns = new Set(telemetryColumns.map((col) => col.name));

      // Add metadata fields to telemetry table for tracking position precision history
      const telemetryColumnsToAdd = [
        { name: 'channel', sql: 'ALTER TABLE telemetry ADD COLUMN channel INTEGER;' },
        { name: 'precisionBits', sql: 'ALTER TABLE telemetry ADD COLUMN precisionBits INTEGER;' },
        { name: 'gpsAccuracy', sql: 'ALTER TABLE telemetry ADD COLUMN gpsAccuracy REAL;' },
      ];

      for (const column of telemetryColumnsToAdd) {
        if (!existingTelemetryColumns.has(column.name)) {
          db.exec(column.sql);
          logger.debug(`✅ Added ${column.name} column to telemetry table`);
        } else {
          logger.debug(`✅ ${column.name} column already exists in telemetry table, skipping`);
        }
      }

      logger.debug('✅ Migration 020 completed: Position precision tracking fields added');
    } catch (error) {
      logger.error('❌ Migration 020 failed:', error);
      throw error;
    }
  },

  down: (_db: Database): void => {
    logger.debug('Running migration 020 down: Remove position precision tracking fields');

    try {
      // Note: SQLite doesn't support DROP COLUMN directly until version 3.35.0
      // For older versions, the columns will remain but will not be used
      logger.debug('⚠️  Note: SQLite DROP COLUMN requires version 3.35.0+');
      logger.debug('⚠️  Position precision tracking columns will remain but will not be used');

      // For SQLite 3.35.0+, uncomment the following:
      /*
      db.exec(`
        ALTER TABLE nodes DROP COLUMN positionChannel;
        ALTER TABLE nodes DROP COLUMN positionPrecisionBits;
        ALTER TABLE nodes DROP COLUMN positionGpsAccuracy;
        ALTER TABLE nodes DROP COLUMN positionHdop;
        ALTER TABLE nodes DROP COLUMN positionTimestamp;
        ALTER TABLE telemetry DROP COLUMN channel;
        ALTER TABLE telemetry DROP COLUMN precisionBits;
        ALTER TABLE telemetry DROP COLUMN gpsAccuracy;
      `);
      */

      logger.debug('✅ Migration 020 rollback completed');
    } catch (error) {
      logger.error('❌ Migration 020 rollback failed:', error);
      throw error;
    }
  }
};
