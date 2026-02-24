import Database from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database.Database): void => {
    logger.debug('Running migration 027: Add ackFromNode field to messages table...');

    // Add ackFromNode column to store who sent the ACK
    db.exec(`ALTER TABLE messages ADD COLUMN ackFromNode INTEGER;`);

    logger.debug('✅ Added ackFromNode field to messages table');
  },

  down: (db: Database.Database): void => {
    logger.debug('Rolling back migration 027: Remove ackFromNode field...');

    db.exec(`ALTER TABLE messages DROP COLUMN ackFromNode;`);

    logger.debug('✅ Rolled back ackFromNode field');
  }
};
