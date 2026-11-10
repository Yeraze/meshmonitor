/**
 * Migration 229: configurable `{{ text }}` length for message notifications on
 * `user_notification_preferences` (#6278). PER-USER and PER-SOURCE, like the
 * table (one row per (userId, sourceId)).
 *
 * Two nullable integer columns hold the length a user wants for the message
 * text in a notification, one for Web Push / desktop and one for Apprise:
 *
 *   SQLite              message_text_max_push / message_text_max_apprise
 *   PostgreSQL / MySQL  messageTextMaxPush    / messageTextMaxApprise
 *
 * NULL means "use the default of 100" (see src/utils/notificationTemplate.ts).
 * No backfill: every existing row keeps NULL, so nothing changes until a user
 * opts in. Additive and nullable. Idempotent `ADD COLUMN` on all three backends.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 229';
const TABLE = 'user_notification_preferences';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding ${TABLE} message text length...`);
    addColumnIfMissing(db, TABLE, 'message_text_max_push', 'message_text_max_push INTEGER');
    addColumnIfMissing(db, TABLE, 'message_text_max_apprise', 'message_text_max_apprise INTEGER');
    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration229Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${TABLE} message text length...`);
  await addColumnIfMissingPostgres(client, TABLE, 'messageTextMaxPush', '"messageTextMaxPush" INTEGER');
  await addColumnIfMissingPostgres(client, TABLE, 'messageTextMaxApprise', '"messageTextMaxApprise" INTEGER');
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration229Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ${TABLE} message text length...`);
  await addColumnIfMissingMysql(pool, TABLE, 'messageTextMaxPush', 'messageTextMaxPush INT NULL');
  await addColumnIfMissingMysql(pool, TABLE, 'messageTextMaxApprise', 'messageTextMaxApprise INT NULL');
  logger.info(`${LABEL} complete (MySQL)`);
}
