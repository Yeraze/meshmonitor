/**
 * Migration 060 — Per-node remote-telemetry-retrieval columns on
 * `meshcore_nodes`. SQLite-only test; the PostgreSQL / MySQL paths
 * share the same shape and are exercised by the integration suite.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './060_meshcore_node_telemetry_config.js';

function createSchema(db: Database.Database) {
  // Post-migration-057 shape: meshcore_nodes already has sourceId.
  db.exec(`
    CREATE TABLE meshcore_nodes (
      publicKey TEXT PRIMARY KEY,
      name TEXT,
      sourceId TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
  `);
}

describe('Migration 060 — meshcore_nodes telemetry-retrieval columns', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
  });

  it('adds telemetryEnabled, telemetryIntervalMinutes, lastTelemetryRequestAt', () => {
    migration.up(db);
    const cols = db.prepare(`PRAGMA table_info(meshcore_nodes)`).all() as Array<{
      name: string;
      type: string;
      dflt_value: unknown;
    }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain('telemetryEnabled');
    expect(colNames).toContain('telemetryIntervalMinutes');
    expect(colNames).toContain('lastTelemetryRequestAt');
  });

  it('applies safe defaults — disabled, 60-minute interval, null lastRequest', () => {
    migration.up(db);
    const ts = Date.now();
    db.prepare(
      `INSERT INTO meshcore_nodes (publicKey, name, sourceId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)`,
    ).run('pk-1', 'node-1', 'src-a', ts, ts);

    const row = db
      .prepare(
        `SELECT telemetryEnabled, telemetryIntervalMinutes, lastTelemetryRequestAt
         FROM meshcore_nodes WHERE publicKey = 'pk-1'`,
      )
      .get() as {
      telemetryEnabled: number;
      telemetryIntervalMinutes: number;
      lastTelemetryRequestAt: number | null;
    };
    expect(row.telemetryEnabled).toBe(0);
    expect(row.telemetryIntervalMinutes).toBe(60);
    expect(row.lastTelemetryRequestAt).toBeNull();
  });

  it('is idempotent — running twice does not fail or duplicate columns', () => {
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();
    const cols = db.prepare(`PRAGMA table_info(meshcore_nodes)`).all() as Array<{ name: string }>;
    const telemetryCols = cols.filter((c) => c.name.startsWith('telemetry') || c.name.startsWith('lastTelemetry'));
    expect(telemetryCols).toHaveLength(3);
  });
});
