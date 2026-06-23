/**
 * Migration 098: Create automations + automation_runs tables (#3653)
 *
 * Foundation for the generic Automation Engine ("Advanced Mode"). Two tables:
 *
 *  - `automations`: the workflow definitions. GLOBAL (no sourceId) by design —
 *    an automation evaluates against events from every source, and a
 *    `condition.sourceFilter` block scopes it to a subset when desired. This is a
 *    deliberate exception to the per-source invariant (joins channel_database /
 *    estimated_positions). `config` holds the trigger/condition/action graph as
 *    JSON ({ version, nodes[], edges[] }).
 *
 *  - `automation_runs`: per-execution rows — an execution log in Phase 1a, and
 *    the persisted state store for stateful (waiting) runs in Phase 1b. `state`
 *    and `log` are JSON. `status` is one of
 *    pending|waiting|completed|failed|cancelled (Phase 1a only emits the
 *    terminal completed/failed).
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.debug('Migration 098: Creating automations + automation_runs tables (SQLite)...');

    db.exec(`
      CREATE TABLE IF NOT EXISTS automations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        enabled INTEGER NOT NULL DEFAULT 0,
        config TEXT NOT NULL DEFAULT '{}',
        createdByUserId INTEGER,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS automation_runs (
        id TEXT PRIMARY KEY,
        automationId TEXT NOT NULL,
        sourceId TEXT,
        status TEXT NOT NULL DEFAULT 'completed',
        state TEXT,
        triggerEvent TEXT,
        log TEXT,
        startedAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      )
    `);

    db.exec('CREATE INDEX IF NOT EXISTS idx_automation_runs_automationId ON automation_runs (automationId)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_automation_runs_status ON automation_runs (status)');

    logger.debug('Migration 098: automations + automation_runs tables created (SQLite)');
  },

  down: (db: Database): void => {
    logger.debug('Migration 098 down: Dropping automation tables (SQLite)...');
    db.exec('DROP TABLE IF EXISTS automation_runs');
    db.exec('DROP TABLE IF EXISTS automations');
  }
};

// ============ PostgreSQL ============

export async function runMigration098Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info('Running migration 098 (PostgreSQL): Creating automation tables...');

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS automations (
        "id" TEXT PRIMARY KEY,
        "name" TEXT NOT NULL,
        "description" TEXT,
        "enabled" BOOLEAN NOT NULL DEFAULT FALSE,
        "config" TEXT NOT NULL DEFAULT '{}',
        "createdByUserId" INTEGER,
        "createdAt" BIGINT NOT NULL,
        "updatedAt" BIGINT NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS automation_runs (
        "id" TEXT PRIMARY KEY,
        "automationId" TEXT NOT NULL,
        "sourceId" TEXT,
        "status" TEXT NOT NULL DEFAULT 'completed',
        "state" TEXT,
        "triggerEvent" TEXT,
        "log" TEXT,
        "startedAt" BIGINT NOT NULL,
        "updatedAt" BIGINT NOT NULL
      )
    `);

    await client.query('CREATE INDEX IF NOT EXISTS idx_automation_runs_automationId ON automation_runs ("automationId")');
    await client.query('CREATE INDEX IF NOT EXISTS idx_automation_runs_status ON automation_runs ("status")');

    logger.info('Migration 098 complete (PostgreSQL): automation tables created');
  } catch (error: any) {
    logger.error('Failed to create automation tables (PostgreSQL):', error.message);
    throw error;
  }
}

// ============ MySQL ============

export async function runMigration098Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info('Running migration 098 (MySQL): Creating automation tables...');

  try {
    const [autoRows] = await pool.query(`
      SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'automations'
    `);
    if (!Array.isArray(autoRows) || autoRows.length === 0) {
      await pool.query(`
        CREATE TABLE automations (
          id VARCHAR(36) PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          description TEXT,
          enabled BOOLEAN NOT NULL DEFAULT FALSE,
          config LONGTEXT NOT NULL,
          createdByUserId INT,
          createdAt BIGINT NOT NULL,
          updatedAt BIGINT NOT NULL
        )
      `);
    } else {
      logger.debug('automations table already exists in MySQL, skipping');
    }

    const [runRows] = await pool.query(`
      SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'automation_runs'
    `);
    if (!Array.isArray(runRows) || runRows.length === 0) {
      await pool.query(`
        CREATE TABLE automation_runs (
          id VARCHAR(36) PRIMARY KEY,
          automationId VARCHAR(36) NOT NULL,
          sourceId VARCHAR(255),
          status VARCHAR(32) NOT NULL DEFAULT 'completed',
          state LONGTEXT,
          triggerEvent LONGTEXT,
          log LONGTEXT,
          startedAt BIGINT NOT NULL,
          updatedAt BIGINT NOT NULL,
          INDEX idx_automation_runs_automationId (automationId),
          INDEX idx_automation_runs_status (status)
        )
      `);
    } else {
      logger.debug('automation_runs table already exists in MySQL, skipping');
    }

    logger.info('Migration 098 complete (MySQL): automation tables created');
  } catch (error: any) {
    logger.error('Failed to create automation tables (MySQL):', error.message);
    throw error;
  }
}
