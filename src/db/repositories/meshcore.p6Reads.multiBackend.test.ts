/**
 * P6 (#6263) WP1 repository reads on SQLite, PostgreSQL and MySQL: node and
 * message counts, heard-since order/limit, listMessages key-access parity with
 * searchMessages, payload-type counts, node activity, direct-heard stats and
 * initiated-trace grouping. Every read is source-scoped.
 *
 * PG/MySQL tables come from the migration registry in a private database each.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import * as schema from '../schema/index.js';
import { registry } from '../migrations.js';
import {
  readAppliedMigrationsPostgres,
  markMigrationAppliedPostgres,
  readAppliedMigrationsMysql,
  markMigrationAppliedMysql,
  runLedgeredMigrations,
} from '../migrationLedger.js';
import { MeshCoreRepository, type MeshCoreMessageScope } from './meshcore.js';
import { MeshCoreHopSnrRepository, type MeshCoreHopSnrRow } from './meshcoreHopSnr.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from './test-utils.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const A = 'p6-src-a';
const B = 'p6-src-b';
const NOW = 1_790_000_000_000;
const MIN = 60_000;
const pk = (c: string) => c.repeat(64);

interface Ctx {
  repo: MeshCoreRepository;
  hop: MeshCoreHopSnrRepository;
  reset: () => Promise<void>;
}

function hopRow(over: Partial<MeshCoreHopSnrRow>): MeshCoreHopSnrRow {
  return {
    sourceId: A, traceTag: 1, authCode: 9, hopIndex: 0, hopCount: 2, hashBytes: 1,
    senderPublicKey: pk('a'), senderHash: 'aa', senderCandidates: 1,
    receiverPublicKey: pk('b'), receiverHash: 'bb', receiverCandidates: 1,
    snrQuarterDb: 20, initiated: true, timestamp: NOW, ...over,
  };
}

function suite(getCtx: () => Ctx) {
  beforeEach(async () => { await getCtx().reset(); });

  it('counts nodes and active nodes per source', async () => {
    const { repo } = getCtx();
    await repo.upsertNode({ publicKey: pk('1'), name: 'one', lastHeard: NOW }, A);
    await repo.upsertNode({ publicKey: pk('2'), name: 'two', lastHeard: NOW - 3 * 60 * MIN }, A);
    await repo.upsertNode({ publicKey: pk('3'), name: 'three', lastHeard: NOW }, B);
    expect(await repo.countNodesBySource(A)).toBe(2);
    expect(await repo.countNodesBySource(B)).toBe(1);
    expect(await repo.countNodesBySource('nope')).toBe(0);
    expect(await repo.countActiveNodesBySource(A, NOW - 2 * 60 * MIN)).toBe(1);
    expect(await repo.countActiveNodesBySource(B, NOW - 2 * 60 * MIN)).toBe(1);
  });

  it('getNodesHeardSince orders by lastHeard desc, honours window and limit, stays in source', async () => {
    const { repo } = getCtx();
    await repo.upsertNode({ publicKey: pk('1'), lastHeard: NOW - 3 * MIN }, A);
    await repo.upsertNode({ publicKey: pk('2'), lastHeard: NOW - MIN }, A);
    await repo.upsertNode({ publicKey: pk('3'), lastHeard: NOW - 2 * MIN }, A);
    await repo.upsertNode({ publicKey: pk('4'), lastHeard: NOW - 90 * MIN }, A);
    await repo.upsertNode({ publicKey: pk('5'), lastHeard: NOW }, B);
    const all = await repo.getNodesHeardSince(A, NOW - 10 * MIN, 10);
    expect(all.map((n) => n.publicKey)).toEqual([pk('2'), pk('3'), pk('1')]);
    expect((await repo.getNodesHeardSince(A, NOW - 10 * MIN, 2)).map((n) => n.publicKey)).toEqual([pk('2'), pk('3')]);
    expect(await repo.getNodesHeardSince(A, NOW - 10 * MIN, 0)).toEqual([]);
  });

  async function seedMessages() {
    const { repo } = getCtx();
    const base = { text: 't', timestamp: NOW, createdAt: NOW };
    await repo.insertMessage({ id: 'c1', fromPublicKey: 'channel-1', fromName: 'X', ...base, createdAt: NOW - MIN }, A);
    await repo.insertMessage({ id: 'c9', fromPublicKey: 'channel-9', fromName: 'X', ...base, createdAt: NOW - 2 * MIN }, A);
    await repo.insertMessage({
      id: 'k1', fromPublicKey: 'channel-1', fromName: 'X', ...base, createdAt: NOW - 3 * MIN,
      keySourceId: 'other', keyChannelIdx: 1, keyFingerprint: 'ff00ff00ff00ff00',
    }, A);
    await repo.insertMessage({ id: 'dm', fromPublicKey: pk('e'), toPublicKey: pk('f'), ...base, createdAt: NOW - 4 * MIN }, A);
    await repo.insertMessage({ id: 'old', fromPublicKey: 'channel-1', fromName: 'X', ...base, createdAt: NOW - 90 * MIN }, A);
    await repo.insertMessage({ id: 'react', fromPublicKey: 'channel-1', fromName: 'X', ...base, reactionEmoji: 'x', createdAt: NOW }, A);
    await repo.insertMessage({ id: 'other', fromPublicKey: 'channel-1', fromName: 'X', ...base }, B);
  }

  it('countMessagesSince counts a source window, not reactions or other sources', async () => {
    const { repo } = getCtx();
    await seedMessages();
    expect(await repo.countMessagesSince(A, NOW - 10 * MIN)).toBe(4);
    expect(await repo.countMessagesSince(B, NOW - 10 * MIN)).toBe(1);
    expect(await repo.countMessagesSince(A, NOW + MIN)).toBe(0);
  });

  it('listMessages matches searchMessages visibility for every scope and key-access shape', async () => {
    const { repo } = getCtx();
    await seedMessages();
    const scopes: MeshCoreMessageScope[][] = [
      [{ sourceId: A, channels: 'all', includeDms: true }],
      [{ sourceId: A, channels: 'all', includeDms: false }],
      [{ sourceId: A, channels: [1], includeDms: false }],
      [{ sourceId: A, channels: [9], includeDms: true }],
      [{ sourceId: A, channels: 'all', includeDms: true, keyAccess: [] }],
      [{ sourceId: A, channels: 'all', includeDms: true, keyAccess: ['ff00ff00ff00ff00'] }],
      [{ sourceId: A, channels: 'all', includeDms: true, keyAccess: ['0000000000000000'] }],
      [{ sourceId: A, channels: [], includeDms: false }],
      [{ sourceId: A, channels: [1], includeDms: false }, { sourceId: B, channels: 'all', includeDms: false }],
      [],
    ];
    for (const s of scopes) {
      const listed = (await repo.listMessages({ scopes: s, limit: 100 })).map((m) => m.id).sort();
      const searched = (await repo.searchMessages({ query: '', scopes: s, limit: 100 })).messages.map((m) => m.id).sort();
      expect(listed, JSON.stringify(s)).toEqual(searched);
    }
    // The key gate really bites: unkeyed-only hides k1, matching fingerprint shows it.
    const ids = async (keyAccess: 'all' | string[]) =>
      (await repo.listMessages({ scopes: [{ sourceId: A, channels: 'all', includeDms: true, keyAccess }], limit: 100 })).map((m) => m.id);
    expect(await ids([])).not.toContain('k1');
    expect(await ids(['ff00ff00ff00ff00'])).toContain('k1');
  });

  it('listMessages orders by arrival, filters since/channel/keys, pages', async () => {
    const { repo } = getCtx();
    await seedMessages();
    const scopes: MeshCoreMessageScope[] = [{ sourceId: A, channels: 'all', includeDms: true }];
    expect((await repo.listMessages({ scopes, limit: 100 })).map((m) => m.id)).toEqual(['c1', 'c9', 'k1', 'dm', 'old']);
    expect((await repo.listMessages({ scopes, since: NOW - 10 * MIN })).map((m) => m.id)).toEqual(['c1', 'c9', 'k1', 'dm']);
    expect((await repo.listMessages({ scopes, channelIdx: 9 })).map((m) => m.id)).toEqual(['c9']);
    expect((await repo.listMessages({ scopes, fromPublicKey: pk('e') })).map((m) => m.id)).toEqual(['dm']);
    expect((await repo.listMessages({ scopes, toPublicKey: pk('f') })).map((m) => m.id)).toEqual(['dm']);
    expect((await repo.listMessages({ scopes, limit: 2, offset: 1 })).map((m) => m.id)).toEqual(['c9', 'k1']);
  });

  async function seedPackets() {
    const { repo } = getCtx();
    const p = (o: Record<string, unknown>) => repo.insertPacket({
      sourceId: A, timestamp: NOW, payloadType: 4, payloadTypeName: 'ADVERT', routeType: 1, routeTypeName: 'FLOOD',
      hopCount: 2, rawHex: 'aa', createdAt: NOW, ...o,
    } as never);
    await p({ senderPubKey: pk('a'), srcHash: 'aa', hopCount: 0, snr: 4, rssi: -90, timestamp: NOW - MIN });
    await p({ senderPubKey: pk('a'), srcHash: 'aa', hopCount: 0, snr: 9, rssi: -100, timestamp: NOW });
    await p({ senderPubKey: pk('a'), srcHash: 'aa', hopCount: 3 });
    await p({ senderPubKey: null, srcHash: 'cc', hopCount: 0, snr: 1, rssi: -50, payloadType: 2, payloadTypeName: 'TXT_MSG' });
    await p({ senderPubKey: null, srcHash: null, hopCount: 0, payloadType: 5, payloadTypeName: 'GRP_TXT' });
    await p({ senderPubKey: pk('d'), srcHash: 'dd', hopCount: 1, timestamp: NOW - 2 * 60 * MIN });
    await p({ sourceId: B, senderPubKey: pk('z'), srcHash: 'zz', hopCount: 0 });
  }

  it('getPacketCountsByPayloadTypeSince counts receptions per type in-window and in-source', async () => {
    const { repo } = getCtx();
    await seedPackets();
    const rows = await repo.getPacketCountsByPayloadTypeSince(A, NOW - 10 * MIN);
    expect(rows).toEqual([
      { payloadType: 4, payloadTypeName: 'ADVERT', count: 3 },
      { payloadType: 2, payloadTypeName: 'TXT_MSG', count: 1 },
      { payloadType: 5, payloadTypeName: 'GRP_TXT', count: 1 },
    ]);
    expect((await repo.getPacketCountsByPayloadTypeSince('nope', 0))).toEqual([]);
  });

  it('getNodeActivity groups on key else hash and reports unattributed', async () => {
    const { repo } = getCtx();
    await seedPackets();
    const r = await repo.getNodeActivity({ sourceId: A, since: NOW - 10 * MIN });
    expect(r.unattributed).toBe(1);
    expect(r.senders).toEqual([
      { senderPubKey: pk('a'), srcHash: null, count: 3, lastHeard: NOW },
      { senderPubKey: null, srcHash: 'cc', count: 1, lastHeard: NOW },
    ]);
    const wide = await repo.getNodeActivity({ sourceId: A, since: 0 });
    expect(wide.senders.map((s) => s.senderPubKey ?? s.srcHash)).toContain(pk('d'));
  });

  it('getOldestTimestamp is per source and null when empty', async () => {
    const { repo } = getCtx();
    expect(await repo.getOldestTimestamp(A)).toBeNull();
    await seedPackets();
    expect(await repo.getOldestTimestamp(A)).toBe(NOW - 2 * 60 * MIN);
    expect(await repo.getOldestTimestamp(B)).toBe(NOW);
  });

  it('getDirectHeardStats uses only hopCount=0 rows, best signal, newest first', async () => {
    const { repo } = getCtx();
    await seedPackets();
    const r = await repo.getDirectHeardStats(A, NOW - 10 * MIN);
    expect(r).toEqual([
      { senderPubKey: pk('a'), srcHash: null, count: 2, lastHeard: NOW, bestSnr: 9, bestRssi: -90 },
      { senderPubKey: null, srcHash: 'cc', count: 1, lastHeard: NOW, bestSnr: 1, bestRssi: -50 },
    ]);
    expect((await repo.getDirectHeardStats(B, NOW - 10 * MIN)).map((x) => x.senderPubKey)).toEqual([pk('z')]);
  });

  it('getInitiatedTraces groups by trace, newest first, dedupes hops, honours limit/window/source', async () => {
    const { hop } = getCtx();
    await hop.insertHops(A, [
      hopRow({ traceTag: 1, hopIndex: 0, timestamp: NOW - 5 * MIN }),
      hopRow({ traceTag: 1, hopIndex: 1, timestamp: NOW - 5 * MIN, senderPublicKey: pk('b'), receiverPublicKey: pk('c') }),
      hopRow({ traceTag: 2, hopIndex: 0, timestamp: NOW - MIN, snrQuarterDb: 11 }),
      hopRow({ traceTag: 2, hopIndex: 0, timestamp: NOW - MIN, snrQuarterDb: 12 }), // duplicate index, newer id wins
      hopRow({ traceTag: 3, hopIndex: 0, timestamp: NOW, initiated: false }),
      hopRow({ traceTag: 4, hopIndex: 0, timestamp: NOW - 120 * MIN }),
    ]);
    await hop.insertHops(B, [hopRow({ sourceId: B, traceTag: 5, timestamp: NOW })]);
    const traces = await hop.getInitiatedTraces(A, NOW - 60 * MIN, 10);
    expect(traces.map((t) => t[0].traceTag)).toEqual([2, 1]);
    expect(traces[1].map((r) => r.hopIndex)).toEqual([0, 1]);
    expect(traces[0]).toHaveLength(1);
    expect(traces[0][0].snrQuarterDb).toBe(12);
    expect((await hop.getInitiatedTraces(A, NOW - 60 * MIN, 1)).map((t) => t[0].traceTag)).toEqual([2]);
    expect(await hop.getInitiatedTraces(A, NOW - 60 * MIN, 0)).toEqual([]);
    // Shares grouping with getLatestInitiatedTraceFor.
    const latest = await hop.getLatestInitiatedTraceFor(A, pk('b'), NOW - 60 * MIN);
    expect(latest.map((r) => [r.traceTag, r.hopIndex, r.snrQuarterDb])).toEqual(
      traces.find((t) => t[0].traceTag === 2)!.map((r) => [r.traceTag, r.hopIndex, r.snrQuarterDb]),
    );
  });
}

describe('P6 repository reads — SQLite', () => {
  let testDb: ReturnType<typeof createTestDb>;
  const ctx = {} as Ctx;
  beforeEach(() => {
    testDb?.close();
    testDb = createTestDb();
    ctx.repo = new MeshCoreRepository(testDb.db as never, 'sqlite');
    ctx.hop = new MeshCoreHopSnrRepository(testDb.db as never, 'sqlite');
    ctx.reset = async () => {};
  });
  afterAll(() => testDb?.close());
  suite(() => ctx);
});

describe.skipIf(!postgresAvailable)('P6 repository reads — PostgreSQL', () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedPostgresDatabase>>;
  const ctx = {} as Ctx;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase('mcp6reads');
    const client = await isolated.pool.connect();
    try {
      await runLedgeredMigrations({
        backend: 'PostgreSQL', handle: client, migrations: registry.getAll(), pick: (m) => m.postgres,
        readApplied: readAppliedMigrationsPostgres, markApplied: markMigrationAppliedPostgres,
      });
    } finally {
      client.release();
    }
    const db = drizzlePostgres(isolated.pool, { schema });
    ctx.repo = new MeshCoreRepository(db as never, 'postgres');
    ctx.hop = new MeshCoreHopSnrRepository(db as never, 'postgres');
    ctx.reset = async () => {
      await isolated.pool.query('TRUNCATE meshcore_messages, meshcore_nodes, meshcore_packet_log, meshcore_hop_snr RESTART IDENTITY CASCADE');
    };
  }, 120_000);
  afterAll(async () => { await isolated?.cleanup(); });
  suite(() => ctx);
});

describe.skipIf(!mysqlAvailable)('P6 repository reads — MySQL', () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedMysqlDatabase>>;
  const ctx = {} as Ctx;
  beforeAll(async () => {
    isolated = await createIsolatedMysqlDatabase('mcp6reads');
    await runLedgeredMigrations({
      backend: 'MySQL', handle: isolated.pool, migrations: registry.getAll(), pick: (m) => m.mysql,
      readApplied: readAppliedMigrationsMysql, markApplied: markMigrationAppliedMysql,
    });
    const db = drizzleMysql(isolated.pool, { schema, mode: 'default' });
    ctx.repo = new MeshCoreRepository(db as never, 'mysql');
    ctx.hop = new MeshCoreHopSnrRepository(db as never, 'mysql');
    ctx.reset = async () => {
      for (const t of ['meshcore_messages', 'meshcore_nodes', 'meshcore_packet_log', 'meshcore_hop_snr']) {
        await isolated.pool.query(`TRUNCATE TABLE ${t}`);
      }
    };
  }, 180_000);
  afterAll(async () => { await isolated?.cleanup(); });
  suite(() => ctx);
});
