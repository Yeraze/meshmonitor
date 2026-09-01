/**
 * Migration 156 — Per-node time-sync columns on `meshcore_nodes` (#4916).
 * SQLite-only test; the PostgreSQL / MySQL paths share the same shape and are
 * exercised by the `.pgmysql` integration suite alongside this one.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './156_meshcore_node_time_sync_config.js';

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

describe('Migration 156 — meshcore_nodes time-sync columns', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
  });

  it('adds timeSyncEnabled, timeSyncIntervalMinutes, lastTimeSyncAt', () => {
    migration.up(db);
    const colNames = (db.prepare(`PRAGMA table_info(meshcore_nodes)`).all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(colNames).toContain('timeSyncEnabled');
    expect(colNames).toContain('timeSyncIntervalMinutes');
    expect(colNames).toContain('lastTimeSyncAt');
  });

  it('defaults to disabled with a 12-hour interval and no last-sync stamp', () => {
    migration.up(db);
    const ts = Date.now();
    db.prepare(
      `INSERT INTO meshcore_nodes (publicKey, name, sourceId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)`,
    ).run('pk-1', 'node-1', 'src-a', ts, ts);

    const row = db
      .prepare(
        `SELECT timeSyncEnabled, timeSyncIntervalMinutes, lastTimeSyncAt
         FROM meshcore_nodes WHERE publicKey = 'pk-1'`,
      )
      .get() as {
      timeSyncEnabled: number;
      timeSyncIntervalMinutes: number;
      lastTimeSyncAt: number | null;
    };
    // Opt-in, never on by default: enabling this puts packets on the air.
    expect(row.timeSyncEnabled).toBe(0);
    // 720 minutes = 12h, NOT the 60 the other two trios default to — one sync
    // is four packets, so the cadence is deliberately an order slower.
    expect(row.timeSyncIntervalMinutes).toBe(720);
    expect(row.lastTimeSyncAt).toBeNull();
  });

  it('is idempotent — running twice does not fail or duplicate columns', () => {
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();
    const cols = db.prepare(`PRAGMA table_info(meshcore_nodes)`).all() as Array<{ name: string }>;
    const timeSyncCols = cols.filter(
      (c) => c.name.startsWith('timeSync') || c.name === 'lastTimeSyncAt',
    );
    expect(timeSyncCols).toHaveLength(3);
  });

  it('coexists with the telemetry and neighbours trios — all three stay independent', () => {
    // Seed the migration-060 telemetry trio and the migration-153 neighbours
    // trio first, then run 156. All three column sets must survive, because
    // the whole point of a third set is that a time-sync never resets either
    // of the other two schedulers' cadences.
    db.exec(`ALTER TABLE meshcore_nodes ADD COLUMN telemetryEnabled INTEGER DEFAULT 0`);
    db.exec(`ALTER TABLE meshcore_nodes ADD COLUMN lastTelemetryRequestAt INTEGER`);
    db.exec(`ALTER TABLE meshcore_nodes ADD COLUMN neighborsEnabled INTEGER DEFAULT 0`);
    db.exec(`ALTER TABLE meshcore_nodes ADD COLUMN lastNeighborsRequestAt INTEGER`);

    migration.up(db);

    const colNames = (db.prepare(`PRAGMA table_info(meshcore_nodes)`).all() as Array<{ name: string }>)
      .map((c) => c.name);
    for (const col of [
      'telemetryEnabled',
      'lastTelemetryRequestAt',
      'neighborsEnabled',
      'lastNeighborsRequestAt',
      'timeSyncEnabled',
      'lastTimeSyncAt',
    ]) {
      expect(colNames).toContain(col);
    }
  });

  it('leaves existing rows untouched — no backfill enables anything', () => {
    const ts = Date.now();
    db.prepare(
      `INSERT INTO meshcore_nodes (publicKey, name, sourceId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)`,
    ).run('pk-existing', 'pre-existing', 'src-a', ts, ts);

    migration.up(db);

    const row = db
      .prepare(`SELECT timeSyncEnabled FROM meshcore_nodes WHERE publicKey = 'pk-existing'`)
      .get() as { timeSyncEnabled: number };
    // A node that existed before the feature must not start transmitting
    // because someone upgraded.
    expect(row.timeSyncEnabled).toBe(0);
  });
});
