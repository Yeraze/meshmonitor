/**
 * Migration 224: derived sender fields on `meshcore_packet_log` (#6262 P4).
 *
 *   srcHash       TEXT / VARCHAR(8)    first-byte sender hash (lowercase hex)
 *   senderPubKey  TEXT / VARCHAR(64)   full sender key when the packet carries it (ADVERT)
 *   advertName    TEXT / VARCHAR(128)  advert name
 *
 * All nullable; no backfill (retention closes the gap). Also adds indexes for
 * sender filters and a (sourceId, fromPublicKey, timestamp) index on
 * `meshcore_messages` for per-contact reads.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
  createIndexIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 224';
const LOG = 'meshcore_packet_log';
const MSG = 'meshcore_messages';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding derived fields to ${LOG}...`);
    addColumnIfMissing(db, LOG, 'srcHash', 'srcHash TEXT');
    addColumnIfMissing(db, LOG, 'senderPubKey', 'senderPubKey TEXT');
    addColumnIfMissing(db, LOG, 'advertName', 'advertName TEXT');
    db.exec(`CREATE INDEX IF NOT EXISTS idx_mcpl_source_src ON ${LOG} (sourceId, srcHash)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_mcpl_source_sender ON ${LOG} (sourceId, senderPubKey)`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_meshcore_messages_source_from_ts ON ${MSG} (sourceId, fromPublicKey, timestamp)`,
    );
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration224Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding derived fields to ${LOG}...`);
  await addColumnIfMissingPostgres(client, LOG, 'srcHash', '"srcHash" TEXT');
  await addColumnIfMissingPostgres(client, LOG, 'senderPubKey', '"senderPubKey" TEXT');
  await addColumnIfMissingPostgres(client, LOG, 'advertName', '"advertName" TEXT');
  await client.query(`CREATE INDEX IF NOT EXISTS idx_mcpl_source_src ON ${LOG} ("sourceId", "srcHash")`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_mcpl_source_sender ON ${LOG} ("sourceId", "senderPubKey")`);
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_meshcore_messages_source_from_ts ON ${MSG} ("sourceId", "fromPublicKey", timestamp)`,
  );
}

// ============ MySQL ============

export async function runMigration224Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding derived fields to ${LOG}...`);
  await addColumnIfMissingMysql(pool, LOG, 'srcHash', 'srcHash VARCHAR(8)');
  await addColumnIfMissingMysql(pool, LOG, 'senderPubKey', 'senderPubKey VARCHAR(64)');
  await addColumnIfMissingMysql(pool, LOG, 'advertName', 'advertName VARCHAR(128)');
  await createIndexIfMissingMysql(pool, LOG, 'idx_mcpl_source_src', `CREATE INDEX idx_mcpl_source_src ON ${LOG} (sourceId, srcHash)`);
  await createIndexIfMissingMysql(pool, LOG, 'idx_mcpl_source_sender', `CREATE INDEX idx_mcpl_source_sender ON ${LOG} (sourceId, senderPubKey)`);
  await createIndexIfMissingMysql(
    pool,
    MSG,
    'idx_meshcore_messages_source_from_ts',
    `CREATE INDEX idx_meshcore_messages_source_from_ts ON ${MSG} (sourceId, fromPublicKey, timestamp)`,
  );
}
