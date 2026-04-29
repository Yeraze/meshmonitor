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

describe('AnalysisRepository.getTraceroutes', () => {
  let repo: AnalysisRepository;
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    const db = drizzle(sqlite);
    // Mirror the SQLite shape of `traceroutes` from src/db/schema/traceroutes.ts.
    sqlite.exec(`
      CREATE TABLE traceroutes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fromNodeNum INTEGER NOT NULL,
        toNodeNum INTEGER NOT NULL,
        fromNodeId TEXT,
        toNodeId TEXT,
        route TEXT,
        routeBack TEXT,
        snrTowards TEXT,
        snrBack TEXT,
        routePositions TEXT,
        channel INTEGER,
        timestamp INTEGER NOT NULL,
        createdAt INTEGER NOT NULL,
        sourceId TEXT
      );
    `);
    const now = Date.now();
    sqlite
      .prepare(
        'INSERT INTO traceroutes (fromNodeNum, toNodeNum, sourceId, route, routeBack, snrTowards, snrBack, timestamp, createdAt) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(1, 2, 'src-a', '[]', '[]', '[10]', '[12]', now, now);
    repo = new AnalysisRepository(db, 'sqlite');
  });

  it('returns traceroutes for given sources, newest first', async () => {
    const r = await repo.getTraceroutes({ sourceIds: ['src-a'], sinceMs: 0, pageSize: 10 });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ fromNodeNum: 1, toNodeNum: 2, sourceId: 'src-a' });
    expect(r.hasMore).toBe(false);
    expect(r.nextCursor).toBeNull();
  });

  it('returns empty when no sources given', async () => {
    const r = await repo.getTraceroutes({ sourceIds: [], sinceMs: 0, pageSize: 10 });
    expect(r.items).toEqual([]);
    expect(r.hasMore).toBe(false);
  });

  it('honors pageSize and emits a cursor when more rows remain', async () => {
    const now = Date.now();
    sqlite
      .prepare(
        'INSERT INTO traceroutes (fromNodeNum, toNodeNum, sourceId, route, routeBack, snrTowards, snrBack, timestamp, createdAt) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(3, 4, 'src-a', '[]', '[]', '[]', '[]', now + 10, now + 10);
    const r = await repo.getTraceroutes({ sourceIds: ['src-a'], sinceMs: 0, pageSize: 1 });
    expect(r.items).toHaveLength(1);
    expect(r.hasMore).toBe(true);
    expect(r.nextCursor).not.toBeNull();
  });
});

describe('AnalysisRepository.getNeighbors', () => {
  it('returns neighbor edges for given sources within sinceMs', async () => {
    const sqlite = new Database(':memory:');
    const db = drizzle(sqlite);
    sqlite.exec(`
      CREATE TABLE neighbor_info (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nodeNum INTEGER NOT NULL,
        neighborNodeNum INTEGER NOT NULL,
        snr REAL,
        lastRxTime INTEGER,
        timestamp INTEGER NOT NULL,
        createdAt INTEGER NOT NULL,
        sourceId TEXT
      );
    `);
    const now = Date.now();
    sqlite
      .prepare(
        'INSERT INTO neighbor_info (nodeNum, neighborNodeNum, sourceId, snr, timestamp, createdAt) VALUES (?,?,?,?,?,?)',
      )
      .run(1, 2, 'src-a', 5.5, now, now);
    const repo = new AnalysisRepository(db, 'sqlite');
    const r = await repo.getNeighbors({ sourceIds: ['src-a'], sinceMs: 0 });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ nodeNum: 1, neighborNum: 2, sourceId: 'src-a' });
    expect(r.items[0].snr).toBeCloseTo(5.5);
  });

  it('returns empty when no sources given', async () => {
    const sqlite = new Database(':memory:');
    const db = drizzle(sqlite);
    const repo = new AnalysisRepository(db, 'sqlite');
    const r = await repo.getNeighbors({ sourceIds: [], sinceMs: 0 });
    expect(r.items).toEqual([]);
  });
});

