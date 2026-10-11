/**
 * Migration 202: `notify_on_mention` on `user_notification_preferences`.
 *
 * The per-(user, source) opt-in for MeshCore mention alerts: a notification
 * when a channel message or room post names the source's own node as
 * `@[Name]`. Defaults FALSE like the other opt-in alerts, so an upgrade sends
 * nobody a new kind of notification.
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

const LABEL = 'Migration 202';
const TABLE = 'user_notification_preferences';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding notify_on_mention to ${TABLE}...`);
    addColumnIfMissing(db, TABLE, 'notify_on_mention', 'notify_on_mention INTEGER DEFAULT 0');
    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration202Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding notifyOnMention to ${TABLE}...`);
  await addColumnIfMissingPostgres(client, TABLE, 'notifyOnMention', '"notifyOnMention" BOOLEAN DEFAULT FALSE');
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration202Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding notifyOnMention to ${TABLE}...`);
  await addColumnIfMissingMysql(pool, TABLE, 'notifyOnMention', 'notifyOnMention BOOLEAN DEFAULT FALSE');
  logger.info(`${LABEL} complete (MySQL)`);
}
