import type Database from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database.Database): void => {
    logger.debug('Running migration 011: Add packet log table...');

    // Create packet_log table
    db.exec(`
      CREATE TABLE IF NOT EXISTS packet_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        packet_id INTEGER,
        timestamp INTEGER NOT NULL,
        from_node INTEGER NOT NULL,
        from_node_id TEXT,
        to_node INTEGER,
        to_node_id TEXT,
        channel INTEGER,
        portnum INTEGER NOT NULL,
        portnum_name TEXT,
        encrypted BOOLEAN DEFAULT 0,
        snr REAL,
        rssi REAL,
        hop_limit INTEGER,
        hop_start INTEGER,
        payload_size INTEGER,
        want_ack BOOLEAN,
        priority INTEGER,
        payload_preview TEXT,
        metadata TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);

    logger.debug('✅ Created packet_log table');

    // Create indexes for efficient queries
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_packet_timestamp ON packet_log(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_packet_from ON packet_log(from_node);
      CREATE INDEX IF NOT EXISTS idx_packet_to ON packet_log(to_node);
      CREATE INDEX IF NOT EXISTS idx_packet_portnum ON packet_log(portnum);
      CREATE INDEX IF NOT EXISTS idx_packet_channel ON packet_log(channel);
      CREATE INDEX IF NOT EXISTS idx_packet_encrypted ON packet_log(encrypted);
    `);

    logger.debug('✅ Created packet_log indexes');

    // Add configuration settings for packet logging
    const now = Date.now();
    const insertSetting = db.prepare(`
      INSERT OR IGNORE INTO settings (key, value, createdAt, updatedAt)
      VALUES (?, ?, ?, ?)
    `);

    // Default: packet logging disabled (opt-in feature)
    insertSetting.run('packet_log_enabled', '0', now, now);
    // Default: keep max 1000 packets
    insertSetting.run('packet_log_max_count', '1000', now, now);
    // Default: keep packets for 24 hours
    insertSetting.run('packet_log_max_age_hours', '24', now, now);

    logger.debug('✅ Added packet log configuration settings');
    logger.debug('✅ Migration 011 completed successfully');
  },

  down: (db: Database.Database): void => {
    logger.debug('Reverting migration 011: Remove packet log table...');

    // Drop indexes
    db.exec('DROP INDEX IF EXISTS idx_packet_encrypted');
    db.exec('DROP INDEX IF EXISTS idx_packet_channel');
    db.exec('DROP INDEX IF EXISTS idx_packet_portnum');
    db.exec('DROP INDEX IF EXISTS idx_packet_to');
    db.exec('DROP INDEX IF EXISTS idx_packet_from');
    db.exec('DROP INDEX IF EXISTS idx_packet_timestamp');

    // Drop table
    db.exec('DROP TABLE IF EXISTS packet_log');

    // Remove settings
    db.exec("DELETE FROM settings WHERE key IN ('packet_log_enabled', 'packet_log_max_count', 'packet_log_max_age_hours')");

    logger.debug('✅ Migration 011 reverted');
  }
};
