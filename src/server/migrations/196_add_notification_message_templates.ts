/**
 * Migration 196: message-notification templates on
 * `user_notification_preferences` (#5593). PER-USER and PER-SOURCE, like the
 * table (one row per (userId, sourceId)).
 *
 * Two nullable text columns hold a user's own `{{ token }}` templates for the
 * title and body of a new-message notification:
 *
 *   SQLite              message_title_template / message_body_template
 *   PostgreSQL / MySQL  messageTitleTemplate   / messageBodyTemplate
 *
 * NULL means "use the built-in default" (see src/utils/notificationTemplate.ts).
 * No backfill: every existing row keeps NULL and so gets the new default.
 * Additive and nullable. Idempotent `ADD COLUMN` on all three backends.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 196';
const TABLE = 'user_notification_preferences';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding ${TABLE} message templates...`);
    addColumnIfMissing(db, TABLE, 'message_title_template', 'message_title_template TEXT');
    addColumnIfMissing(db, TABLE, 'message_body_template', 'message_body_template TEXT');
    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration196Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${TABLE} message templates...`);
  await addColumnIfMissingPostgres(client, TABLE, 'messageTitleTemplate', '"messageTitleTemplate" TEXT');
  await addColumnIfMissingPostgres(client, TABLE, 'messageBodyTemplate', '"messageBodyTemplate" TEXT');
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration196Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ${TABLE} message templates...`);
  await addColumnIfMissingMysql(pool, TABLE, 'messageTitleTemplate', 'messageTitleTemplate TEXT NULL');
  await addColumnIfMissingMysql(pool, TABLE, 'messageBodyTemplate', 'messageBodyTemplate TEXT NULL');
  logger.info(`${LABEL} complete (MySQL)`);
}
