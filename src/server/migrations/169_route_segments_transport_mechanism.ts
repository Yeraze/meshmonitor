/**
 * Migration 169: `route_segments.transportMechanism` (#5101).
 *
 * Stores the EFFECTIVE per-hop transport mechanism: the producing traceroute
 * record's `meshtastic.MeshPacket.TransportMechanism`, or MQTT (5) when that
 * hop's arrival SNR was the firmware's unknown-SNR sentinel (sentinel wins —
 * see `src/utils/tracerouteTransport.ts`'s `segmentTransportMechanism`).
 * Classified at read time via `classifyNodeTransport` /
 * `transportClassCondition` — same vocabulary as `nodes.transportMechanism`
 * (066), `traceroutes.transportMechanism` (160) and
 * `packet_log.transport_mechanism`.
 *
 * NULL = pre-migration row -> RF (the existing default reading). Non-record
 * rows age out within the retention window, so this heals itself except for
 * record holders (`isRecordHolder = true`), which never age out — migration
 * 171 reclassifies those it can, best-effort. No backfill here.
 *
 * Index `idx_route_segments_source_transport_distance` (sourceId,
 * transportMechanism, distanceKm): the Info tab polls both the "Longest
 * Active" and "Record Holder" endpoints every 60s, and each now runs one
 * query per transport class. `route_segments` reaches ~865k rows on a real
 * install (#4233). Without this index, `sourceId = ? AND transportMechanism
 * = 6 ORDER BY distanceKm DESC LIMIT 1` on a mesh with no UDP walks the
 * distance index to the end; with it, the MQTT/UDP lookups are an index
 * seek. RF (`IS NULL OR NOT IN (5,6)`) still walks
 * `idx_route_segments_distance`, but stops at the first RF row, which is
 * usually near the top. The record-holder lookups filter
 * `isRecordHolder = true` first (a handful of rows per source), already
 * served by `idx_route_segments_recordholder`.
 *
 * Cost: `ADD COLUMN` nullable with no default is metadata-only on PostgreSQL,
 * `INSTANT` on MySQL 8, and O(1) on SQLite. The index build scans the table
 * once, at boot, like migration 113 did.
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

const LABEL = 'Migration 169';
const TABLE = 'route_segments';
const COLUMN = 'transportMechanism';
const INDEX = 'idx_route_segments_source_transport_distance';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding ${TABLE}.${COLUMN}...`);
    addColumnIfMissing(db, TABLE, COLUMN, `${COLUMN} INTEGER`);
    db.exec(`CREATE INDEX IF NOT EXISTS ${INDEX} ON route_segments(sourceId, transportMechanism, distanceKm)`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration169Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${TABLE}.${COLUMN}...`);
  await addColumnIfMissingPostgres(client, TABLE, COLUMN, `"${COLUMN}" INTEGER`);
  await client.query(`CREATE INDEX IF NOT EXISTS ${INDEX} ON route_segments("sourceId", "transportMechanism", "distanceKm")`);
}

// ============ MySQL ============

export async function runMigration169Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ${TABLE}.${COLUMN}...`);
  await addColumnIfMissingMysql(pool, TABLE, COLUMN, `\`${COLUMN}\` INT`);
  await createIndexIfMissingMysql(
    pool,
    TABLE,
    INDEX,
    `CREATE INDEX ${INDEX} ON route_segments(sourceId, transportMechanism, distanceKm)`,
  );
}
