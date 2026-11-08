/**
 * MeshCore phase of `AnalysisRepository.getPositions`, `getCoverageGrid`
 * nodeKey dedup, and `getHopCounts` from `meshcore_nodes.path_len` (#6260 P5),
 * on SQLite, PostgreSQL and MySQL.
 *
 * The PG/MySQL halves build their tables from the Drizzle schema inside their
 * own isolated database and skip silently when the containers are down —
 * confirm coverage via `numPendingTests`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import type pg from 'pg';
import type mysql from 'mysql2/promise';
import * as schema from '../schema/index.js';
import { buildActiveSchema } from '../activeSchema.js';
import { AnalysisRepository, type AnalysisDbType } from './analysis.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';
import { postgresCreateTable, mysqlCreateTable } from '../../server/test-helpers/drizzleDdl.js';
import { nodeNumFromPubkey } from '../../utils/meshcoreNodeNum.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from './test-utils.js';

const NOW = 1_760_000_000_000;
const SINCE = NOW - 3_600_000;

const pk = (c: string) => c.repeat(64);
const PK_A = pk('a');
const PK_B = pk('b');
const PK_C = pk('c');
// Same last 8 hex digits as PK_A => the same synthetic nodeNum.
const PK_A_TWIN = 'f'.repeat(56) + 'a'.repeat(8);

interface Fixture {
  repo: AnalysisRepository;
  dbType: AnalysisDbType;
  db: any;
  tables: any;
}

async function insertFix(fx: Fixture, nodeNum: number, ts: number, lat: number, lon: number, sourceId = 'mt-1') {
  const rows = [
    { nodeId: `!${nodeNum.toString(16).padStart(8, '0')}`, nodeNum, telemetryType: 'latitude', timestamp: ts, value: lat, createdAt: ts, sourceId },
    { nodeId: `!${nodeNum.toString(16).padStart(8, '0')}`, nodeNum, telemetryType: 'longitude', timestamp: ts, value: lon, createdAt: ts, sourceId },
  ];
  await fx.db.insert(fx.tables.telemetry).values(rows);
}

async function insertHistory(fx: Fixture, sourceId: string, publicKey: string, ts: number, lat: number, lon: number) {
  await fx.db
    .insert(fx.tables.meshcorePositionHistory)
    .values({ sourceId, publicKey, latitude: lat, longitude: lon, timestamp: ts, createdAt: ts });
}

async function insertNode(
  fx: Fixture,
  sourceId: string,
  publicKey: string,
  extra: Record<string, unknown> = {},
) {
  await fx.db
    .insert(fx.tables.meshcoreNodes)
    .values({ sourceId, publicKey, createdAt: NOW, updatedAt: NOW, ...extra });
}

/** Walk every page from a fresh cursor, collecting items and cursors. */
async function drain(fx: Fixture, pageSize: number, sourceIds: string[]) {
  const items: any[] = [];
  const cursors: Array<string | null> = [];
  let cursor: string | null = null;
  for (let i = 0; i < 20; i++) {
    const page: any = await fx.repo.getPositions({ sourceIds, sinceMs: SINCE, pageSize, cursor });
    items.push(...page.items);
    cursors.push(page.nextCursor);
    if (!page.hasMore) break;
    cursor = page.nextCursor;
  }
  return { items, cursors };
}

