import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { AnalysisRepository } from './analysis.js';

describe('AnalysisRepository.getPositions', () => {
  let repo: AnalysisRepository;
  let sqlite: Database.Database;
  let now: number;
  let earlier: number;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    const db = drizzle(sqlite);
    // Mirror the SQLite shape of `telemetry` from src/db/schema/telemetry.ts.
    // (No `nodes` FK in this test fixture — we don't exercise referential
    // integrity here, only the pivot logic.)
    sqlite.exec(`
      CREATE TABLE telemetry (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nodeId TEXT NOT NULL,
        nodeNum INTEGER NOT NULL,
        telemetryType TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        value REAL NOT NULL,
        unit TEXT,
        createdAt INTEGER NOT NULL,
        packetTimestamp INTEGER,
        packetId INTEGER,
        channel INTEGER,
        precisionBits INTEGER,
        gpsAccuracy REAL,
        sourceId TEXT
      );
    `);

    now = Date.now();
    earlier = now - 1000;

    const insert = sqlite.prepare(
      'INSERT INTO telemetry (nodeId, nodeNum, telemetryType, timestamp, value, createdAt, sourceId) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );

    // Position fix #1 at (30.0, -90.0) at `earlier` for nodeNum=1, sourceId='src-a'
    insert.run('!00000001', 1, 'latitude', earlier, 30.0, earlier, 'src-a');
    insert.run('!00000001', 1, 'longitude', earlier, -90.0, earlier, 'src-a');
    // Position fix #2 at (30.1, -90.1) at `now` (newest) for nodeNum=1, sourceId='src-a'
    insert.run('!00000001', 1, 'latitude', now, 30.1, now, 'src-a');
    insert.run('!00000001', 1, 'longitude', now, -90.1, now, 'src-a');

    repo = new AnalysisRepository(db, 'sqlite');
  });

  it('returns positions across given sources, newest first, paginated', async () => {
    const result = await repo.getPositions({
      sourceIds: ['src-a'],
      sinceMs: now - 60_000,
      pageSize: 10,
    });
    expect(result.items).toHaveLength(2);
    expect(result.items[0].timestamp).toBeGreaterThan(result.items[1].timestamp);
    expect(result.items[0]).toMatchObject({
      sourceId: 'src-a',
      nodeNum: 1,
      latitude: 30.1,
      longitude: -90.1,
      altitude: null,
    });
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  it('honors pageSize and emits a cursor when more rows remain', async () => {
    const result = await repo.getPositions({
      sourceIds: ['src-a'],
      sinceMs: now - 60_000,
      pageSize: 1,
    });
    expect(result.items).toHaveLength(1);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).not.toBeNull();
  });

  it('returns no rows when sourceIds is empty', async () => {
    const result = await repo.getPositions({ sourceIds: [], sinceMs: 0, pageSize: 10 });
    expect(result.items).toHaveLength(0);
    expect(result.hasMore).toBe(false);
  });

  it('skips orphaned latitude rows that have no matching longitude', async () => {
    // Insert an extra latitude row at a timestamp where no longitude exists.
    // Pick a timestamp BETWEEN `earlier` and `now` so it would otherwise be
    // returned by the newest-first scan.
    const orphanTs = now - 500;
    sqlite
      .prepare(
        'INSERT INTO telemetry (nodeId, nodeNum, telemetryType, timestamp, value, createdAt, sourceId) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run('!00000001', 1, 'latitude', orphanTs, 31.0, orphanTs, 'src-a');

    const result = await repo.getPositions({
      sourceIds: ['src-a'],
      sinceMs: now - 60_000,
      pageSize: 10,
    });
    expect(result.items).toHaveLength(2);
    // The orphan latitude must not appear in the output.
    expect(result.items.some((r: { timestamp: number }) => r.timestamp === orphanTs)).toBe(false);
  });
});
