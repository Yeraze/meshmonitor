/**
 * Migration 029: Add autoAckMessageDirect setting
 *
 * This migration adds a new setting to support different auto-acknowledgment
 * messages for direct connections (0 hops) vs multi-hop messages.
 *
 * The autoAckMessageDirect setting allows users to customize responses for
 * direct connections to include metrics like SNR and RSSI that are more
 * relevant for direct connections than hop counts.
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database): void => {
    logger.debug('Running migration 029: Add autoAckMessageDirect setting');

    try {
      // Add the autoAckMessageDirect setting if it doesn't exist
      // Default to empty string to indicate it should fall back to autoAckMessage
      const stmt = db.prepare(`
        INSERT OR IGNORE INTO settings (key, value)
        VALUES ('autoAckMessageDirect', '')
      `);

      stmt.run();

      logger.debug('Migration 029 completed successfully');
    } catch (error) {
      logger.error('Migration 029 failed:', error);
      throw error;
    }
  },

  down: (db: Database): void => {
    logger.debug('Running migration 029 down: Remove autoAckMessageDirect setting');

    try {
      const stmt = db.prepare(`DELETE FROM settings WHERE key = 'autoAckMessageDirect'`);
      stmt.run();

      logger.debug('Migration 029 down completed successfully');
    } catch (error) {
      logger.error('Migration 029 down failed:', error);
      throw error;
    }
  }
};

export default migration;
