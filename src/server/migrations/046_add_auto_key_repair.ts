import type Database from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database.Database): void => {
    logger.debug('Running migration 046: Add auto key repair tables...');

    // Create auto_key_repair_state table to track repair progress per node
    db.exec(`
      CREATE TABLE IF NOT EXISTS auto_key_repair_state (
        nodeNum INTEGER PRIMARY KEY,
        attemptCount INTEGER DEFAULT 0,
        lastAttemptTime INTEGER,
        exhausted INTEGER DEFAULT 0,
        startedAt INTEGER NOT NULL
      )
    `);

    logger.debug('✅ Created auto_key_repair_state table');

    // Create auto_key_repair_log table to log repair attempts
    db.exec(`
      CREATE TABLE IF NOT EXISTS auto_key_repair_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        nodeNum INTEGER NOT NULL,
        nodeName TEXT,
        action TEXT NOT NULL,
        success INTEGER DEFAULT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
      )
    `);

    logger.debug('✅ Created auto_key_repair_log table');

    // Create index for efficient queries
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_auto_key_repair_log_timestamp ON auto_key_repair_log(timestamp DESC)
    `);

    logger.debug('✅ Created auto_key_repair_log index');
    logger.debug('✅ Migration 046 completed successfully');
  },

  down: (db: Database.Database): void => {
    logger.debug('Reverting migration 046: Remove auto key repair tables...');

    // Drop index
    db.exec('DROP INDEX IF EXISTS idx_auto_key_repair_log_timestamp');

    // Drop tables
    db.exec('DROP TABLE IF EXISTS auto_key_repair_log');
    db.exec('DROP TABLE IF EXISTS auto_key_repair_state');

    logger.debug('✅ Migration 046 reverted');
  }
};
