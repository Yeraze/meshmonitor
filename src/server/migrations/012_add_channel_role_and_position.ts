import type Database from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database.Database): void => {
    logger.debug('Running migration 012: Add role and positionPrecision to channels table...');

    // Add role column (0=Disabled, 1=Primary, 2=Secondary)
    try {
      db.exec(`
        ALTER TABLE channels ADD COLUMN role INTEGER DEFAULT NULL;
      `);
      logger.debug('✅ Added role column to channels table');
    } catch (error: any) {
      if (error.message && error.message.includes('duplicate column name')) {
        logger.debug('⏭️  role column already exists, skipping');
      } else {
        throw error;
      }
    }

    // Add positionPrecision column (Location precision bits 0-32)
    try {
      db.exec(`
        ALTER TABLE channels ADD COLUMN positionPrecision INTEGER DEFAULT NULL;
      `);
      logger.debug('✅ Added positionPrecision column to channels table');
    } catch (error: any) {
      if (error.message && error.message.includes('duplicate column name')) {
        logger.debug('⏭️  positionPrecision column already exists, skipping');
      } else {
        throw error;
      }
    }

    logger.debug('✅ Migration 012 completed successfully');
    logger.debug('ℹ️  Note: Role and position precision will be synced from the Meshtastic device');
  },

  down: (db: Database.Database): void => {
    logger.debug('Reverting migration 012: Remove role and positionPrecision from channels table...');

    // SQLite doesn't support DROP COLUMN in older versions, so we recreate the table
    db.exec(`
      CREATE TABLE channels_backup (
        id INTEGER PRIMARY KEY,
        name TEXT,
        psk TEXT,
        uplinkEnabled BOOLEAN DEFAULT 1,
        downlinkEnabled BOOLEAN DEFAULT 1,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
    `);

    db.exec(`
      INSERT INTO channels_backup (id, name, psk, uplinkEnabled, downlinkEnabled, createdAt, updatedAt)
      SELECT id, name, psk, uplinkEnabled, downlinkEnabled, createdAt, updatedAt FROM channels;
    `);

    db.exec('DROP TABLE channels');
    db.exec('ALTER TABLE channels_backup RENAME TO channels');

    logger.debug('✅ Migration 012 reverted');
  }
};
