/**
 * Migration 190: repeater RAW-stream ingest columns (#5551, #5553).
 *
 * `meshcore_messages` — decrypt provenance for channel messages a source
 * decrypted with a key it does not hold itself (a MESH_PACKET_LOGGING repeater
 * decrypting GRP_TXT with a sibling Companion's channel key):
 *
 *   keySourceId    TEXT NULL — source whose `channels` row held the key.
 *   keyChannelIdx  INT  NULL — that row's channel slot on `keySourceId`.
 *   keyFingerprint TEXT NULL — hex SHA-256(secret)[0..8]. Read paths gate a
 *                  keyed row on the viewer being able to read SOME channel
 *                  that holds this secret (see utils/meshcoreKeyAccess.ts).
 *                  A one-way digest: the secret itself is never copied.
 *
 * `meshcore_nodes` — `repeaterNeighborAt` BIGINT NULL (epoch ms). Written ONLY
 * by the local repeater's `neighbors` poll, so a node it lists is marked a
 * zero-hop neighbour; a node learned from a RAW advert alone stays NULL.
 *
 * All nullable and additive, so existing rows read as "not keyed" / "not a
 * listed neighbour". Idempotent `ADD COLUMN` on all three backends.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 190';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding repeater ingest columns...`);
    addColumnIfMissing(db, 'meshcore_messages', 'keySourceId', 'keySourceId TEXT');
    addColumnIfMissing(db, 'meshcore_messages', 'keyChannelIdx', 'keyChannelIdx INTEGER');
    addColumnIfMissing(db, 'meshcore_messages', 'keyFingerprint', 'keyFingerprint TEXT');
    addColumnIfMissing(db, 'meshcore_nodes', 'repeaterNeighborAt', 'repeaterNeighborAt INTEGER');
    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration190Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding repeater ingest columns...`);
  await addColumnIfMissingPostgres(client, 'meshcore_messages', 'keySourceId', '"keySourceId" TEXT');
  await addColumnIfMissingPostgres(client, 'meshcore_messages', 'keyChannelIdx', '"keyChannelIdx" INTEGER');
  await addColumnIfMissingPostgres(client, 'meshcore_messages', 'keyFingerprint', '"keyFingerprint" TEXT');
  await addColumnIfMissingPostgres(client, 'meshcore_nodes', 'repeaterNeighborAt', '"repeaterNeighborAt" BIGINT');
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration190Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding repeater ingest columns...`);
  await addColumnIfMissingMysql(pool, 'meshcore_messages', 'keySourceId', 'keySourceId VARCHAR(64) NULL');
  await addColumnIfMissingMysql(pool, 'meshcore_messages', 'keyChannelIdx', 'keyChannelIdx INT NULL');
  await addColumnIfMissingMysql(pool, 'meshcore_messages', 'keyFingerprint', 'keyFingerprint VARCHAR(32) NULL');
  await addColumnIfMissingMysql(pool, 'meshcore_nodes', 'repeaterNeighborAt', 'repeaterNeighborAt BIGINT NULL');
  logger.info(`${LABEL} complete (MySQL)`);
}
