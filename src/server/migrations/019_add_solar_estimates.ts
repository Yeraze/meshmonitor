import type Database from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database.Database): void => {
    logger.debug('Running migration 019: Add solar estimates table...');

    // Create solar_estimates table
    // Stores forecast data from forecast.solar API
    // timestamp is unique - we'll use INSERT OR REPLACE to update existing estimates
    db.exec(`
      CREATE TABLE IF NOT EXISTS solar_estimates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL UNIQUE,
        watt_hours REAL NOT NULL,
        fetched_at INTEGER NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);

    logger.debug('✅ Created solar_estimates table');

    // Create indexes for efficient queries
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_solar_timestamp ON solar_estimates(timestamp);
      CREATE INDEX IF NOT EXISTS idx_solar_fetched_at ON solar_estimates(fetched_at DESC);
    `);

    logger.debug('✅ Created solar_estimates indexes');
    logger.debug('✅ Migration 019 completed successfully');
  },

  down: (db: Database.Database): void => {
    logger.debug('Reverting migration 019: Remove solar estimates table...');

    // Drop indexes
    db.exec('DROP INDEX IF EXISTS idx_solar_fetched_at');
    db.exec('DROP INDEX IF EXISTS idx_solar_timestamp');

    // Drop table
    db.exec('DROP TABLE IF EXISTS solar_estimates');

    logger.debug('✅ Migration 019 reverted');
  }
};
