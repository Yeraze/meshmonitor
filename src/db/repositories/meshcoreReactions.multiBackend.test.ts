/**
 * MeshCore reaction repository methods (#5759, migration 203) on SQLite,
 * PostgreSQL and MySQL. Schema comes from the migration registry on every
 * backend; PG/MySQL run in their own isolated databases.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import * as schema from '../schema/index.js';
import { registry } from '../migrations.js';
import {
  readAppliedMigrationsPostgres, markMigrationAppliedPostgres,
  readAppliedMigrationsMysql, markMigrationAppliedMysql, runLedgeredMigrations,
} from '../migrationLedger.js';
import { MeshCoreRepository } from './meshcore.js';
import {
  postgresAvailable, mysqlAvailable, createIsolatedPostgresDatabase, createIsolatedMysqlDatabase,
} from './test-utils.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const A = 'rx-src-a';
const B = 'rx-src-b';
const NOW = 1_760_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

interface Ctx { repo: MeshCoreRepository; reset: () => Promise<void> }

type Row = Parameters<MeshCoreRepository['insertMessage']>[0];
const ch = (id: string, over: Partial<Row> = {}): Row => ({
  id, fromPublicKey: 'channel-1', toPublicKey: 'channel-1', fromName: 'Alice', text: `body ${id}`,
  timestamp: NOW, createdAt: NOW, ...over,
});
const dm = (id: string, over: Partial<Row> = {}): Row => ({
  id, fromPublicKey: 'aabbccddeeff', toPublicKey: 'self-key', text: `dm ${id}`,
  timestamp: NOW, createdAt: NOW, ...over,
});
const react = (id: string, over: Partial<Row> = {}): Row => ({
  id, fromPublicKey: 'channel-1', toPublicKey: 'channel-1', fromName: 'Bob', text: '\u{1F44D}',
  timestamp: NOW + 5, createdAt: NOW + 5,
  reactionEmoji: '\u{1F44D}', reactionFormat: 'mc1-channel', reactionTargetHash: 'b45pc4ek',
  reactionTargetSender: 'Alice', reactionTargetId: null, reactionRawText: '@[Alice]\u{1F44D}\nb45pc4ek',
  ...over,
});

function runSharedTests(getCtx: () => Ctx) {
  beforeEach(async () => { await getCtx().reset(); });

  it('round-trips the seven columns (incl. emoji) and keeps mc1Hash off nothing else', async () => {
    const { repo } = getCtx();
    await repo.insertMessage(ch('m1', { mc1Hash: 'b45pc4ek', senderTimestamp: 1704067200 }), A);
    await repo.insertMessage(react('r1', { reactionTargetId: 'm1' }), A);
    const m1 = await repo.getMessageForSource('m1', A);
    expect(m1).toMatchObject({ mc1Hash: 'b45pc4ek', senderTimestamp: 1704067200, reactionEmoji: null });
    const r1 = await repo.getMessageForSource('r1', A);
    expect(r1).toMatchObject({
      text: '\u{1F44D}', reactionEmoji: '\u{1F44D}', reactionFormat: 'mc1-channel', reactionTargetHash: 'b45pc4ek',
      reactionTargetSender: 'Alice', reactionTargetId: 'm1', reactionRawText: '@[Alice]\u{1F44D}\nb45pc4ek',
    });
  });

  it('findMessagesByMc1Hash is per source, skips reactions, newest first, limited', async () => {
    const { repo } = getCtx();
    await repo.insertMessage(ch('old', { mc1Hash: 'hhhhhhhh', createdAt: NOW }), A);
    await repo.insertMessage(ch('new', { mc1Hash: 'hhhhhhhh', createdAt: NOW + 10 }), A);
    await repo.insertMessage(ch('b-row', { mc1Hash: 'hhhhhhhh' }), B);
    await repo.insertMessage(react('rx', { mc1Hash: 'hhhhhhhh' }), A);
    expect((await repo.findMessagesByMc1Hash(A, 'hhhhhhhh')).map(r => r.id)).toEqual(['new', 'old']);
    expect((await repo.findMessagesByMc1Hash(A, 'hhhhhhhh', 1)).map(r => r.id)).toEqual(['new']);
    expect((await repo.findMessagesByMc1Hash(B, 'hhhhhhhh')).map(r => r.id)).toEqual(['b-row']);
    expect(await repo.findMessagesByMc1Hash(A, 'zzzzzzzz')).toEqual([]);
    await expect(repo.findMessagesByMc1Hash('', 'x')).rejects.toThrow(/sourceId/);
  });

  it('getReactionCandidates scopes channel / dm, window, unhashed, limit', async () => {
    const { repo } = getCtx();
    await repo.insertMessage(ch('c1', { createdAt: NOW }), A);
    await repo.insertMessage(ch('c1h', { createdAt: NOW + 1, mc1Hash: 'aaaaaaaa' }), A);
    await repo.insertMessage(ch('c-old', { createdAt: NOW - 8 * DAY }), A);
    await repo.insertMessage(ch('c2', { fromPublicKey: 'channel-2', toPublicKey: 'channel-2' }), A);
    await repo.insertMessage(ch('cB'), B);
    await repo.insertMessage(react('cr'), A);
    await repo.insertMessage(dm('d1'), A);
    await repo.insertMessage(dm('room', { messageType: 'room_post' }), A);
    await repo.insertMessage(dm('dB'), B);
    const since = NOW - 7 * DAY;
    expect((await repo.getReactionCandidates(A, { channelIdx: 1, sinceCreatedAt: since, limit: 10 })).map(r => r.id))
      .toEqual(['c1h', 'c1']);
    expect((await repo.getReactionCandidates(A, { channelIdx: 1, sinceCreatedAt: since, limit: 10, onlyUnhashed: true })).map(r => r.id))
      .toEqual(['c1']);
    expect((await repo.getReactionCandidates(A, { channelIdx: 1, sinceCreatedAt: since, limit: 1 })).map(r => r.id))
      .toEqual(['c1h']);
    expect((await repo.getReactionCandidates(A, { dm: true, sinceCreatedAt: since, limit: 10 })).map(r => r.id))
      .toEqual(['d1']);
    expect(await repo.getReactionCandidates(A, { sinceCreatedAt: since, limit: 10 })).toEqual([]);
    await expect(repo.getReactionCandidates('', { dm: true, sinceCreatedAt: 0, limit: 1 })).rejects.toThrow(/sourceId/);
  });

  it('findReactionRows / getUnresolvedReactions / setReactionTarget', async () => {
    const { repo } = getCtx();
    await repo.insertMessage(ch('m1', { mc1Hash: 'b45pc4ek' }), A);
    await repo.insertMessage(react('r-un', { reactionTargetHash: 'b45pc4ek' }), A);
    await repo.insertMessage(react('r-res', { reactionTargetId: 'm1', createdAt: NOW + 6 }), A);
    await repo.insertMessage(react('r-un-b', { reactionTargetHash: 'b45pc4ek' }), B);
    expect((await repo.findReactionRows(A, { targetId: 'm1' })).map(r => r.id)).toEqual(['r-res']);
    expect((await repo.findReactionRows(A, { targetHash: 'b45pc4ek' })).map(r => r.id)).toEqual(['r-un']);
    expect((await repo.getUnresolvedReactions(A, NOW - DAY, 10)).map(r => r.id)).toEqual(['r-un']);
    expect(await repo.getUnresolvedReactions(A, NOW + DAY, 10)).toEqual([]);

    expect(await repo.setReactionTarget('r-un', B, 'm1')).toBe(false);
    expect(await repo.setReactionTarget('r-res', A, 'other')).toBe(false);
    expect(await repo.setReactionTarget('m1', A, 'x')).toBe(false);
    expect(await repo.setReactionTarget('r-un', A, 'm1')).toBe(true);
    expect((await repo.getMessageForSource('r-un', A))!.reactionTargetId).toBe('m1');
    expect(await repo.getUnresolvedReactions(A, NOW - DAY, 10)).toEqual([]);
    expect((await repo.getUnresolvedReactions(B, NOW - DAY, 10)).map(r => r.id)).toEqual(['r-un-b']);
  });

  it('deleteReactionsForTargets deletes only this source reactions and returns ids', async () => {
    const { repo } = getCtx();
    await repo.insertMessage(ch('m1'), A);
    await repo.insertMessage(react('ra', { reactionTargetId: 'm1' }), A);
    await repo.insertMessage(react('ra2', { reactionTargetId: 'm1' }), A);
    await repo.insertMessage(react('rb', { reactionTargetId: 'm1' }), B);
    expect(await repo.deleteReactionsForTargets([], A)).toEqual([]);
    expect((await repo.deleteReactionsForTargets(['m1'], A)).sort()).toEqual(['ra', 'ra2']);
    expect(await repo.getMessageForSource('ra', A)).toBeNull();
    expect(await repo.getMessageForSource('m1', A)).not.toBeNull();
    expect(await repo.getMessageForSource('rb', B)).not.toBeNull();
    await expect(repo.deleteReactionsForTargets(['m1'], '')).rejects.toThrow(/sourceId/);
  });

  it('counts, latest timestamps and search skip reaction rows; message reads keep them', async () => {
    const { repo } = getCtx();
    await repo.insertMessage(ch('m1', { text: 'needle one', timestamp: NOW }), A);
    await repo.insertMessage(react('r1', { text: 'needle', timestamp: NOW + 100, reactionTargetId: 'm1' }), A);
    expect(await repo.getChannelMessageCounts([1], A)).toEqual({ 1: 1 });
    expect(await repo.getChannelLatestTimestamps([1], A)).toEqual({ 1: NOW });
    const found = await repo.searchMessages({ query: 'needle', scopes: [{ sourceId: A, channels: 'all', includeDms: true }] });
    expect(found.messages.map(r => r.id)).toEqual(['m1']);
    expect(found.total).toBe(1);
    expect((await repo.getChannelMessages(1, 10, A)).map(r => r.id).sort()).toEqual(['m1', 'r1']);
  });
}

describe('MeshCore reaction repository - SQLite', () => {
  let testDb: ReturnType<typeof createTestDb>;
  const ctx = {} as Ctx;
  beforeEach(() => {
    testDb?.close();
    testDb = createTestDb();
    ctx.repo = new MeshCoreRepository(testDb.db as any, 'sqlite');
    ctx.reset = async () => {};
  });
  afterAll(() => testDb?.close());
  runSharedTests(() => ctx);
});

describe.skipIf(!postgresAvailable)('MeshCore reaction repository - PostgreSQL', () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedPostgresDatabase>>;
  const ctx = {} as Ctx;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase('mcreact');
    const client = await isolated.pool.connect();
    try {
      await runLedgeredMigrations({
        backend: 'PostgreSQL', handle: client, migrations: registry.getAll(), pick: (m) => m.postgres,
        readApplied: readAppliedMigrationsPostgres, markApplied: markMigrationAppliedPostgres,
      });
    } finally {
      client.release();
    }
    ctx.repo = new MeshCoreRepository(drizzlePostgres(isolated.pool, { schema }) as any, 'postgres');
    ctx.reset = async () => { await isolated.pool.query('TRUNCATE meshcore_messages RESTART IDENTITY CASCADE'); };
  }, 120_000);
  afterAll(async () => { await isolated?.cleanup(); });
  runSharedTests(() => ctx);
});

describe.skipIf(!mysqlAvailable)('MeshCore reaction repository - MySQL', () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedMysqlDatabase>>;
  const ctx = {} as Ctx;
  beforeAll(async () => {
    isolated = await createIsolatedMysqlDatabase('mcreact');
    await runLedgeredMigrations({
      backend: 'MySQL', handle: isolated.pool, migrations: registry.getAll(), pick: (m) => m.mysql,
      readApplied: readAppliedMigrationsMysql, markApplied: markMigrationAppliedMysql,
    });
    ctx.repo = new MeshCoreRepository(drizzleMysql(isolated.pool, { schema, mode: 'default' }) as any, 'mysql');
    ctx.reset = async () => { await isolated.pool.query('TRUNCATE TABLE meshcore_messages'); };
  }, 180_000);
  afterAll(async () => { await isolated?.cleanup(); });
  runSharedTests(() => ctx);
});