function sharedTests(getFx: () => Fixture) {
  it('hands over from the Meshtastic phase to the MeshCore phase', async () => {
    const fx = getFx();
    await insertFix(fx, 1, NOW - 1000, 30, -90);
    await insertHistory(fx, 'mc-1', PK_A, NOW - 2000, 40, -100);

    const first = await fx.repo.getPositions({ sourceIds: ['mt-1', 'mc-1'], sinceMs: SINCE, pageSize: 10 });
    expect(first.items.map((i) => i.nodeKey)).toEqual(['mt:1']);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBe('mc:');

    const second = await fx.repo.getPositions({
      sourceIds: ['mt-1', 'mc-1'], sinceMs: SINCE, pageSize: 10, cursor: first.nextCursor,
    });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]).toMatchObject({
      sourceId: 'mc-1',
      publicKey: PK_A,
      nodeKey: `mc:${PK_A}`,
      nodeNum: nodeNumFromPubkey(PK_A),
      latitude: 40,
      longitude: -100,
    });
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
  });

  it('hands over (does not end) when the Meshtastic phase has no rows at all', async () => {
    const fx = getFx();
    await insertHistory(fx, 'mc-1', PK_A, NOW - 2000, 40, -100);

    const first = await fx.repo.getPositions({ sourceIds: ['mc-1'], sinceMs: SINCE, pageSize: 10 });
    expect(first.items).toEqual([]);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBe('mc:');

    const { items } = await drain(fx, 10, ['mc-1']);
    expect(items.map((i) => i.nodeKey)).toEqual([`mc:${PK_A}`]);
  });

  it('keeps an unprefixed (pre-MeshCore) cursor in the Meshtastic phase', async () => {
    const fx = getFx();
    await insertFix(fx, 1, NOW - 1000, 30, -90);
    await insertFix(fx, 1, NOW - 2000, 31, -91);
    await insertFix(fx, 1, NOW - 3000, 32, -92);

    const p1 = await fx.repo.getPositions({ sourceIds: ['mt-1'], sinceMs: SINCE, pageSize: 1 });
    expect(p1.hasMore).toBe(true);
    expect(p1.nextCursor).not.toBeNull();
    expect(p1.nextCursor!.startsWith('mc:')).toBe(false);

    const { items } = await drain(fx, 1, ['mt-1']);
    expect(items.map((i) => i.latitude)).toEqual([30, 31, 32]);
  });

  it('pages MeshCore history newest first with no repeats', async () => {
    const fx = getFx();
    await insertHistory(fx, 'mc-1', PK_A, NOW - 3000, 1, 1);
    await insertHistory(fx, 'mc-1', PK_A, NOW - 1000, 3, 3);
    await insertHistory(fx, 'mc-1', PK_B, NOW - 2000, 2, 2);
    // Same timestamp: the id tiebreak must still page it exactly once.
    await insertHistory(fx, 'mc-1', PK_B, NOW - 2000, 2.5, 2.5);
    // Outside the window and on an unlisted source.
    await insertHistory(fx, 'mc-1', PK_A, SINCE - 10, 9, 9);
    await insertHistory(fx, 'mc-other', PK_A, NOW - 500, 8, 8);

    const { items } = await drain(fx, 2, ['mc-1']);
    expect(items.map((i) => i.latitude).sort()).toEqual([1, 2, 2.5, 3]);
    const ts = items.map((i) => i.timestamp);
    expect(ts).toEqual([...ts].sort((a, b) => b - a));
  });

  it('adds one current fix per positioned node on the first MeshCore page only', async () => {
    const fx = getFx();
    await insertNode(fx, 'mc-1', PK_A, { latitude: 41, longitude: -101, lastHeard: NOW - 500 });
    // Stale: lastHeard before the window.
    await insertNode(fx, 'mc-1', PK_B, { latitude: 42, longitude: -102, lastHeard: SINCE - 1 });
    // No position.
    await insertNode(fx, 'mc-1', PK_C, { lastHeard: NOW - 400 });
    // Null Island.
    await insertNode(fx, 'mc-1', pk('d'), { latitude: 0, longitude: 0, lastHeard: NOW - 400 });
    // Unlisted source.
    await insertNode(fx, 'mc-other', pk('e'), { latitude: 43, longitude: -103, lastHeard: NOW - 400 });
    await insertHistory(fx, 'mc-1', PK_A, NOW - 9000, 40, -100);
    await insertHistory(fx, 'mc-1', PK_A, NOW - 8000, 40.5, -100.5);

    const p1: any = await fx.repo.getPositions({ sourceIds: ['mc-1'], sinceMs: SINCE, pageSize: 1, cursor: 'mc:' });
    const current = p1.items.filter((i: any) => i.latitude === 41);
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ publicKey: PK_A, nodeKey: `mc:${PK_A}`, timestamp: NOW - 500, altitude: null });
    expect(p1.items.some((i: any) => i.latitude === 42 || i.latitude === 43 || i.latitude === 0)).toBe(false);
    expect(p1.hasMore).toBe(true);

    const p2: any = await fx.repo.getPositions({
      sourceIds: ['mc-1'], sinceMs: SINCE, pageSize: 5, cursor: p1.nextCursor,
    });
    expect(p2.items.some((i: any) => i.latitude === 41)).toBe(false);
  });

  it('dedups coverage cells by nodeKey, not the synthetic nodeNum', async () => {
    const fx = getFx();
    expect(nodeNumFromPubkey(PK_A)).toBe(nodeNumFromPubkey(PK_A_TWIN));
    // Two distinct nodes with the same synthetic nodeNum, one cell: count 2.
    await insertHistory(fx, 'mc-1', PK_A, NOW - 1000, 40.0001, -100.0001);
    await insertHistory(fx, 'mc-1', PK_A_TWIN, NOW - 2000, 40.0002, -100.0002);
    // The same node twice in that cell stays one.
    await insertHistory(fx, 'mc-1', PK_A, NOW - 3000, 40.0003, -100.0003);

    const grid = await fx.repo.getCoverageGrid({ sourceIds: ['mc-1'], sinceMs: SINCE, zoom: 3 });
    expect(grid.cells).toHaveLength(1);
    expect(grid.cells[0].count).toBe(2);
  });

  it('counts coverage across both phases', async () => {
    const fx = getFx();
    await insertFix(fx, 1, NOW - 1000, 10.0001, 10.0001);
    await insertHistory(fx, 'mc-1', PK_A, NOW - 1000, 10.0002, 10.0002);
    const grid = await fx.repo.getCoverageGrid({ sourceIds: ['mt-1', 'mc-1'], sinceMs: SINCE, zoom: 3 });
    expect(grid.cells.reduce((n, c) => n + c.count, 0)).toBe(2);
  });

  it('reads MeshCore hop counts from path_len, skipping unknown, sentinel and local', async () => {
    const fx = getFx();
    await insertNode(fx, 'mc-1', PK_A, { pathLen: 2 });
    await insertNode(fx, 'mc-1', PK_B, { pathLen: 0 });
    await insertNode(fx, 'mc-1', PK_C, { pathLen: null });
    await insertNode(fx, 'mc-1', pk('d'), { pathLen: 255 });
    await insertNode(fx, 'mc-1', pk('e'), { pathLen: -1 });
    await insertNode(fx, 'mc-1', pk('1'), { pathLen: 1, isLocalNode: true });
    await insertNode(fx, 'mc-2', pk('2'), { pathLen: 3 });

    const r = await fx.repo.getHopCounts({
      sourceIds: ['mc-1', 'mc-2'],
      localNodeNums: new Map(),
      meshcoreSourceIds: ['mc-1'],
    });
    const byKey = new Map(r.entries.map((e) => [e.nodeKey, e]));
    expect([...byKey.keys()].sort()).toEqual([`mc:${PK_A}`, `mc:${PK_B}`].sort());
    expect(byKey.get(`mc:${PK_A}`)).toMatchObject({
      sourceId: 'mc-1', hops: 2, publicKey: PK_A, nodeNum: nodeNumFromPubkey(PK_A),
    });
    expect(byKey.get(`mc:${PK_B}`)?.hops).toBe(0);

    // Not asked for: no MeshCore entries at all.
    const none = await fx.repo.getHopCounts({ sourceIds: ['mc-1'], localNodeNums: new Map() });
    expect(none.entries).toEqual([]);
  });
}

