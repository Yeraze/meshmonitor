/**
 * Migration 170: `messages.transportMechanism` (#5101).
 *
 * `meshtastic.MeshPacket.TransportMechanism` the message arrived on. Column
 * name matches `viaMqtt` and the sibling tables (camelCase in all three
 * dialects, as `traceroutes` does).
 *
 * NULL = pre-migration row -> classify by the existing `viaMqtt` boolean
 * (`classifyMessageTransport`, `src/utils/nodeTransport.ts`). Outbound
 * message writes (user sends, DMs, auto-responder, automation, position
 * requests, …) stamp `TransportMechanism.INTERNAL` (0) explicitly, which
 * classifies RF — the same bucket Phase 1 counted them in, so no count moves
 * on upgrade.
 *
 * No index: the counts query (`getMessageCountsByChannelAndTransport`)
 * already scans one source's rows through `idx_messages_source_id` and
 * groups them in memory/SQL; this column is never a standalone predicate.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 170';
const TABLE = 'messages';
const COLUMN = 'transportMechanism';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding ${TABLE}.${COLUMN}...`);
    addColumnIfMissing(db, TABLE, COLUMN, `${COLUMN} INTEGER`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration170Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${TABLE}.${COLUMN}...`);
  await addColumnIfMissingPostgres(client, TABLE, COLUMN, `"${COLUMN}" INTEGER`);
}

// ============ MySQL ============

export async function runMigration170Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ${TABLE}.${COLUMN}...`);
  await addColumnIfMissingMysql(pool, TABLE, COLUMN, `\`${COLUMN}\` INT`);
}
