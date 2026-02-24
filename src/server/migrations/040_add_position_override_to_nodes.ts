/**
 * Migration 040: Add position override columns to nodes table
 *
 * Adds columns to allow users to manually override a node's position.
 * When enabled, this override takes precedence over GPS and estimated positions
 * for map display and distance calculations.
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database): void => {
    logger.debug('Running migration 040: Add position override columns to nodes table');

    try {
      // Check which columns already exist
      const columns = db.pragma("table_info('nodes')") as Array<{ name: string }>;
      const columnNames = new Set(columns.map((col) => col.name));

      // Add positionOverrideEnabled column
      if (!columnNames.has('positionOverrideEnabled')) {
        db.exec(`
          ALTER TABLE nodes ADD COLUMN positionOverrideEnabled INTEGER DEFAULT 0;
        `);
        logger.debug('✅ Added positionOverrideEnabled column to nodes table');
      } else {
        logger.debug('✅ positionOverrideEnabled column already exists, skipping');
      }

      // Add latitudeOverride column
      if (!columnNames.has('latitudeOverride')) {
        db.exec(`
          ALTER TABLE nodes ADD COLUMN latitudeOverride REAL;
        `);
        logger.debug('✅ Added latitudeOverride column to nodes table');
      } else {
        logger.debug('✅ latitudeOverride column already exists, skipping');
      }

      // Add longitudeOverride column
      if (!columnNames.has('longitudeOverride')) {
        db.exec(`
          ALTER TABLE nodes ADD COLUMN longitudeOverride REAL;
        `);
        logger.debug('✅ Added longitudeOverride column to nodes table');
      } else {
        logger.debug('✅ longitudeOverride column already exists, skipping');
      }

      // Add altitudeOverride column
      if (!columnNames.has('altitudeOverride')) {
        db.exec(`
          ALTER TABLE nodes ADD COLUMN altitudeOverride REAL;
        `);
        logger.debug('✅ Added altitudeOverride column to nodes table');
      } else {
        logger.debug('✅ altitudeOverride column already exists, skipping');
      }

      // Create index for efficient filtering of nodes with position override
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_nodes_position_override ON nodes(positionOverrideEnabled);
      `);
      logger.debug('✅ Created index on positionOverrideEnabled column');

      logger.debug('✅ Migration 040 completed: position override columns added to nodes table');
    } catch (error) {
      logger.error('❌ Migration 040 failed:', error);
      throw error;
    }
  },

  down: (_db: Database): void => {
    logger.debug('Running migration 040 down: Remove position override columns from nodes table');

    try {
      // SQLite doesn't support DROP COLUMN directly until version 3.35.0
      // For older versions, we'd need to recreate the table without the columns
      // But for this case, we'll just note that the columns can remain
      logger.debug('⚠️  Note: SQLite DROP COLUMN requires version 3.35.0+');
      logger.debug('⚠️  The position override columns will remain but will not be used');

      // For SQLite 3.35.0+, uncomment the following:
      // db.exec(`DROP INDEX IF EXISTS idx_nodes_position_override;`);
      // db.exec(`ALTER TABLE nodes DROP COLUMN positionOverrideEnabled;`);
      // db.exec(`ALTER TABLE nodes DROP COLUMN latitudeOverride;`);
      // db.exec(`ALTER TABLE nodes DROP COLUMN longitudeOverride;`);
      // db.exec(`ALTER TABLE nodes DROP COLUMN altitudeOverride;`);

      logger.debug('✅ Migration 040 rollback completed');
    } catch (error) {
      logger.error('❌ Migration 040 rollback failed:', error);
      throw error;
    }
  }
};
