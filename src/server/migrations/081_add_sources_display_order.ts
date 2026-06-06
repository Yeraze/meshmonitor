/**
 * Migration 081: Add displayOrder column to sources
 *
 * Adds a single column to the sources table supporting user-controlled
 * reordering of the source list on the Unified View / Dashboard sidebar:
 *   displayOrder: integer, default 0 — lower values sort first
 *
 * Existing rows get 0 and fall back to createdAt ordering (the previous
 * implicit order) until a reorder writes explicit 1..N ranks. New sources
 * also default to 0, so they append after explicitly-ranked rows via the
 * createdAt tiebreak in SourcesRepository.getAllSources().
 *
 * Implements: https://github.com/Yeraze/meshmonitor/issues/3338
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 081 (SQLite): Adding displayOrder to sources...');

    try {
      db.exec('ALTER TABLE sources ADD COLUMN displayOrder INTEGER NOT NULL DEFAULT 0');
      logger.debug('Added displayOrder column to sources');
    } catch (e: any) {
      if (e.message?.includes('duplicate column')) {
        logger.debug('sources.displayOrder already exists, skipping');
      } else {
        logger.warn('Could not add displayOrder to sources:', e.message);
      }
    }

    logger.info('Migration 081 complete (SQLite): sources.displayOrder added');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 081 down: Not implemented (destructive column drops)');
  }
};

// ============ PostgreSQL ============

export async function runMigration081Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info('Running migration 081 (PostgreSQL): Adding displayOrder to sources...');

  try {
    await client.query('ALTER TABLE sources ADD COLUMN IF NOT EXISTS "displayOrder" INTEGER NOT NULL DEFAULT 0');
    logger.debug('Ensured displayOrder exists on sources');
  } catch (error: any) {
    logger.error('Migration 081 (PostgreSQL) failed:', error.message);
    throw error;
  }

  logger.info('Migration 081 complete (PostgreSQL): sources.displayOrder added');
}

// ============ MySQL ============

export async function runMigration081Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info('Running migration 081 (MySQL): Adding displayOrder to sources...');

  try {
    const [rows] = await pool.query(`
      SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sources' AND COLUMN_NAME = 'displayOrder'
    `);
    if (!Array.isArray(rows) || rows.length === 0) {
      await pool.query('ALTER TABLE sources ADD COLUMN displayOrder INT NOT NULL DEFAULT 0');
      logger.debug('Added displayOrder to sources');
    } else {
      logger.debug('sources.displayOrder already exists, skipping');
    }
  } catch (error: any) {
    logger.error('Migration 081 (MySQL) failed:', error.message);
    throw error;
  }

  logger.info('Migration 081 complete (MySQL): sources.displayOrder added');
}
