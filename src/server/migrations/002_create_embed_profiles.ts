/**
 * Migration 078: Create embed_profiles table
 *
 * Adds the embed_profiles table for storing embeddable map configurations.
 * Each profile defines map settings, allowed channels, and CORS origins.
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

/**
 * SQLite migration: Create embed_profiles table
 */
export const migration = {
  up: (db: Database): void => {
    logger.debug('Migration 078: Creating embed_profiles table (SQLite)...');
    db.exec(`
      CREATE TABLE IF NOT EXISTS embed_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        channels TEXT NOT NULL DEFAULT '[]',
        tileset TEXT NOT NULL DEFAULT 'osm',
        defaultLat REAL NOT NULL DEFAULT 0,
        defaultLng REAL NOT NULL DEFAULT 0,
        defaultZoom INTEGER NOT NULL DEFAULT 10,
        showTooltips INTEGER NOT NULL DEFAULT 1,
        showPopups INTEGER NOT NULL DEFAULT 1,
        showLegend INTEGER NOT NULL DEFAULT 1,
        showPaths INTEGER NOT NULL DEFAULT 0,
        showNeighborInfo INTEGER NOT NULL DEFAULT 0,
        showMqttNodes INTEGER NOT NULL DEFAULT 1,
        pollIntervalSeconds INTEGER NOT NULL DEFAULT 30,
        allowedOrigins TEXT NOT NULL DEFAULT '[]',
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      )
    `);
    logger.debug('Migration 078: embed_profiles table created (SQLite)');
  },

  down: (db: Database): void => {
    logger.debug('Migration 078 down: Dropping embed_profiles table (SQLite)...');
    db.exec('DROP TABLE IF EXISTS embed_profiles');
    logger.debug('Migration 078 down: embed_profiles table dropped (SQLite)');
  }
};

/**
 * PostgreSQL migration: Create embed_profiles table
 */
export async function runMigration078Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info('Running migration 078 (PostgreSQL): Creating embed_profiles table...');

  try {
    // Check if table already exists (idempotent)
    const result = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'embed_profiles'
    `);

    if (result.rows.length > 0) {
      logger.debug('embed_profiles table already exists in PostgreSQL, skipping');
      return;
    }

    await client.query(`
      CREATE TABLE embed_profiles (
        "id" TEXT PRIMARY KEY,
        "name" TEXT NOT NULL,
        "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
        "channels" TEXT NOT NULL DEFAULT '[]',
        "tileset" TEXT NOT NULL DEFAULT 'osm',
        "defaultLat" REAL NOT NULL DEFAULT 0,
        "defaultLng" REAL NOT NULL DEFAULT 0,
        "defaultZoom" INTEGER NOT NULL DEFAULT 10,
        "showTooltips" BOOLEAN NOT NULL DEFAULT TRUE,
        "showPopups" BOOLEAN NOT NULL DEFAULT TRUE,
        "showLegend" BOOLEAN NOT NULL DEFAULT TRUE,
        "showPaths" BOOLEAN NOT NULL DEFAULT FALSE,
        "showNeighborInfo" BOOLEAN NOT NULL DEFAULT FALSE,
        "showMqttNodes" BOOLEAN NOT NULL DEFAULT TRUE,
        "pollIntervalSeconds" INTEGER NOT NULL DEFAULT 30,
        "allowedOrigins" TEXT NOT NULL DEFAULT '[]',
        "createdAt" BIGINT NOT NULL,
        "updatedAt" BIGINT NOT NULL
      )
    `);

    logger.info('Migration 078 complete (PostgreSQL): embed_profiles table created');
  } catch (error: any) {
    logger.error('Failed to create embed_profiles table (PostgreSQL):', error.message);
    throw error;
  }
}

/**
 * MySQL migration: Create embed_profiles table
 */
export async function runMigration078Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info('Running migration 078 (MySQL): Creating embed_profiles table...');

  try {
    // Check if table already exists (idempotent)
    const [rows] = await pool.query(`
      SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'embed_profiles'
    `);

    if (Array.isArray(rows) && rows.length > 0) {
      logger.debug('embed_profiles table already exists in MySQL, skipping');
      return;
    }

    await pool.query(`
      CREATE TABLE embed_profiles (
        id VARCHAR(36) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        channels TEXT NOT NULL,
        tileset VARCHAR(255) NOT NULL DEFAULT 'osm',
        defaultLat DOUBLE NOT NULL DEFAULT 0,
        defaultLng DOUBLE NOT NULL DEFAULT 0,
        defaultZoom INT NOT NULL DEFAULT 10,
        showTooltips BOOLEAN NOT NULL DEFAULT TRUE,
        showPopups BOOLEAN NOT NULL DEFAULT TRUE,
        showLegend BOOLEAN NOT NULL DEFAULT TRUE,
        showPaths BOOLEAN NOT NULL DEFAULT FALSE,
        showNeighborInfo BOOLEAN NOT NULL DEFAULT FALSE,
        showMqttNodes BOOLEAN NOT NULL DEFAULT TRUE,
        pollIntervalSeconds INT NOT NULL DEFAULT 30,
        allowedOrigins TEXT NOT NULL,
        createdAt BIGINT NOT NULL,
        updatedAt BIGINT NOT NULL
      )
    `);

    logger.info('Migration 078 complete (MySQL): embed_profiles table created');
  } catch (error: any) {
    logger.error('Failed to create embed_profiles table (MySQL):', error.message);
    throw error;
  }
}
