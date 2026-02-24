import type Database from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database.Database): void => {
    logger.debug('Running migration 041: Add auto-traceroute log table...');

    // Create auto_traceroute_log table to track automatic traceroute attempts
    db.exec(`
      CREATE TABLE IF NOT EXISTS auto_traceroute_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        to_node_num INTEGER NOT NULL,
        to_node_name TEXT,
        success INTEGER DEFAULT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
      )
    `);

    logger.debug('✅ Created auto_traceroute_log table');

    // Create index for efficient queries
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_auto_traceroute_timestamp ON auto_traceroute_log(timestamp DESC)
    `);

    logger.debug('✅ Created auto_traceroute_log index');
    logger.debug('✅ Migration 041 completed successfully');
  },

  down: (db: Database.Database): void => {
    logger.debug('Reverting migration 041: Remove auto-traceroute log table...');

    // Drop index
    db.exec('DROP INDEX IF EXISTS idx_auto_traceroute_timestamp');

    // Drop table
    db.exec('DROP TABLE IF EXISTS auto_traceroute_log');

    logger.debug('✅ Migration 041 reverted');
  }
};
