/**
 * Migration 215: `meshcore_nodes.advertSignatureVerified` (#5909). PER-SOURCE,
 * like the table.
 *
 * A nullable boolean: did the Ed25519 signature on the latest ADVERT this
 * source ingested for the node verify?
 *
 *   TRUE  — checked and valid.
 *   FALSE — checked and invalid, or not checked (the cross-source hop toggle
 *           was off when that advert arrived).
 *   NULL  — never checked: device-backed sources, or a row that predates 215.
 *
 * Only `meshcore_mqtt` ingest writes it. The cross-source hop resolver lets an
 * MQTT node name a hop on another source only when this is TRUE, since an MQTT
 * feed relays adverts published by strangers.
 *
 * No backfill: the stored row keeps no signature to check. Additive and
 * nullable. Idempotent `ADD COLUMN` on all three backends.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 215';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding meshcore_nodes.advertSignatureVerified...`);
    addColumnIfMissing(db, 'meshcore_nodes', 'advertSignatureVerified', 'advertSignatureVerified INTEGER');
    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration215Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding meshcore_nodes.advertSignatureVerified...`);
  await addColumnIfMissingPostgres(client, 'meshcore_nodes', 'advertSignatureVerified', '"advertSignatureVerified" BOOLEAN');
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration215Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding meshcore_nodes.advertSignatureVerified...`);
  await addColumnIfMissingMysql(pool, 'meshcore_nodes', 'advertSignatureVerified', 'advertSignatureVerified BOOLEAN NULL');
  logger.info(`${LABEL} complete (MySQL)`);
}
