/**
 * Migration 049: Add composite indexes to back hot query patterns.
 *
 * Issue #2831 traced PG connection-pool starvation to source-scoped + ordered
 * queries that fall back to seq-scan or sort because the existing single-column
 * indexes are not selective enough.
 *
 * - telemetry (telemetryType, nodeId, timestamp DESC):
 *     supports getLatestTelemetryValueForAllNodes() which filters by
 *     telemetryType and DISTINCTs on nodeId ordered by timestamp DESC.
 * - telemetry (sourceId, nodeId, telemetryType):
 *     supports getAllNodesTelemetryTypes(sourceId) (DISTINCT nodeId, type
 *     within a source).
 * - messages (sourceId, timestamp DESC):
 *     supports the paginated getMessages(limit, offset, sourceId) query —
 *     before this index PG had to sort the matching rows.
 * - neighbor_info (sourceId, nodeNum):
 *     post-mig 048 neighbor lookups are per-source; the table only had a
 *     standalone (nodeNum) index.
 *
 * All indexes are idempotent (CREATE INDEX IF NOT EXISTS on SQLite/PG,
 * information_schema check on MySQL).
 */
import type { Database } from 'better-sqlite3';

// SQLite migration
export const migration = {
  up(db: Database) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_telemetry_type_node_ts ON telemetry(telemetryType, nodeId, timestamp DESC)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_telemetry_source_node_type ON telemetry(sourceId, nodeId, telemetryType)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_source_timestamp ON messages(sourceId, timestamp DESC)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_neighbor_info_source_nodenum ON neighbor_info(sourceId, nodeNum)`);
  },
};

// PostgreSQL migration
export async function runMigration049Postgres(client: any): Promise<void> {
  await client.query(`CREATE INDEX IF NOT EXISTS idx_telemetry_type_node_ts ON telemetry("telemetryType", "nodeId", timestamp DESC)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_telemetry_source_node_type ON telemetry("sourceId", "nodeId", "telemetryType")`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_source_timestamp ON messages("sourceId", timestamp DESC)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_neighbor_info_source_nodenum ON neighbor_info("sourceId", "nodeNum")`);
}

// MySQL migration
export async function runMigration049Mysql(pool: any): Promise<void> {
  const indexes: Array<{ table: string; name: string; cols: string }> = [
    { table: 'telemetry', name: 'idx_telemetry_type_node_ts', cols: 'telemetryType, nodeId, timestamp DESC' },
    { table: 'telemetry', name: 'idx_telemetry_source_node_type', cols: 'sourceId, nodeId, telemetryType' },
    { table: 'messages', name: 'idx_messages_source_timestamp', cols: 'sourceId, timestamp DESC' },
    { table: 'neighbor_info', name: 'idx_neighbor_info_source_nodenum', cols: 'sourceId, nodeNum' },
  ];

  for (const idx of indexes) {
    const [rows] = await pool.query(
      `SELECT INDEX_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
      [idx.table, idx.name]
    );
    if ((rows as any[]).length === 0) {
      await pool.query(`CREATE INDEX ${idx.name} ON ${idx.table}(${idx.cols})`);
    }
  }
}
