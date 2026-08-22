/**
 * Migration 153 — Per-node neighbours-retrieval columns on `meshcore_nodes`
 * (#4618). SQLite-only test; the PostgreSQL / MySQL paths share the same
 * shape and are exercised by the integration suite.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './153_meshcore_node_neighbors_config.js';

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

describe('Migration 153 — meshcore_nodes neighbours-retrieval columns', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
  });

  it('adds neighborsEnabled, neighborsIntervalMinutes, lastNeighborsRequestAt', () => {
    migration.up(db);
    const cols = db.prepare(`PRAGMA table_info(meshcore_nodes)`).all() as Array<{
      name: string;
      type: string;
      dflt_value: unknown;
    }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain('neighborsEnabled');
    expect(colNames).toContain('neighborsIntervalMinutes');
    expect(colNames).toContain('lastNeighborsRequestAt');
  });

  it('applies safe defaults — disabled, 60-minute interval, null lastRequest', () => {
    migration.up(db);
    const ts = Date.now();
    db.prepare(
      `INSERT INTO meshcore_nodes (publicKey, name, sourceId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)`,
    ).run('pk-1', 'node-1', 'src-a', ts, ts);

    const row = db
      .prepare(
        `SELECT neighborsEnabled, neighborsIntervalMinutes, lastNeighborsRequestAt
         FROM meshcore_nodes WHERE publicKey = 'pk-1'`,
      )
      .get() as {
      neighborsEnabled: number;
      neighborsIntervalMinutes: number;
      lastNeighborsRequestAt: number | null;
    };
    expect(row.neighborsEnabled).toBe(0);
    expect(row.neighborsIntervalMinutes).toBe(60);
    expect(row.lastNeighborsRequestAt).toBeNull();
  });

  it('is idempotent — running twice does not fail or duplicate columns', () => {
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();
    const cols = db.prepare(`PRAGMA table_info(meshcore_nodes)`).all() as Array<{ name: string }>;
    const neighborCols = cols.filter(
      (c) => c.name.startsWith('neighbors') || c.name.startsWith('lastNeighbors'),
    );
    expect(neighborCols).toHaveLength(3);
  });

  it('does not touch the telemetry columns — cadences stay independent', () => {
    // Seed the migration-060 telemetry trio first, then run 153: the two sets
    // must coexist so a neighbours poll never resets the telemetry timer.
    db.exec(`ALTER TABLE meshcore_nodes ADD COLUMN telemetryEnabled INTEGER DEFAULT 0`);
    db.exec(`ALTER TABLE meshcore_nodes ADD COLUMN lastTelemetryRequestAt INTEGER`);
    migration.up(db);
    const colNames = (db.prepare(`PRAGMA table_info(meshcore_nodes)`).all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(colNames).toContain('telemetryEnabled');
    expect(colNames).toContain('lastTelemetryRequestAt');
    expect(colNames).toContain('neighborsEnabled');
    expect(colNames).toContain('lastNeighborsRequestAt');
  });
});
