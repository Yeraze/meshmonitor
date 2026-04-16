/**
 * Migration 036: Add compound indexes to telemetry table for query performance.
 *
 * PostgreSQL and MySQL were created with only single-column indexes on nodeNum
 * and timestamp. The SQLite bootstrap had additional indexes (nodeId, telemetryType,
 * and a compound position_lookup index) that PG/MySQL never received.
 *
 * With 450k+ telemetry rows, queries like getLatestTelemetryValueForAllNodes(),
 * getTelemetryForNode(), and getAllNodesTelemetryTypes() degrade to full table
 * scans without compound indexes.
 *
 * This migration adds the missing indexes to all three backends (idempotent).
 */
import type { Database } from 'better-sqlite3';

// SQLite migration
export const migration = {
  up(db: Database) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_telemetry_nodeid ON telemetry(nodeId)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_telemetry_type ON telemetry(telemetryType)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_telemetry_position_lookup ON telemetry(nodeId, telemetryType, timestamp DESC)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_telemetry_nodenum_timestamp ON telemetry(nodeNum, timestamp DESC)`);
  },
};

// PostgreSQL migration
export async function runMigration036Postgres(client: any): Promise<void> {
  await client.query(`CREATE INDEX IF NOT EXISTS idx_telemetry_nodeid ON telemetry("nodeId")`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_telemetry_type ON telemetry("telemetryType")`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_telemetry_position_lookup ON telemetry("nodeId", "telemetryType", timestamp DESC)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_telemetry_nodenum_timestamp ON telemetry("nodeNum", timestamp DESC)`);
}

// MySQL migration
export async function runMigration036Mysql(pool: any): Promise<void> {
  const [rows] = await pool.query(`
    SELECT INDEX_NAME FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'telemetry' AND INDEX_NAME = 'idx_telemetry_nodeid'
  `);
  if ((rows as any[]).length === 0) {
    await pool.query(`CREATE INDEX idx_telemetry_nodeid ON telemetry(nodeId)`);
  }

  const [rows2] = await pool.query(`
    SELECT INDEX_NAME FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'telemetry' AND INDEX_NAME = 'idx_telemetry_type'
  `);
  if ((rows2 as any[]).length === 0) {
    await pool.query(`CREATE INDEX idx_telemetry_type ON telemetry(telemetryType)`);
  }

  const [rows3] = await pool.query(`
    SELECT INDEX_NAME FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'telemetry' AND INDEX_NAME = 'idx_telemetry_position_lookup'
  `);
  if ((rows3 as any[]).length === 0) {
    await pool.query(`CREATE INDEX idx_telemetry_position_lookup ON telemetry(nodeId, telemetryType, timestamp DESC)`);
  }

  const [rows4] = await pool.query(`
    SELECT INDEX_NAME FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'telemetry' AND INDEX_NAME = 'idx_telemetry_nodenum_timestamp'
  `);
  if ((rows4 as any[]).length === 0) {
    await pool.query(`CREATE INDEX idx_telemetry_nodenum_timestamp ON telemetry(nodeNum, timestamp DESC)`);
  }
}
