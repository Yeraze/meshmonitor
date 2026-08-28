import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { createTestDb } from '../../server/test-helpers/testDb.js';
import { AnalysisRepository } from './analysis.js';

describe('AnalysisRepository.getPositions', () => {
  let repo: AnalysisRepository;
  let sqlite: Database.Database;
  let drizzleDb: BetterSQLite3Database;
  let now: number;
  let earlier: number;

  beforeEach(async () => {
    const t = createTestDb();
    sqlite = t.sqlite;
    drizzleDb = t.db;

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

    repo = new AnalysisRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    sqlite.close();
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

  it('skips Null Island (0,0) fixes so trails/heatmap never plot them (#3763)', async () => {
    // A complete (0,0) fix paired at a timestamp between `earlier` and `now`.
    const nullTs = now - 500;
    const insert = sqlite.prepare(
      'INSERT INTO telemetry (nodeId, nodeNum, telemetryType, timestamp, value, createdAt, sourceId) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    insert.run('!00000001', 1, 'latitude', nullTs, 0.0004, nullTs, 'src-a');
    insert.run('!00000001', 1, 'longitude', nullTs, -0.0002, nullTs, 'src-a');

    const result = await repo.getPositions({
      sourceIds: ['src-a'],
      sinceMs: now - 60_000,
      pageSize: 10,
    });
    // Only the two legitimate fixes survive; the Null Island fix is dropped.
    expect(result.items).toHaveLength(2);
    expect(result.items.some((r: { timestamp: number }) => r.timestamp === nullTs)).toBe(false);
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
  let drizzleDb: BetterSQLite3Database;

  beforeEach(() => {
    const t = createTestDb();
    sqlite = t.sqlite;
    drizzleDb = t.db;

    const now = Date.now();
    sqlite
      .prepare(
        'INSERT INTO traceroutes (fromNodeNum, toNodeNum, fromNodeId, toNodeId, sourceId, route, routeBack, snrTowards, snrBack, timestamp, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(1, 2, '!00000001', '!00000002', 'src-a', '[]', '[]', '[10]', '[12]', now, now);
    repo = new AnalysisRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    sqlite.close();
  });

  it('returns traceroutes for given sources, newest first', async () => {
    const r = await repo.getTraceroutes({ sourceIds: ['src-a'], sinceMs: 0, pageSize: 10 });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ fromNodeNum: 1, toNodeNum: 2, sourceId: 'src-a' });
    // No packetId was supplied on insert (pre-migration-style row) — must round-trip as null.
    expect(r.items[0].packetId).toBeNull();
    expect(r.hasMore).toBe(false);
    expect(r.nextCursor).toBeNull();
  });

  it('returns packetId as a number when set (#4964 cross-source dedup key)', async () => {
    const now = Date.now();
    sqlite
      .prepare(
        'INSERT INTO traceroutes (fromNodeNum, toNodeNum, fromNodeId, toNodeId, sourceId, route, routeBack, snrTowards, snrBack, timestamp, createdAt, packetId) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(5, 6, '!00000005', '!00000006', 'src-a', '[]', '[]', '[]', '[]', now + 20, now + 20, 424242);
    const r = await repo.getTraceroutes({ sourceIds: ['src-a'], sinceMs: 0, pageSize: 10 });
    const withPacketId = r.items.find((i) => i.fromNodeNum === 5);
    expect(withPacketId).toBeDefined();
    expect(withPacketId?.packetId).toBe(424242);
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
        'INSERT INTO traceroutes (fromNodeNum, toNodeNum, fromNodeId, toNodeId, sourceId, route, routeBack, snrTowards, snrBack, timestamp, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(3, 4, '!00000003', '!00000004', 'src-a', '[]', '[]', '[]', '[]', now + 10, now + 10);
    const r = await repo.getTraceroutes({ sourceIds: ['src-a'], sinceMs: 0, pageSize: 1 });
    expect(r.items).toHaveLength(1);
    expect(r.hasMore).toBe(true);
    expect(r.nextCursor).not.toBeNull();
  });
});

describe('AnalysisRepository.getNeighbors', () => {
  it('returns neighbor edges for given sources within sinceMs', async () => {
    const t = createTestDb();
    const { sqlite, db, close } = t;
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
    close();
  });

  it('returns empty when no sources given', async () => {
    const { db, close } = createTestDb();
    const repo = new AnalysisRepository(db, 'sqlite');
    const r = await repo.getNeighbors({ sourceIds: [], sinceMs: 0 });
    expect(r.items).toEqual([]);
    close();
  });
});

describe('AnalysisRepository.getCoverageGrid', () => {
  let repo: AnalysisRepository;
  let sqlite: Database.Database;
  let drizzleDb: BetterSQLite3Database;

  beforeEach(() => {
    const t = createTestDb();
    sqlite = t.sqlite;
    drizzleDb = t.db;

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

    repo = new AnalysisRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    sqlite.close();
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
    const t = createTestDb();
    const { sqlite, db, close } = t;
    const now = Date.now();
    const ins = sqlite.prepare(
      'INSERT INTO traceroutes (fromNodeNum, toNodeNum, fromNodeId, toNodeId, sourceId, route, timestamp, createdAt) VALUES (?,?,?,?,?,?,?,?)',
    );
    // Older traceroute: 3 hops — should be ignored, newer wins.
    ins.run(1, 99, '!00000001', '!00000063', 'src-a', '[10,20,30]', now - 1000, now - 1000);
    // Newest traceroute: 2 hops — wins for (src-a, 99).
    ins.run(1, 99, '!00000001', '!00000063', 'src-a', '[10,20]', now, now);

    const repo = new AnalysisRepository(db, 'sqlite');
    const r = await repo.getHopCounts({ sourceIds: ['src-a'] });
    const hop = r.entries.find((e: { nodeNum: number; sourceId: string }) => e.nodeNum === 99 && e.sourceId === 'src-a');
    expect(hop?.hops).toBe(2);
    close();
  });

  it('returns empty entries when no sources given', async () => {
    const { db, close } = createTestDb();
    const repo = new AnalysisRepository(db, 'sqlite');
    const r = await repo.getHopCounts({ sourceIds: [] });
    expect(r.entries).toEqual([]);
    close();
  });

  // #4570: this used to assert `hops === 0`, which was itself the bug — 0
  // renders as "local" green on the map, so corrupt data claimed the node was
  // a direct neighbour. Omitting the entry makes the caller render it grey.
  it('omits a node whose route JSON is malformed rather than calling it 0 hops', async () => {
    const t = createTestDb();
    const { sqlite, db, close } = t;
    const now = Date.now();
    sqlite
      .prepare(
        'INSERT INTO traceroutes (fromNodeNum, toNodeNum, fromNodeId, toNodeId, sourceId, route, timestamp, createdAt) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(1, 50, '!00000001', '!00000032', 'src-a', 'not-json', now, now);
    const repo = new AnalysisRepository(db, 'sqlite');
    const r = await repo.getHopCounts({ sourceIds: ['src-a'] });
    expect(r.entries.find((e: { nodeNum: number }) => e.nodeNum === 50)).toBeUndefined();
    close();
  });

  it('omits a node whose route JSON parses to a non-array', async () => {
    const t = createTestDb();
    const { sqlite, db, close } = t;
    const now = Date.now();
    const ins = sqlite.prepare(
      'INSERT INTO traceroutes (fromNodeNum, toNodeNum, fromNodeId, toNodeId, sourceId, route, timestamp, createdAt) VALUES (?,?,?,?,?,?,?,?)',
    );
    ins.run(1, 51, '!00000001', '!00000033', 'src-a', '{"hops":2}', now, now);
    ins.run(1, 52, '!00000001', '!00000034', 'src-a', '7', now, now);
    const repo = new AnalysisRepository(db, 'sqlite');
    const r = await repo.getHopCounts({ sourceIds: ['src-a'] });
    expect(r.entries.find((e: { nodeNum: number }) => e.nodeNum === 51)).toBeUndefined();
    expect(r.entries.find((e: { nodeNum: number }) => e.nodeNum === 52)).toBeUndefined();
    close();
  });
});

/**
 * #4570 — a NULL `route` marks a PENDING traceroute (request sent, no response
 * yet); `insertTracerouteWithDedup` finds exactly those rows via
 * `isNull(traceroutes.route)`. It used to parse as `'[]'` → 0 hops → "local"
 * green, so every outstanding request painted its target as a direct
 * neighbour. Auto-traceroute produces these continuously, and one that is
 * never answered (routine for distant nodes) never resolves — which is how
 * dozens of remote nodes ended up shaded green on Map Analysis.
 */
describe('AnalysisRepository.getHopCounts — pending traceroutes (#4570)', () => {
  const INSERT =
    'INSERT INTO traceroutes (fromNodeNum, toNodeNum, fromNodeId, toNodeId, sourceId, route, timestamp, createdAt) VALUES (?,?,?,?,?,?,?,?)';

  it('does not report a pending traceroute as 0 hops / local', async () => {
    const { sqlite, db, close } = createTestDb();
    const now = Date.now();
    sqlite.prepare(INSERT).run(1, 99, '!00000001', '!00000063', 'src-a', null, now, now);

    const repo = new AnalysisRepository(db, 'sqlite');
    const r = await repo.getHopCounts({ sourceIds: ['src-a'] });

    // Absent entirely — the map renders a missing entry as unknown/grey.
    expect(r.entries.find((e: { nodeNum: number }) => e.nodeNum === 99)).toBeUndefined();
    close();
  });

  it('does not let a newer pending request mask an older answered traceroute', async () => {
    // The core regression: re-tracing a known 3-hop node must not turn it
    // green while the response is outstanding.
    const { sqlite, db, close } = createTestDb();
    const now = Date.now();
    const ins = sqlite.prepare(INSERT);
    ins.run(1, 99, '!00000001', '!00000063', 'src-a', '[10,20,30]', now - 5000, now - 5000);
    ins.run(1, 99, '!00000001', '!00000063', 'src-a', null, now, now); // newest, pending

    const repo = new AnalysisRepository(db, 'sqlite');
    const r = await repo.getHopCounts({ sourceIds: ['src-a'] });

    expect(r.entries.find((e: { nodeNum: number }) => e.nodeNum === 99)?.hops).toBe(3);
    close();
  });

  it('still reports a genuinely direct neighbour as 0 hops', async () => {
    // The distinction `route ?? '[]'` destroyed: an EMPTY route is a real
    // answered traceroute with no intermediate hops and must stay green; a
    // NULL route is no answer at all. Both used to produce 0.
    const { sqlite, db, close } = createTestDb();
    const now = Date.now();
    sqlite.prepare(INSERT).run(1, 77, '!00000001', '!0000004d', 'src-a', '[]', now, now);

    const repo = new AnalysisRepository(db, 'sqlite');
    const r = await repo.getHopCounts({ sourceIds: ['src-a'] });

    expect(r.entries.find((e: { nodeNum: number }) => e.nodeNum === 77)?.hops).toBe(0);
    close();
  });

  it('skips past several consecutive pending rows to the newest answered one', async () => {
    // Repeated auto-traceroute attempts against an unresponsive node stack up
    // pending rows; the last good answer must still win.
    const { sqlite, db, close } = createTestDb();
    const now = Date.now();
    const ins = sqlite.prepare(INSERT);
    ins.run(1, 99, '!00000001', '!00000063', 'src-a', '[10,20]', now - 9000, now - 9000);
    ins.run(1, 99, '!00000001', '!00000063', 'src-a', null, now - 3000, now - 3000);
    ins.run(1, 99, '!00000001', '!00000063', 'src-a', null, now - 2000, now - 2000);
    ins.run(1, 99, '!00000001', '!00000063', 'src-a', null, now, now);

    const repo = new AnalysisRepository(db, 'sqlite');
    const r = await repo.getHopCounts({ sourceIds: ['src-a'] });

    expect(r.entries.find((e: { nodeNum: number }) => e.nodeNum === 99)?.hops).toBe(2);
    close();
  });

  it('does not fall back to an older row when the newest answered route is corrupt', async () => {
    // Documents a deliberate consequence of selecting "newest answered row"
    // in SQL: the database cannot judge whether `route` is valid JSON, so a
    // corrupt newest row yields grey rather than reaching past it to an older
    // one. Both writers store JSON.stringify(route), so reaching this needs
    // manual DB editing — and grey is the honest answer for unreadable data.
    const { sqlite, db, close } = createTestDb();
    const now = Date.now();
    const ins = sqlite.prepare(INSERT);
    ins.run(1, 98, '!00000001', '!00000062', 'src-a', '[10,20]', now - 5000, now - 5000);
    ins.run(1, 98, '!00000001', '!00000062', 'src-a', 'not-json', now, now);

    const repo = new AnalysisRepository(db, 'sqlite');
    const r = await repo.getHopCounts({ sourceIds: ['src-a'] });

    expect(r.entries.find((e: { nodeNum: number }) => e.nodeNum === 98)).toBeUndefined();
    close();
  });

  it('keeps sources independent when one has a pending row and the other does not', async () => {
    const { sqlite, db, close } = createTestDb();
    const now = Date.now();
    const ins = sqlite.prepare(INSERT);
    ins.run(1, 99, '!00000001', '!00000063', 'src-a', null, now, now);
    ins.run(1, 99, '!00000001', '!00000063', 'src-b', '[10,20,30,40]', now, now);

    const repo = new AnalysisRepository(db, 'sqlite');
    const r = await repo.getHopCounts({ sourceIds: ['src-a', 'src-b'] });

    expect(r.entries.find((e: { nodeNum: number; sourceId: string }) => e.nodeNum === 99 && e.sourceId === 'src-a')).toBeUndefined();
    expect(r.entries.find((e: { nodeNum: number; sourceId: string }) => e.nodeNum === 99 && e.sourceId === 'src-b')?.hops).toBe(4);
    close();
  });
});