describe('AnalysisRepository.getCoverageGrid', () => {
  let repo: AnalysisRepository;
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    const db = drizzle(sqlite);
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
    const insert = sqlite.prepare(
      'INSERT INTO telemetry (nodeId, nodeNum, telemetryType, timestamp, value, createdAt, sourceId) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const now = Date.now();
    // Five fixes from node 1 clustered near (30.5001, -90.5001) — all well
    // inside one bin (zoom 12 binSize ≈ 0.000625°). Coverage-area semantics:
    // node 1 should contribute 1 to that cell, not 5.
    for (let i = 0; i < 5; i++) {
      const ts = now - i * 1000;
      const lat = 30.5001 + i * 0.00005;
      const lon = -90.5001 - i * 0.00005;
      insert.run('!00000001', 1, 'latitude', ts, lat, ts, 'src-a');
      insert.run('!00000001', 1, 'longitude', ts, lon, ts, 'src-a');
    }
    // Node 2 also reports from the same coarse bin once. Cell count for
    // that bin should be 2 (unique nodes), not 6 (raw fixes).
    const ts3 = now - 500;
    insert.run('!00000002', 2, 'latitude', ts3, 30.5002, ts3, 'src-a');
    insert.run('!00000002', 2, 'longitude', ts3, -90.5002, ts3, 'src-a');
    // Node 2 also reported once from a far-away bin near (45.5, -100.5).
    const ts2 = now - 10_000;
    insert.run('!00000002', 2, 'latitude', ts2, 45.5001, ts2, 'src-a');
    insert.run('!00000002', 2, 'longitude', ts2, -100.5001, ts2, 'src-a');

    repo = new AnalysisRepository(db, 'sqlite');
  });

  it('counts unique nodes per cell (not raw fix count)', async () => {
    const r = await repo.getCoverageGrid({ sourceIds: ['src-a'], sinceMs: 0, zoom: 12 });
    expect(r.cells.length).toBe(2);
    const counts = r.cells.map((c: { count: number }) => c.count).sort();
    // Cell near (30,-90): nodes 1 + 2 → count 2.
    // Cell near (45,-100): node 2 only → count 1.
    expect(counts).toEqual([1, 2]);
    expect(r.binSizeDeg).toBeGreaterThan(0);
  });

  it('returns empty cells when no sources given', async () => {
    const r = await repo.getCoverageGrid({ sourceIds: [], sinceMs: 0, zoom: 12 });
    expect(r.cells).toEqual([]);
    expect(r.binSizeDeg).toBeGreaterThan(0);
  });
});

describe('AnalysisRepository.getHopCounts', () => {
  it('returns hop count per (sourceId, nodeNum) from latest traceroute', async () => {
    const sqlite = new Database(':memory:');
    const db = drizzle(sqlite);
    sqlite.exec(`
      CREATE TABLE traceroutes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fromNodeNum INTEGER NOT NULL,
        toNodeNum INTEGER NOT NULL,
        fromNodeId TEXT,
        toNodeId TEXT,
        route TEXT,
        routeBack TEXT,
        snrTowards TEXT,
        snrBack TEXT,
        routePositions TEXT,
        channel INTEGER,
        timestamp INTEGER NOT NULL,
        createdAt INTEGER NOT NULL,
        sourceId TEXT
      );
    `);
    const now = Date.now();
    const ins = sqlite.prepare(
      'INSERT INTO traceroutes (fromNodeNum, toNodeNum, sourceId, route, timestamp, createdAt) VALUES (?,?,?,?,?,?)',
    );
    // Older traceroute: 3 hops — should be ignored, newer wins.
    ins.run(1, 99, 'src-a', '[10,20,30]', now - 1000, now - 1000);
    // Newest traceroute: 2 hops — wins for (src-a, 99).
    ins.run(1, 99, 'src-a', '[10,20]', now, now);

    const repo = new AnalysisRepository(db, 'sqlite');
    const r = await repo.getHopCounts({ sourceIds: ['src-a'] });
    const hop = r.entries.find((e: { nodeNum: number; sourceId: string }) => e.nodeNum === 99 && e.sourceId === 'src-a');
    expect(hop?.hops).toBe(2);
  });

  it('returns empty entries when no sources given', async () => {
    const sqlite = new Database(':memory:');
    const db = drizzle(sqlite);
    const repo = new AnalysisRepository(db, 'sqlite');
    const r = await repo.getHopCounts({ sourceIds: [] });
    expect(r.entries).toEqual([]);
  });

  it('handles malformed JSON route by treating as 0 hops', async () => {
    const sqlite = new Database(':memory:');
    const db = drizzle(sqlite);
    sqlite.exec(`
      CREATE TABLE traceroutes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fromNodeNum INTEGER NOT NULL,
        toNodeNum INTEGER NOT NULL,
        fromNodeId TEXT,
        toNodeId TEXT,
        route TEXT,
        routeBack TEXT,
        snrTowards TEXT,
        snrBack TEXT,
        routePositions TEXT,
        channel INTEGER,
        timestamp INTEGER NOT NULL,
        createdAt INTEGER NOT NULL,
        sourceId TEXT
      );
    `);
    const now = Date.now();
    sqlite
      .prepare(
        'INSERT INTO traceroutes (fromNodeNum, toNodeNum, sourceId, route, timestamp, createdAt) VALUES (?,?,?,?,?,?)',
      )
      .run(1, 50, 'src-a', 'not-json', now, now);
    const repo = new AnalysisRepository(db, 'sqlite');
    const r = await repo.getHopCounts({ sourceIds: ['src-a'] });
    expect(r.entries.find((e: { nodeNum: number; hops: number }) => e.nodeNum === 50)?.hops).toBe(0);
  });
});
