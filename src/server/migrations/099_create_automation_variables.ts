/**
 * Migration 099: Create automation_variables + automation_variable_values (#3653)
 *
 * User-defined variables for the Automation Engine (see AUTOMATION_ENGINE_PLAN §5.2).
 *
 *  - `automation_variables`: the variable DEFINITIONS. GLOBAL (no sourceId), like
 *    the automations table. `name` is a unique slug referenced as {{ var.name }}.
 *    `type` ∈ string|integer|float|boolean|flag. `scope` ∈ global|source|node|sourceNode.
 *    `readonly` marks user-set constants (thresholds) that automations may read but
 *    never write. `config` JSON holds { flagDurationSeconds?, defaultValue? }.
 *
 *  - `automation_variable_values`: the per-scope VALUES. `scopeKey` encodes the
 *    scope ('' global / sourceId / nodeNum / sourceId:nodeNum). `expiresAt` powers
 *    the flag auto-clear (anti-spam). Unique on (variableId, scopeKey).
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.debug('Migration 099: Creating automation_variables tables (SQLite)...');

    db.exec(`
      CREATE TABLE IF NOT EXISTS automation_variables (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        type TEXT NOT NULL,
        scope TEXT NOT NULL,
        readonly INTEGER NOT NULL DEFAULT 0,
        config TEXT NOT NULL DEFAULT '{}',
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS automation_variable_values (
        id TEXT PRIMARY KEY,
        variableId TEXT NOT NULL,
        scopeKey TEXT NOT NULL,
        value TEXT,
        expiresAt INTEGER,
        updatedAt INTEGER NOT NULL,
        UNIQUE (variableId, scopeKey)
      )
    `);

    db.exec('CREATE INDEX IF NOT EXISTS idx_automation_variable_values_variableId ON automation_variable_values (variableId)');

    logger.debug('Migration 099: automation_variables tables created (SQLite)');
  },

  down: (db: Database): void => {
    logger.debug('Migration 099 down: Dropping automation_variables tables (SQLite)...');
    db.exec('DROP TABLE IF EXISTS automation_variable_values');
    db.exec('DROP TABLE IF EXISTS automation_variables');
  }
};

// ============ PostgreSQL ============

export async function runMigration099Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info('Running migration 099 (PostgreSQL): Creating automation_variables tables...');

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS automation_variables (
        "id" TEXT PRIMARY KEY,
        "name" TEXT NOT NULL UNIQUE,
        "description" TEXT,
        "type" TEXT NOT NULL,
        "scope" TEXT NOT NULL,
        "readonly" BOOLEAN NOT NULL DEFAULT FALSE,
        "config" TEXT NOT NULL DEFAULT '{}',
        "createdAt" BIGINT NOT NULL,
        "updatedAt" BIGINT NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS automation_variable_values (
        "id" TEXT PRIMARY KEY,
        "variableId" TEXT NOT NULL,
        "scopeKey" TEXT NOT NULL,
        "value" TEXT,
        "expiresAt" BIGINT,
        "updatedAt" BIGINT NOT NULL,
        UNIQUE ("variableId", "scopeKey")
      )
    `);

    await client.query('CREATE INDEX IF NOT EXISTS idx_automation_variable_values_variableId ON automation_variable_values ("variableId")');

    logger.info('Migration 099 complete (PostgreSQL): automation_variables tables created');
  } catch (error: any) {
    logger.error('Failed to create automation_variables tables (PostgreSQL):', error.message);
    throw error;
  }
}

// ============ MySQL ============

export async function runMigration099Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info('Running migration 099 (MySQL): Creating automation_variables tables...');

  try {
    const [defRows] = await pool.query(`
      SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'automation_variables'
    `);
    if (!Array.isArray(defRows) || defRows.length === 0) {
      await pool.query(`
        CREATE TABLE automation_variables (
          id VARCHAR(36) PRIMARY KEY,
          name VARCHAR(255) NOT NULL UNIQUE,
          description TEXT,
          type VARCHAR(32) NOT NULL,
          scope VARCHAR(32) NOT NULL,
          \`readonly\` BOOLEAN NOT NULL DEFAULT FALSE,
          config LONGTEXT NOT NULL,
          createdAt BIGINT NOT NULL,
          updatedAt BIGINT NOT NULL
        )
      `);
    } else {
      logger.debug('automation_variables table already exists in MySQL, skipping');
    }

    const [valRows] = await pool.query(`
      SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'automation_variable_values'
    `);
    if (!Array.isArray(valRows) || valRows.length === 0) {
      await pool.query(`
        CREATE TABLE automation_variable_values (
          id VARCHAR(36) PRIMARY KEY,
          variableId VARCHAR(36) NOT NULL,
          scopeKey VARCHAR(255) NOT NULL,
          value LONGTEXT,
          expiresAt BIGINT,
          updatedAt BIGINT NOT NULL,
          UNIQUE KEY uniq_variable_scope (variableId, scopeKey),
          INDEX idx_automation_variable_values_variableId (variableId)
        )
      `);
    } else {
      logger.debug('automation_variable_values table already exists in MySQL, skipping');
    }

    logger.info('Migration 099 complete (MySQL): automation_variables tables created');
  } catch (error: any) {
    logger.error('Failed to create automation_variables tables (MySQL):', error.message);
    throw error;
  }
}
