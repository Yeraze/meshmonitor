/**
 * Migration 232: `notify_on_auto_trace` on `user_notification_preferences`.
 *
 * The per-(user, source) opt-in for alerts about AUTOMATIC MeshCore traces
 * and path discoveries (auto-pathfinding, scheduled traces, Automation
 * Engine). User-started traces still notify under `notify_on_traceroute`.
 * Defaults FALSE (4.17.3 review M3), so an upgrade sends nobody the
 * once-per-contact-per-day stream auto-pathfinding would otherwise cause.
 *
 * Pure additive, idempotent `ADD COLUMN` across SQLite / PostgreSQL / MySQL
 * via the shared helpers (full DDL).
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 232';
const TABLE = 'user_notification_preferences';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding notify_on_auto_trace to ${TABLE}...`);
    addColumnIfMissing(db, TABLE, 'notify_on_auto_trace', 'notify_on_auto_trace INTEGER DEFAULT 0');
    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration232Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding notifyOnAutoTrace to ${TABLE}...`);
  await addColumnIfMissingPostgres(client, TABLE, 'notifyOnAutoTrace', '"notifyOnAutoTrace" BOOLEAN DEFAULT FALSE');
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration232Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding notifyOnAutoTrace to ${TABLE}...`);
  await addColumnIfMissingMysql(pool, TABLE, 'notifyOnAutoTrace', 'notifyOnAutoTrace BOOLEAN DEFAULT FALSE');
  logger.info(`${LABEL} complete (MySQL)`);
}
