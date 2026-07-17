/**
 * Migration 123: Re-file MQTT-sourced directed messages into the DM view.
 *
 * Before the #4152 ingestion fix, `mqttIngestion.ts` stored every TEXT_MESSAGE_APP
 * packet with `channel = effectiveChannel`, never checking `toNodeNum`. A message
 * addressed to a specific node (not broadcast) was therefore bucketed into its
 * LoRa channel and rendered as an ordinary broadcast in both per-source chat and
 * Unified Messages. The TCP/radio path has always forced `channel = -1` for
 * directed messages; this one-shot cleanup brings pre-existing MQTT rows in line.
 *
 * Scope is deliberately narrow: only MQTT-sourced (`viaMqtt` true) TEXT_MESSAGE_APP
 * (`portnum = 1`) rows addressed to a specific node (`toNodeNum` != the broadcast
 * address 4294967295) that are not already `-1`. Broadcasts, non-text rows, and
 * TCP/radio rows (which were already correct) are untouched.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL: the `channel <> -1` predicate
 * means a re-run matches nothing.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 123';
const BROADCAST_ADDR = 4294967295; // 0xFFFFFFFF

// SQLite / MySQL: camelCase columns, unquoted; boolean stored as 0/1.
const UPDATE_SQL = `UPDATE messages SET channel = -1
  WHERE viaMqtt = 1 AND portnum = 1 AND toNodeNum <> ${BROADCAST_ADDR} AND channel <> -1`;

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): re-filing MQTT directed messages into the DM view...`);
    const info = db.prepare(UPDATE_SQL).run();
    if (info.changes > 0) {
      logger.info(`${LABEL} (SQLite): re-filed ${info.changes} MQTT directed message(s) to channel -1`);
    }
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (the original per-message channel is not recoverable)`);
  },
};

// ============ PostgreSQL ============

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pg client is untyped in the migration runner (matches all sibling migrations)
export async function runMigration123Postgres(client: any): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): re-filing MQTT directed messages into the DM view...`);
  const res = await client.query(
    `UPDATE messages SET "channel" = -1
     WHERE "viaMqtt" = true AND "portnum" = 1 AND "toNodeNum" <> ${BROADCAST_ADDR} AND "channel" <> -1`,
  );
  if (res?.rowCount) {
    logger.info(`${LABEL} (PostgreSQL): re-filed ${res.rowCount} MQTT directed message(s) to channel -1`);
  }
}

// ============ MySQL ============

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mysql pool is untyped in the migration runner (matches all sibling migrations)
export async function runMigration123Mysql(pool: any): Promise<void> {
  logger.info(`${LABEL} (MySQL): re-filing MQTT directed messages into the DM view...`);
  const [res] = await pool.query(UPDATE_SQL);
  const affected = (res as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
  if (affected > 0) {
    logger.info(`${LABEL} (MySQL): re-filed ${affected} MQTT directed message(s) to channel -1`);
  }
}
