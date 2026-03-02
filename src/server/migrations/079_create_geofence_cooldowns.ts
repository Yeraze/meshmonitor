/**
 * Migration 079: Create geofence_cooldowns table
 *
 * Adds the geofence_cooldowns table for tracking per-node cooldown timestamps
 * for geofence triggers. This prevents trigger spam when nodes flicker in/out
 * of geofence boundaries.
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

/**
 * SQLite migration: Create geofence_cooldowns table
 */
export const migration = {
  up: (db: Database): void => {
    logger.debug('Migration 079: Creating geofence_cooldowns table (SQLite)...');
    db.exec(`
      CREATE TABLE IF NOT EXISTS geofence_cooldowns (
        triggerId TEXT NOT NULL,
        nodeNum INTEGER NOT NULL,
        firedAt INTEGER NOT NULL,
        PRIMARY KEY (triggerId, nodeNum)
      )
    `);
    logger.debug('Migration 079: geofence_cooldowns table created (SQLite)');
  },

  down: (db: Database): void => {
    logger.debug('Migration 079 down: Dropping geofence_cooldowns table (SQLite)...');
    db.exec('DROP TABLE IF EXISTS geofence_cooldowns');
    logger.debug('Migration 079 down: geofence_cooldowns table dropped (SQLite)');
  }
};

/**
 * PostgreSQL migration: Create geofence_cooldowns table
 */
export async function runMigration079Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info('Running migration 079 (PostgreSQL): Creating geofence_cooldowns table...');

  try {
    // Check if table already exists (idempotent)
    const result = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'geofence_cooldowns'
    `);

    if (result.rows.length > 0) {
      logger.debug('geofence_cooldowns table already exists in PostgreSQL, skipping');
      return;
    }

    await client.query(`
      CREATE TABLE geofence_cooldowns (
        "triggerId" TEXT NOT NULL,
        "nodeNum" BIGINT NOT NULL,
        "firedAt" BIGINT NOT NULL,
        PRIMARY KEY ("triggerId", "nodeNum")
      )
    `);

    logger.info('Migration 079 complete (PostgreSQL): geofence_cooldowns table created');
  } catch (error: any) {
    logger.error('Failed to create geofence_cooldowns table (PostgreSQL):', error.message);
    throw error;
  }
}

/**
 * MySQL migration: Create geofence_cooldowns table
 */
export async function runMigration079Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info('Running migration 079 (MySQL): Creating geofence_cooldowns table...');

  try {
    // Check if table already exists (idempotent)
    const [rows] = await pool.query(`
      SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'geofence_cooldowns'
    `);

    if (Array.isArray(rows) && rows.length > 0) {
      logger.debug('geofence_cooldowns table already exists in MySQL, skipping');
      return;
    }

    await pool.query(`
      CREATE TABLE geofence_cooldowns (
        triggerId VARCHAR(255) NOT NULL,
        nodeNum BIGINT NOT NULL,
        firedAt BIGINT NOT NULL,
        PRIMARY KEY (triggerId, nodeNum)
      )
    `);

    logger.info('Migration 079 complete (MySQL): geofence_cooldowns table created');
  } catch (error: any) {
    logger.error('Failed to create geofence_cooldowns table (MySQL):', error.message);
    throw error;
  }
}
