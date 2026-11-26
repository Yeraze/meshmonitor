/**
 * CoverageWalkaboutRepository on SQLite, PostgreSQL and MySQL (#5891 P1).
 * PG/MySQL suites own an isolated database (`isolationKey: 'covwk'`) and skip
 * when no container listens; confirm via `numPendingTests`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import type pg from 'pg';
import type mysql from 'mysql2/promise';
import * as schema from '../schema/index.js';
import {
  CoverageWalkaboutRepository,
  type NewWalkaboutReception,
  type NewWalkaboutSample,
} from './coverageWalkabout.js';
import { runMigration248Postgres, runMigration248Mysql } from '../../server/migrations/248_create_coverage_walkabout.js';
import { runMigration250Postgres, runMigration250Mysql } from '../../server/migrations/250_add_walkabout_session_import_id.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from './test-utils.js';

const NOW = 1_760_000_000_000;
const BIG_NODE_NUM = 0xaabbccdd; // > 2^31

const sample = (sessionId: string, o: Partial<NewWalkaboutSample> = {}): NewWalkaboutSample => ({
  sessionId, sourceId: 'src-a', latitude: 40.123456, longitude: -105.654321, accuracyM: 12.5,
  deviceFixAt: NOW, fixAt: NOW - 500, receivedAt: NOW, ...o,
});

const reception = (sessionId: string, o: Partial<NewWalkaboutReception> = {}): NewWalkaboutReception => ({
  sessionId, sourceId: 'src-a', protocol: 'meshtastic', creditedKey: '!aabbccdd',
  creditedNodeNum: BIG_NODE_NUM, creditKind: 'direct', hopsAway: 0, packetKey: '!11111111:100',
  snr: 5.5, rssi: 0, heardAt: NOW, sampleId: null, latitude: 40.1, longitude: -105.1,
  accuracyM: 10, sampleAgeMs: 400, ...o,
});

function runShared(getRepo: () => CoverageWalkaboutRepository) {
  const start = (id: string, startedAt = NOW, sourceId = 'src-a') =>
    getRepo().createSession({ id, sourceId, name: null, startedAt, startedBy: 1 });

  it('creates, reads, lists newest first and ends a session once', async () => {
    const repo = getRepo();
    await start('s1', NOW);
    await start('s2', NOW + 1000);
    expect((await repo.getSession('src-a', 's1'))?.endedAt).toBeNull();
    expect((await repo.getOpenSession('src-a'))?.id).toBe('s2');
    expect((await repo.listSessions('src-a')).map((s) => s.id)).toEqual(['s2', 's1']);
    expect(await repo.endSession('src-a', 's2', NOW + 5000, 'user')).toBe(true);
    expect(await repo.endSession('src-a', 's2', NOW + 6000, 'cap')).toBe(false);
    const ended = await repo.getSession('src-a', 's2');
    expect(ended?.endReason).toBe('user');
    expect(ended?.endedAt).toBe(NOW + 5000);
    expect((await repo.getOpenSessionsAllSources()).map((s) => s.id)).toEqual(['s1']);
  });

  it('inserts samples with an id and returns the latest by deviceFixAt', async () => {
    const repo = getRepo();
    await start('s1');
    const a = await repo.insertSample(sample('s1', { deviceFixAt: NOW + 10 }));
    const b = await repo.insertSample(sample('s1', { deviceFixAt: NOW + 5 }));
    expect(typeof a.id).toBe('number');
    expect(b.id).not.toBe(a.id);
    expect((await repo.getLatestSample('src-a', 's1'))?.id).toBe(a.id);
    expect(await repo.getLatestSample('src-a', 'none')).toBeNull();
  });

  it('round-trips a bigint node number and keeps rssi 0', async () => {
    const repo = getRepo();
    await start('s1');
    expect(await repo.recordReception(reception('s1'))).toBe(true);
    const counts = await repo.getCounts('src-a', 's1');
    expect(counts.receptions).toBe(1);
    expect(counts.nodes).toBe(1);
    // read back through the drizzle table to confirm the stored value
    const rows = await (repo as any).db.select().from((repo as any).tables.coverageWalkaboutReceptions);
    expect(Number(rows[0].creditedNodeNum)).toBe(BIG_NODE_NUM);
    expect(rows[0].rssi).toBe(0);
  });

  it('returns false for a duplicate reception, true for another relayer', async () => {
    const repo = getRepo();
    await start('s1');
    expect(await repo.recordReception(reception('s1'))).toBe(true);
    expect(await repo.recordReception(reception('s1'))).toBe(false);
    expect(await repo.recordReception(reception('s1', { creditedKey: '!bbbbbbbb', creditedNodeNum: 0xbbbbbbbb }))).toBe(true);
    expect((await repo.getCounts('src-a', 's1')).receptions).toBe(2);
  });

  it('counts per session in list and getCounts', async () => {
    const repo = getRepo();
    await start('s1');
    await start('s2', NOW + 1);
    await repo.insertSample(sample('s1', { receivedAt: NOW + 7 }));
    await repo.insertSample(sample('s1', { receivedAt: NOW + 9 }));
    await repo.recordReception(reception('s1'));
    await repo.recordReception(reception('s1', { packetKey: '!11111111:101' }));
    await repo.recordReception(reception('s1', { packetKey: '!11111111:102', creditedKey: '!cccccccc', creditedNodeNum: 0xcccccccc }));
    expect(await repo.getCounts('src-a', 's1')).toEqual({ samples: 2, receptions: 3, nodes: 2, lastSampleAt: NOW + 9 });
    expect(await repo.getCounts('src-a', 's2')).toEqual({ samples: 0, receptions: 0, nodes: 0, lastSampleAt: null });
    const list = await repo.listSessions('src-a');
    const s1 = list.find((s) => s.id === 's1')!;
    expect([s1.sampleCount, s1.receptionCount, s1.nodeCount, s1.lastSampleAt]).toEqual([2, 3, 2, NOW + 9]);
    const s2 = list.find((s) => s.id === 's2')!;
    expect([s2.sampleCount, s2.receptionCount, s2.nodeCount, s2.lastSampleAt]).toEqual([0, 0, 0, null]);
  });

  it('deleteSession removes children; deleteForSource spares other sources', async () => {
    const repo = getRepo();
    await start('s1');
    await start('s9', NOW, 'src-b');
    await repo.insertSample(sample('s1'));
    await repo.recordReception(reception('s1'));
    await repo.insertSample(sample('s9', { sourceId: 'src-b' }));
    expect(await repo.deleteSession('src-a', 's1')).toBe(true);
    expect(await repo.deleteSession('src-a', 's1')).toBe(false);
    expect(await repo.getCounts('src-a', 's1')).toMatchObject({ samples: 0, receptions: 0 });
    await start('s2');
    await repo.deleteForSource('src-a');
    expect(await repo.getSession('src-a', 's2')).toBeNull();
    expect(await repo.getSession('src-b', 's9')).not.toBeNull();
    expect((await repo.getCounts('src-b', 's9')).samples).toBe(1);
  });

  it('listSessionsInRange prefilters by startedAt, newest first, and scopes by source', async () => {
    const repo = getRepo();
    const H = 3_600_000;
    await start('old3h', NOW - 3 * H);
    await start('old1h', NOW - H);
    await start('inside', NOW + 1000);
    await start('future', NOW + 10 * H);
    await start('other', NOW, 'src-b');
    const ids = (await repo.listSessionsInRange('src-a', NOW, NOW + 5000, 10)).map((s) => s.id);
    expect(ids).toEqual(['inside', 'old1h']);
    expect((await repo.listSessionsInRange('src-a', NOW, NOW + 5000, 1)).map((s) => s.id)).toEqual(['inside']);
  });

  it('getReceptionPoints filters, orders newest first, caps, and coerces numbers', async () => {
    const repo = getRepo();
    await start('s1');
    await start('s2');
    await start('sb', NOW, 'src-b');
    const rows: Array<[string, Partial<NewWalkaboutReception>]> = [
      ['s1', { packetKey: 'a', heardAt: NOW + 10, latitude: 40.1, longitude: -105.1 }],
      ['s1', { packetKey: 'b', heardAt: NOW + 20, creditedKey: '!bbbbbbbb', creditedNodeNum: 0xbbbbbbbb, snr: null, latitude: 41, longitude: -105.1 }],
      ['s2', { packetKey: 'c', heardAt: NOW + 30, latitude: 40.1, longitude: -105.1 }],
      ['s2', { packetKey: 'd', heardAt: NOW + 5000, latitude: 40.1, longitude: -105.1 }],
    ];
    for (const [sid, o] of rows) await repo.recordReception(reception(sid, o));
    await repo.recordReception(reception('sb', { sourceId: 'src-b', packetKey: 'x', heardAt: NOW + 10 }));
    const base = { sessionIds: ['s1', 's2'], sinceMs: NOW, untilMs: NOW + 100, limit: 100 };
    const all = await repo.getReceptionPoints('src-a', base);
    expect(all.map((r) => r.heardAt)).toEqual([NOW + 30, NOW + 20, NOW + 10]);
    expect(all[2].creditedNodeNum).toBe(BIG_NODE_NUM);
    expect(typeof all[2].heardAt).toBe('number');
    expect(all[2].snr).toBe(5.5);
    expect(all[1].snr).toBeNull();
    expect((await repo.getReceptionPoints('src-a', { ...base, limit: 2 })).map((r) => r.heardAt)).toEqual([NOW + 30, NOW + 20]);
    expect((await repo.getReceptionPoints('src-a', { ...base, sessionIds: ['s1'] })).length).toBe(2);
    expect((await repo.getReceptionPoints('src-a', { ...base, creditedKey: '!bbbbbbbb' })).length).toBe(1);
    expect((await repo.getReceptionPoints('src-a', { ...base, bbox: { south: 40, north: 40.5, west: -106, east: -105 } })).length).toBe(2);
    expect((await repo.getReceptionPoints('src-a', { ...base, sinceMs: NOW + 15, untilMs: NOW + 25 })).length).toBe(1);
    expect(await repo.getReceptionPoints('src-a', { ...base, sessionIds: [] })).toEqual([]);
    expect(await repo.getReceptionPoints('src-a', { ...base, sessionIds: ['sb'] })).toEqual([]);
  });

  it('getSamplePoints filters on fixAt, orders newest first, caps, and handles an antimeridian bbox', async () => {
    const repo = getRepo();
    await start('s1');
    await repo.insertSample(sample('s1', { fixAt: NOW + 10, latitude: 10, longitude: 179.9 }));
    await repo.insertSample(sample('s1', { fixAt: NOW + 20, latitude: 10, longitude: -179.9 }));
    await repo.insertSample(sample('s1', { fixAt: NOW + 30, latitude: 10, longitude: 0 }));
    await repo.insertSample(sample('s1', { fixAt: NOW + 9000, receivedAt: NOW, latitude: 10, longitude: 0 }));
    const base = { sessionIds: ['s1'], sinceMs: NOW, untilMs: NOW + 100, limit: 100 };
    const all = await repo.getSamplePoints('src-a', base);
    expect(all.map((r) => r.fixAt)).toEqual([NOW + 30, NOW + 20, NOW + 10]);
    expect(typeof all[0].latitude).toBe('number');
    expect((await repo.getSamplePoints('src-a', { ...base, limit: 1 })).map((r) => r.fixAt)).toEqual([NOW + 30]);
    const wrap = await repo.getSamplePoints('src-a', { ...base, bbox: { south: 9, north: 11, west: 179, east: -179 } });
    expect(wrap.map((r) => r.fixAt)).toEqual([NOW + 20, NOW + 10]);
    expect(await repo.getSamplePoints('src-a', { ...base, sessionIds: [] })).toEqual([]);
    expect(await repo.getSamplePoints('src-b', base)).toEqual([]);
  });

  it('refuses an empty sourceId', async () => {
    await expect(getRepo().getSession('', 's1')).rejects.toThrow(/sourceId/);
  });
}

describe('CoverageWalkaboutRepository — SQLite', () => {
  let repo: CoverageWalkaboutRepository;
  let close: () => void;
  beforeEach(() => {
    const t = createTestDb();
    close?.();
    close = () => t.sqlite.close();
    repo = new CoverageWalkaboutRepository(t.db, 'sqlite');
  });
  runShared(() => repo);
});

const TRUNC = ['coverage_walkabout_receptions', 'coverage_walkabout_samples', 'coverage_walkabout_sessions'];

describe.skipIf(!postgresAvailable)('CoverageWalkaboutRepository — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanupDb: (() => Promise<void>) | undefined;
  let repo: CoverageWalkaboutRepository;
  beforeAll(async () => {
    const isolated = await createIsolatedPostgresDatabase('covwk');
    pool = isolated.pool;
    cleanupDb = isolated.cleanup;
    const client = await pool.connect();
    try {
      await runMigration248Postgres(client);
      await runMigration250Postgres(client);
    } finally {
      client.release();
    }
    repo = new CoverageWalkaboutRepository(drizzlePostgres(pool, { schema }), 'postgres');
  });
  afterAll(async () => {
    await cleanupDb?.();
  });
  beforeEach(async () => {
    await pool.query(`TRUNCATE TABLE ${TRUNC.join(', ')} RESTART IDENTITY`);
  });
  runShared(() => repo);
});

describe.skipIf(!mysqlAvailable)('CoverageWalkaboutRepository — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanupDb: (() => Promise<void>) | undefined;
  let repo: CoverageWalkaboutRepository;
  beforeAll(async () => {
    const isolated = await createIsolatedMysqlDatabase('covwk');
    pool = isolated.pool;
    cleanupDb = isolated.cleanup;
    await runMigration248Mysql(pool);
    await runMigration250Mysql(pool);
    repo = new CoverageWalkaboutRepository(drizzleMysql(pool, { schema, mode: 'default' }), 'mysql');
  });
  afterAll(async () => {
    await cleanupDb?.();
  });
  beforeEach(async () => {
    for (const t of TRUNC) await pool.query(`TRUNCATE TABLE ${t}`);
  });
  runShared(() => repo);
});