describe('AnalysisRepository MeshCore positions — SQLite', () => {
  let sqlite: Database.Database;
  let fx: Fixture;

  beforeEach(() => {
    const t = createTestDb();
    sqlite = t.sqlite;
    // Telemetry rows reference nodes by FK in the real schema; these fixtures
    // do not seed Meshtastic nodes.
    sqlite.pragma('foreign_keys = OFF');
    fx = {
      repo: new AnalysisRepository(t.db as any, 'sqlite'),
      dbType: 'sqlite',
      db: t.db,
      tables: buildActiveSchema('sqlite'),
    };
  });
  afterEach(() => sqlite.close());

  sharedTests(() => fx);
});

const TABLES = ['telemetry', 'meshcoreNodes', 'meshcorePositionHistory'] as const;

describe.skipIf(!postgresAvailable)('AnalysisRepository MeshCore positions — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanupDb: (() => Promise<void>) | undefined;
  let fx: Fixture;

  beforeAll(async () => {
    ({ pool, cleanup: cleanupDb } = await createIsolatedPostgresDatabase('anmcpos'));
    const tables = buildActiveSchema('postgres') as any;
    for (const t of TABLES) {
      // The DDL helper omits identity generation; the history table's id needs it.
      const ddl = postgresCreateTable(tables[t]).replace(
        '"id" integer PRIMARY KEY',
        '"id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY',
      );
      for (const statement of ddl.split(';\n')) await pool.query(statement);
    }
    const db = drizzlePostgres(pool, { schema }) as any;
    fx = { repo: new AnalysisRepository(db, 'postgres'), dbType: 'postgres', db, tables };
  }, 60_000);
  afterAll(async () => {
    await cleanupDb?.();
  });
  beforeEach(async () => {
    for (const t of ['telemetry', 'meshcore_nodes', 'meshcore_position_history']) {
      await pool.query(`DELETE FROM ${t}`);
    }
  });

  sharedTests(() => fx);
});

describe.skipIf(!mysqlAvailable)('AnalysisRepository MeshCore positions — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanupDb: (() => Promise<void>) | undefined;
  let fx: Fixture;

  beforeAll(async () => {
    ({ pool, cleanup: cleanupDb } = await createIsolatedMysqlDatabase('anmcpos'));
    const tables = buildActiveSchema('mysql') as any;
    for (const t of TABLES) await pool.query(mysqlCreateTable(tables[t]));
    const db = drizzleMysql(pool, { schema, mode: 'default' }) as any;
    fx = { repo: new AnalysisRepository(db, 'mysql'), dbType: 'mysql', db, tables };
  }, 60_000);
  afterAll(async () => {
    await cleanupDb?.();
  });
  beforeEach(async () => {
    for (const t of ['telemetry', 'meshcore_nodes', 'meshcore_position_history']) {
      await pool.query(`DELETE FROM ${t}`);
    }
  });

  sharedTests(() => fx);
});
