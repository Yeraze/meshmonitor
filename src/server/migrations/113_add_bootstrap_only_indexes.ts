/**
 * Migration 113: normalise bootstrap-only and name-case-drifted indexes.
 *
 * Background (Phase 3.3, WP-A):
 *
 * SQLite's `createIndexes()` bootstrap path created 10 indexes that the
 * migration replay path either never created (7 bootstrap-only) or created
 * under a different name casing (3 camelCase vs lowercase pairs).  This left
 * replay-only (fresh-install, test-db) instances without important perf
 * indexes, and left schema-drift comparisons with 13 allowlist entries.
 *
 * This migration reconciles all 10 by issuing DROP+CREATE on SQLite (the DROP
 * is case-insensitive, so it normalises whichever spelling is present; the
 * subsequent CREATE locks in the canonical lowercase name) and by ensuring the
 * 7 perf indexes on PostgreSQL and MySQL (which were never created by any
 * earlier migration).
 *
 * After this migration runs, `schemaDrift.allowlist.ts` can be reduced to the
 * 2 remaining `sqlMismatch` (column-order) entries.
 *
 * Idempotency:
 *   SQLite   — DROP IF EXISTS is always safe; CREATE IF NOT EXISTS guards.
 *   PG       — native IF NOT EXISTS.
 *   MySQL    — `createIndexIfMissingMysql` helper (information_schema guard).
 */

import type { Database } from 'better-sqlite3';
import { createIndexIfMissingMysql } from './helpers.js';

// ─── SQLite ────────────────────────────────────────────────────────────────────

export const migration = {
  up(db: Database) {
    // --- (1) Name-case pairs: drop whichever spelling exists (case-insensitive
    //         on SQLite), then create with canonical lowercase name.          ---

    // idx_nodes_nodeid — migration 001 created lowercase; createIndexes() kept
    // the camelCase slot on variant-A installs.
    db.exec(`DROP INDEX IF EXISTS idx_nodes_nodeid`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_nodes_nodeid ON nodes(nodeId)`);

    // idx_nodes_lastheard — same pattern as nodeid above.
    db.exec(`DROP INDEX IF EXISTS idx_nodes_lastheard`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_nodes_lastheard ON nodes(lastHeard)`);

    // idx_telemetry_nodeid — migration 036 created lowercase; createIndexes()
    // may have pre-occupied the slot with camelCase on variant-A installs.
    db.exec(`DROP INDEX IF EXISTS idx_telemetry_nodeid`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_telemetry_nodeid ON telemetry(nodeId)`);

    // --- (2) Bootstrap-only indexes: existed only in createIndexes(); replay
    //         path (variant B / fresh installs) silently lacked all 7.       ---

    db.exec(`DROP INDEX IF EXISTS idx_nodes_updatedat`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_nodes_updatedat ON nodes(updatedAt)`);

    db.exec(`DROP INDEX IF EXISTS idx_messages_createdat`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_createdat ON messages(createdAt)`);

    db.exec(`DROP INDEX IF EXISTS idx_messages_fromnodeid`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_fromnodeid ON messages(fromNodeId)`);

    db.exec(`DROP INDEX IF EXISTS idx_messages_tonodeid`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_tonodeid ON messages(toNodeId)`);

    db.exec(`DROP INDEX IF EXISTS idx_route_segments_distance`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_route_segments_distance ON route_segments(distanceKm DESC)`);

    db.exec(`DROP INDEX IF EXISTS idx_route_segments_recordholder`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_route_segments_recordholder ON route_segments(isRecordHolder)`);

    db.exec(`DROP INDEX IF EXISTS idx_route_segments_timestamp`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_route_segments_timestamp ON route_segments(timestamp)`);
  },
};

// ─── PostgreSQL ────────────────────────────────────────────────────────────────
//
// The 3 name-case pairs (nodeid / lastheard / telemetry_nodeid) already exist
// on PG with lowercase names from migrations 001 and 036.  No DROP needed.
// The 7 bootstrap-only perf indexes were never created by any earlier PG
// migration — this fills the gap.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pg PoolClient: tight coupling to pg package not warranted in migrations
export async function runMigration113Postgres(client: any): Promise<void> {
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_nodes_updatedat ON nodes("updatedAt")`,
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_messages_createdat ON messages("createdAt")`,
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_messages_fromnodeid ON messages("fromNodeId")`,
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_messages_tonodeid ON messages("toNodeId")`,
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_route_segments_distance ON route_segments("distanceKm" DESC)`,
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_route_segments_recordholder ON route_segments("isRecordHolder")`,
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_route_segments_timestamp ON route_segments(timestamp)`,
  );
}

// ─── MySQL ─────────────────────────────────────────────────────────────────────
//
// Same 7 perf indexes as PG.  Uses `createIndexIfMissingMysql` because MySQL
// has no `CREATE INDEX IF NOT EXISTS` syntax.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mysql2 Pool: tight coupling not warranted in migrations
export async function runMigration113Mysql(pool: any): Promise<void> {
  await createIndexIfMissingMysql(
    pool,
    'nodes',
    'idx_nodes_updatedat',
    'CREATE INDEX idx_nodes_updatedat ON nodes(updatedAt)',
  );
  await createIndexIfMissingMysql(
    pool,
    'messages',
    'idx_messages_createdat',
    'CREATE INDEX idx_messages_createdat ON messages(createdAt)',
  );
  await createIndexIfMissingMysql(
    pool,
    'messages',
    'idx_messages_fromnodeid',
    'CREATE INDEX idx_messages_fromnodeid ON messages(fromNodeId)',
  );
  await createIndexIfMissingMysql(
    pool,
    'messages',
    'idx_messages_tonodeid',
    'CREATE INDEX idx_messages_tonodeid ON messages(toNodeId)',
  );
  await createIndexIfMissingMysql(
    pool,
    'route_segments',
    'idx_route_segments_distance',
    'CREATE INDEX idx_route_segments_distance ON route_segments(distanceKm DESC)',
  );
  await createIndexIfMissingMysql(
    pool,
    'route_segments',
    'idx_route_segments_recordholder',
    'CREATE INDEX idx_route_segments_recordholder ON route_segments(isRecordHolder)',
  );
  await createIndexIfMissingMysql(
    pool,
    'route_segments',
    'idx_route_segments_timestamp',
    'CREATE INDEX idx_route_segments_timestamp ON route_segments(timestamp)',
  );
}
