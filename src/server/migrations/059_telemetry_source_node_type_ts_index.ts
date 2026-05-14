/**
 * Migration 059: Add a composite index supporting per-source, per-node,
 * per-type time-range telemetry queries.
 *
 * The MeshCore local-node telemetry poller (introduced alongside this
 * migration) writes rows with `telemetryType` strings prefixed `mc_` and
 * the owning `sourceId`. The MeshCore Info page renders these as
 * time-series, so the hot query path is:
 *
 *     SELECT ... FROM telemetry
 *     WHERE sourceId = ? AND nodeId = ? AND telemetryType = ?
 *       AND timestamp >= ?
 *     ORDER BY timestamp DESC
 *
 * Migration 049 already added (sourceId, nodeId, telemetryType) but no
 * trailing timestamp column, forcing a per-bucket sort on every fetch.
 * This migration appends `timestamp DESC` so PostgreSQL/SQLite can serve
 * the range scan directly from the index. The shape is identical across
 * all three backends — the only conditional logic is the MySQL existence
 * check, since MySQL pre-8.0 lacks `CREATE INDEX IF NOT EXISTS`.
 *
 * Idempotent on all three engines.
 */
import type { Database } from 'better-sqlite3';

// SQLite migration
export const migration = {
  up(db: Database) {
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_telemetry_source_node_type_ts ` +
        `ON telemetry(sourceId, nodeId, telemetryType, timestamp DESC)`,
    );
  },
};

// PostgreSQL migration
export async function runMigration059Postgres(client: any): Promise<void> {
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_telemetry_source_node_type_ts ` +
      `ON telemetry("sourceId", "nodeId", "telemetryType", timestamp DESC)`,
  );
}

// MySQL migration
export async function runMigration059Mysql(pool: any): Promise<void> {
  const [rows] = await pool.query(
    `SELECT INDEX_NAME FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    ['telemetry', 'idx_telemetry_source_node_type_ts'],
  );
  if ((rows as any[]).length === 0) {
    await pool.query(
      `CREATE INDEX idx_telemetry_source_node_type_ts ` +
        `ON telemetry(sourceId, nodeId, telemetryType, timestamp DESC)`,
    );
  }
}
