/**
 * Migration 061 — meshcore_nodes composite PK (sourceId, publicKey).
 *
 * SQLite-only test; PG/MySQL paths share the same shape and are exercised
 * by the integration suite. We assert:
 *
 *   1. The rebuild produces a composite PK on (sourceId, publicKey).
 *   2. Existing rows survive the rebuild.
 *   3. NULL-sourceId rows are backfilled to the legacy meshcore source.
 *   4. After the rebuild, the same publicKey can be inserted under two
 *      different sourceIds without a UNIQUE constraint failure — the
 *      observed production bug.
 *   5. The migration is idempotent.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './061_meshcore_nodes_composite_pk.js';

function createPostM060Schema(db: Database.Database) {
  // Sources table is required for the legacy-default backfill path.
  db.exec(`
    CREATE TABLE sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      config TEXT,
      enabled INTEGER DEFAULT 1,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
  `);

  // Post-migration-060 shape: publicKey-only PK.
  db.exec(`
    CREATE TABLE meshcore_nodes (
      publicKey TEXT PRIMARY KEY,
      name TEXT,
      advType INTEGER,
      txPower INTEGER,
      maxTxPower INTEGER,
      radioFreq REAL,
      radioBw REAL,
      radioSf INTEGER,
      radioCr INTEGER,
      latitude REAL,
      longitude REAL,
      altitude REAL,
      batteryMv INTEGER,
      uptimeSecs INTEGER,
      rssi INTEGER,
      snr REAL,
      lastHeard INTEGER,
      hasAdminAccess INTEGER DEFAULT 0,
      lastAdminCheck INTEGER,
      isLocalNode INTEGER DEFAULT 0,
      sourceId TEXT,
      telemetryEnabled INTEGER DEFAULT 0,
      telemetryIntervalMinutes INTEGER DEFAULT 60,
      lastTelemetryRequestAt INTEGER,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
  `);
}

function pkColumns(db: Database.Database): string[] {
  const rows = db
    .prepare(`SELECT name FROM pragma_table_info('meshcore_nodes') WHERE pk > 0 ORDER BY pk`)
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

describe('Migration 061 — meshcore_nodes composite PK (sourceId, publicKey)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    createPostM060Schema(db);
  });

  it('rebuilds with composite (sourceId, publicKey) PK', () => {
    migration.up(db);
    const pk = pkColumns(db);
    expect(pk).toContain('sourceId');
    expect(pk).toContain('publicKey');
    expect(pk.length).toBeGreaterThanOrEqual(2);
  });

  it('preserves existing rows through the rebuild', () => {
    const ts = Date.now();
    db.prepare(
      `INSERT INTO sources (id, name, type, config, enabled, createdAt, updatedAt)
       VALUES ('src-a', 'Source A', 'meshcore', '{}', 1, ?, ?)`,
    ).run(ts, ts);
    db.prepare(
      `INSERT INTO meshcore_nodes (publicKey, name, sourceId, createdAt, updatedAt)
       VALUES ('pk-1', 'kept', 'src-a', ?, ?)`,
    ).run(ts, ts);

    migration.up(db);

    const row = db
      .prepare(`SELECT publicKey, name, sourceId FROM meshcore_nodes WHERE publicKey = 'pk-1'`)
      .get() as { publicKey: string; name: string; sourceId: string };
    expect(row.publicKey).toBe('pk-1');
    expect(row.name).toBe('kept');
    expect(row.sourceId).toBe('src-a');
  });

  it('backfills NULL-sourceId rows to the legacy meshcore source', () => {
    const ts = Date.now();
    // A pre-057-style orphan row with NULL sourceId.
    db.prepare(
      `INSERT INTO meshcore_nodes (publicKey, name, sourceId, createdAt, updatedAt)
       VALUES ('pk-orphan', 'orphan', NULL, ?, ?)`,
    ).run(ts, ts);

    migration.up(db);

    const row = db
      .prepare(`SELECT sourceId FROM meshcore_nodes WHERE publicKey = 'pk-orphan'`)
      .get() as { sourceId: string };
    expect(row.sourceId).toBe('meshcore-legacy-default');

    // The legacy source row was synthesised.
    const src = db
      .prepare(`SELECT id, type FROM sources WHERE id = 'meshcore-legacy-default'`)
      .get() as { id: string; type: string };
    expect(src.id).toBe('meshcore-legacy-default');
    expect(src.type).toBe('meshcore');
  });

  it('allows the same publicKey under two different sourceIds after the rebuild — the bug fix', () => {
    const ts = Date.now();
    db.prepare(
      `INSERT INTO sources (id, name, type, config, enabled, createdAt, updatedAt)
       VALUES ('src-a', 'Source A', 'meshcore', '{}', 1, ?, ?),
              ('src-b', 'Source B', 'meshcore', '{}', 1, ?, ?)`,
    ).run(ts, ts, ts, ts);
    db.prepare(
      `INSERT INTO meshcore_nodes (publicKey, name, sourceId, createdAt, updatedAt)
       VALUES ('pk-shared', 'A-owned', 'src-a', ?, ?)`,
    ).run(ts, ts);

    migration.up(db);

    // After the rebuild, inserting the same publicKey under src-b must succeed.
    expect(() => {
      db.prepare(
        `INSERT INTO meshcore_nodes (publicKey, name, sourceId, createdAt, updatedAt)
         VALUES ('pk-shared', 'B-owned', 'src-b', ?, ?)`,
      ).run(ts, ts);
    }).not.toThrow();

    const rows = db
      .prepare(
        `SELECT sourceId, name FROM meshcore_nodes WHERE publicKey = 'pk-shared' ORDER BY sourceId`,
      )
      .all() as Array<{ sourceId: string; name: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ sourceId: 'src-a', name: 'A-owned' });
    expect(rows[1]).toEqual({ sourceId: 'src-b', name: 'B-owned' });
  });

  it('still rejects duplicate (sourceId, publicKey) pairs', () => {
    const ts = Date.now();
    db.prepare(
      `INSERT INTO sources (id, name, type, config, enabled, createdAt, updatedAt)
       VALUES ('src-a', 'Source A', 'meshcore', '{}', 1, ?, ?)`,
    ).run(ts, ts);
    db.prepare(
      `INSERT INTO meshcore_nodes (publicKey, name, sourceId, createdAt, updatedAt)
       VALUES ('pk-1', 'A1', 'src-a', ?, ?)`,
    ).run(ts, ts);

    migration.up(db);

    expect(() => {
      db.prepare(
        `INSERT INTO meshcore_nodes (publicKey, name, sourceId, createdAt, updatedAt)
         VALUES ('pk-1', 'dup', 'src-a', ?, ?)`,
      ).run(ts, ts);
    }).toThrow(/UNIQUE|PRIMARY/);
  });

  it('is idempotent — running twice does not fail or alter the schema', () => {
    migration.up(db);
    const pkBefore = pkColumns(db);
    expect(() => migration.up(db)).not.toThrow();
    const pkAfter = pkColumns(db);
    expect(pkAfter).toEqual(pkBefore);
  });

  it('preserves the meshcore_nodes source-id index post-rebuild', () => {
    migration.up(db);
    const idx = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND tbl_name = 'meshcore_nodes' AND name = 'idx_meshcore_nodes_source_id'`,
      )
      .get();
    expect(idx).toBeDefined();
  });
});
