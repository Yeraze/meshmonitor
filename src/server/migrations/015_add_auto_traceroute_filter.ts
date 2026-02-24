import Database from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database.Database): void => {
    logger.debug('Running migration 015: Add auto-traceroute node filter...');

    // Create table for storing which nodes should be auto-tracerouted
    db.exec(`
      CREATE TABLE IF NOT EXISTS auto_traceroute_nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nodeNum INTEGER NOT NULL UNIQUE,
        addedAt INTEGER NOT NULL,
        FOREIGN KEY (nodeNum) REFERENCES nodes(nodeNum) ON DELETE CASCADE
      );
    `);

    // Create index for fast lookups
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_auto_traceroute_nodes
      ON auto_traceroute_nodes(nodeNum);
    `);

    logger.debug('✅ Added auto_traceroute_nodes table and indexes');
  },

  down: (db: Database.Database): void => {
    logger.debug('Rolling back migration 015: Remove auto_traceroute_nodes table...');

    db.exec(`DROP TABLE IF EXISTS auto_traceroute_nodes;`);

    logger.debug('✅ Rolled back auto_traceroute_nodes table');
  }
};
