/**
 * MeshCoreChannelRemapRepository (#5379) on SQLite, PostgreSQL and MySQL.
 *
 * Every backend gets the REAL schema from the migration registry (SQLite via
 * createTestDb, PG/MySQL via runLedgeredMigrations on an isolated database),
 * so a drift between the Drizzle schema and a migration shows up here.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
import { buildActiveSchema } from '../activeSchema.js';
import type { DatabaseType } from '../types.js';
import {
  MeshCoreChannelRemapRepository,
  completeChannelMoves,
  remapMeshCoreChannelSetting,
} from './meshcoreChannelRemap.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from './test-utils.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const SRC = 'mc-src-a';
const OTHER = 'mc-src-b';
const NOW = 1_760_000_000_000;

interface Ctx {
  db: any;
  dbType: DatabaseType;
  repo: MeshCoreChannelRemapRepository;
  reset: () => Promise<void>;
}

async function run(q: any, dbType: DatabaseType): Promise<any> {
  if (dbType === 'sqlite') return q.all ? q.all() : q.run();
  return await q;
}

async function seed(ctx: Ctx) {
  const t = buildActiveSchema(ctx.dbType);
  const { db, dbType } = ctx;
  const userIns = db.insert(t.users).values({
    username: 'limited', passwordHash: 'x', authMethod: 'local', isAdmin: false, isActive: true,
    createdAt: NOW,
    ...(dbType === 'sqlite' ? {} : { updatedAt: NOW }),
  });
  await (dbType === 'sqlite' ? userIns.run() : userIns);
  const users = await run(db.select().from(t.users), dbType);
  const userId = Number(users[0].id);

  const msgs = [
    // Source A: received on slot 1, 2, 3 and a sent message on slot 2.
    { id: 'a1', fromPublicKey: 'channel-1', toPublicKey: null, sourceId: SRC },
    { id: 'a2', fromPublicKey: 'channel-2', toPublicKey: null, sourceId: SRC },
    { id: 'a3', fromPublicKey: 'channel-3', toPublicKey: null, sourceId: SRC },
    { id: 'a4', fromPublicKey: 'deadbeef', toPublicKey: 'channel-2', sourceId: SRC },
    // Slot 0 and a DM must not move.
    { id: 'a5', fromPublicKey: 'channel-0', toPublicKey: null, sourceId: SRC },
    { id: 'a6', fromPublicKey: 'cafe', toPublicKey: 'beef', sourceId: SRC },
    // Another source on the same slot numbers must not move.
    { id: 'b1', fromPublicKey: 'channel-1', toPublicKey: null, sourceId: OTHER },
  ];
  for (const m of msgs) {
    const q = db.insert(t.meshcoreMessages).values({ ...m, text: m.id, timestamp: NOW, createdAt: NOW });
    await (dbType === 'sqlite' ? q.run() : q);
  }

  for (const [sid, id, name, scope] of [
    [SRC, 0, 'Public', null], [SRC, 1, 'one', 'north'], [SRC, 2, 'two', null], [SRC, 3, 'three', 'south'],
    [OTHER, 1, 'other-one', null],
  ] as const) {
    const q = db.insert(t.channels).values({
      id, name, psk: null, role: null, uplinkEnabled: true, downlinkEnabled: true,
      createdAt: NOW, updatedAt: NOW, sourceId: sid, scope,
    });
    await (dbType === 'sqlite' ? q.run() : q);
  }

  for (const [sid, key, at] of [[SRC, '1', 11], [SRC, '2', 22], [SRC, '3', 33], [OTHER, '1', 99]] as const) {
    const q = db.insert(t.conversationReadState).values({
      userId, sourceId: sid, conversationKind: 'meshcore_channel', conversationKey: key, lastReadAt: at,
    });
    await (dbType === 'sqlite' ? q.run() : q);
  }

  for (const [sid, resource, canWrite] of [
    [SRC, 'channel_1', true], [SRC, 'channel_2', false], [SRC, 'channel_3', true], [OTHER, 'channel_1', true],
  ] as const) {
    const values: any = {
      userId, resource, canViewOnMap: false, canRead: true, canWrite, grantedAt: NOW, grantedBy: null, sourceId: sid,
    };
    if (dbType !== 'sqlite') values.canDelete = false;
    const q = db.insert(t.permissions).values(values);
    await (dbType === 'sqlite' ? q.run() : q);
  }

  for (const [key, value] of [
    [`source:${SRC}:meshcoreAutoAckChannels`, '0,1,3'],
    [`source:${SRC}:meshcoreAutoAnnounceChannelIndexes`, '2'],
    [`source:${SRC}:meshcoreAutoResponderTriggers`, JSON.stringify([{ id: 't1', channels: [1, 2], listenDMs: true }])],
    [`source:${SRC}:meshcoreTimerTriggers`, JSON.stringify([{ id: 'x', channelIndex: 3 }, { id: 'y', destination: 'dm' }])],
    [`source:${OTHER}:meshcoreAutoAckChannels`, '1'],
  ] as const) {
    const q = db.insert(t.settings).values({ key, value, createdAt: NOW, updatedAt: NOW });
    await (dbType === 'sqlite' ? q.run() : q);
  }
  return { userId, t };
}

function runSharedTests(getCtx: () => Ctx) {
  beforeEach(async () => { await getCtx().reset(); });

  it('moves every stored slot reference for the source through a 3-cycle', async () => {
    const ctx = getCtx();
    const { t } = await seed(ctx);
    // 1 -> 2, 2 -> 3, 3 -> 1 : the case the older swap-only helpers collapse.
    const counts = await ctx.repo.remapChannelSlots(SRC, [
      { from: 1, to: 2 }, { from: 2, to: 3 }, { from: 3, to: 1 },
    ]);
    expect(counts.messages).toBe(4);
    expect(counts.channels).toBe(3);
    expect(counts.readMarkers).toBe(3);
    expect(counts.permissionsMoved).toBe(3);
    expect(counts.permissionsDropped).toBe(0);
    expect(counts.settingsUpdated.sort()).toEqual([
      'meshcoreAutoAckChannels', 'meshcoreAutoAnnounceChannelIndexes',
      'meshcoreAutoResponderTriggers', 'meshcoreTimerTriggers',
    ]);

    const msgs = await run(ctx.db.select().from(t.meshcoreMessages), ctx.dbType);
    const byId = new Map(msgs.map((m: any) => [m.id, m]));
    expect((byId.get('a1') as any).fromPublicKey).toBe('channel-2');
    expect((byId.get('a2') as any).fromPublicKey).toBe('channel-3');
    expect((byId.get('a3') as any).fromPublicKey).toBe('channel-1');
    expect((byId.get('a4') as any).toPublicKey).toBe('channel-3');
    expect((byId.get('a4') as any).fromPublicKey).toBe('deadbeef');
    expect((byId.get('a5') as any).fromPublicKey).toBe('channel-0');
    expect((byId.get('a6') as any).toPublicKey).toBe('beef');
    expect((byId.get('b1') as any).fromPublicKey).toBe('channel-1');

    const chans = await run(ctx.db.select().from(t.channels), ctx.dbType);
    const mine = new Map(chans.filter((c: any) => c.sourceId === SRC).map((c: any) => [Number(c.id), c]));
    expect((mine.get(2) as any).name).toBe('one');
    expect((mine.get(2) as any).scope).toBe('north');
    expect((mine.get(3) as any).name).toBe('two');
    expect((mine.get(1) as any).name).toBe('three');
    expect((mine.get(1) as any).scope).toBe('south');
    expect((mine.get(0) as any).name).toBe('Public');
    expect(chans.find((c: any) => c.sourceId === OTHER).name).toBe('other-one');

    const rs = await run(ctx.db.select().from(t.conversationReadState), ctx.dbType);
    const rsMine = new Map(rs.filter((r: any) => r.sourceId === SRC).map((r: any) => [r.conversationKey, Number(r.lastReadAt)]));
    expect(Object.fromEntries(rsMine)).toEqual({ '2': 11, '3': 22, '1': 33 });
    expect(Number(rs.find((r: any) => r.sourceId === OTHER).lastReadAt)).toBe(99);

    const perms = await run(ctx.db.select().from(t.permissions), ctx.dbType);
    const permMine = new Map(perms.filter((p: any) => p.sourceId === SRC).map((p: any) => [p.resource, Boolean(p.canWrite)]));
    expect(Object.fromEntries(permMine)).toEqual({ channel_2: true, channel_3: false, channel_1: true });
    expect(perms.filter((p: any) => p.sourceId === OTHER).map((p: any) => p.resource)).toEqual(['channel_1']);

    const settings = await run(ctx.db.select().from(t.settings), ctx.dbType);
    const s = new Map(settings.map((r: any) => [r.key, r.value]));
    expect(s.get(`source:${SRC}:meshcoreAutoAckChannels`)).toBe('0,2,1');
    expect(s.get(`source:${SRC}:meshcoreAutoAnnounceChannelIndexes`)).toBe('3');
    expect(JSON.parse(s.get(`source:${SRC}:meshcoreAutoResponderTriggers`) as string)[0].channels).toEqual([2, 3]);
    expect(JSON.parse(s.get(`source:${SRC}:meshcoreTimerTriggers`) as string)).toEqual([
      { id: 'x', channelIndex: 1 }, { id: 'y', destination: 'dm' },
    ]);
    expect(s.get(`source:${OTHER}:meshcoreAutoAckChannels`)).toBe('1');
  });

  it('drops grants for a channel that moves past slot 7', async () => {
    const ctx = getCtx();
    const { t } = await seed(ctx);
    const counts = await ctx.repo.remapChannelSlots(SRC, completeChannelMoves([{ from: 3, to: 9 }]));
    expect(counts.permissionsDropped).toBe(1);
    const perms = await run(ctx.db.select().from(t.permissions), ctx.dbType);
    expect(perms.filter((p: any) => p.sourceId === SRC).map((p: any) => p.resource).sort()).toEqual(['channel_1', 'channel_2']);
  });

  it('rejects a move list that is not a permutation and changes nothing', async () => {
    const ctx = getCtx();
    const { t } = await seed(ctx);
    await expect(ctx.repo.remapChannelSlots(SRC, [{ from: 1, to: 2 }])).rejects.toThrow(/permutation/);
    await expect(ctx.repo.remapChannelSlots(SRC, [{ from: 0, to: 1 }, { from: 1, to: 0 }])).rejects.toThrow(/slot 0/);
    const msgs = await run(ctx.db.select().from(t.meshcoreMessages), ctx.dbType);
    expect(msgs.find((m: any) => m.id === 'a1').fromPublicKey).toBe('channel-1');
  });
}

describe('MeshCoreChannelRemapRepository — SQLite', () => {
  let testDb: ReturnType<typeof createTestDb>;
  const ctx = {} as Ctx;
  beforeEach(() => {
    testDb?.close();
    testDb = createTestDb();
    ctx.db = testDb.db;
    ctx.dbType = 'sqlite';
    ctx.repo = new MeshCoreChannelRemapRepository(testDb.db as any, 'sqlite');
    ctx.reset = async () => {};
  });
  afterAll(() => testDb?.close());
  runSharedTests(() => ctx);
});

describe.skipIf(!postgresAvailable)('MeshCoreChannelRemapRepository — PostgreSQL', () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedPostgresDatabase>>;
  const ctx = {} as Ctx;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase('mcremap');
    const client = await isolated.pool.connect();
    try {
      await runLedgeredMigrations({
        backend: 'PostgreSQL', handle: client, migrations: registry.getAll(), pick: (m) => m.postgres,
        readApplied: readAppliedMigrationsPostgres, markApplied: markMigrationAppliedPostgres,
      });
    } finally {
      client.release();
    }
    ctx.db = drizzlePostgres(isolated.pool, { schema });
    ctx.dbType = 'postgres';
    ctx.repo = new MeshCoreChannelRemapRepository(ctx.db, 'postgres');
    ctx.reset = async () => {
      await isolated.pool.query(
        'TRUNCATE meshcore_messages, channels, conversation_read_state, permissions, users RESTART IDENTITY CASCADE',
      );
      await isolated.pool.query(`DELETE FROM settings WHERE key LIKE 'source:%'`);
    };
  }, 120_000);
  afterAll(async () => { await isolated?.cleanup(); });
  runSharedTests(() => ctx);
});

describe.skipIf(!mysqlAvailable)('MeshCoreChannelRemapRepository — MySQL', () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedMysqlDatabase>>;
  const ctx = {} as Ctx;
  beforeAll(async () => {
    isolated = await createIsolatedMysqlDatabase('mcremap');
    await runLedgeredMigrations({
      backend: 'MySQL', handle: isolated.pool, migrations: registry.getAll(), pick: (m) => m.mysql,
      readApplied: readAppliedMigrationsMysql, markApplied: markMigrationAppliedMysql,
    });
    ctx.db = drizzleMysql(isolated.pool, { schema, mode: 'default' });
    ctx.dbType = 'mysql';
    ctx.repo = new MeshCoreChannelRemapRepository(ctx.db, 'mysql');
    ctx.reset = async () => {
      await isolated.pool.query('SET FOREIGN_KEY_CHECKS = 0');
      for (const table of ['meshcore_messages', 'channels', 'conversation_read_state', 'permissions', 'users']) {
        await isolated.pool.query(`TRUNCATE TABLE ${table}`);
      }
      await isolated.pool.query('SET FOREIGN_KEY_CHECKS = 1');
      await isolated.pool.query(`DELETE FROM settings WHERE \`key\` LIKE 'source:%'`);
    };
  }, 180_000);
  afterAll(async () => { await isolated?.cleanup(); });
  runSharedTests(() => ctx);
});

describe('completeChannelMoves', () => {
  it('pairs slots filled from empty with slots left empty', () => {
    // Channel in 5 moves to empty slot 4 (compaction after #5324's gap).
    expect(completeChannelMoves([{ from: 5, to: 4 }])).toEqual([{ from: 5, to: 4 }, { from: 4, to: 5 }]);
  });
  it('leaves a pure permutation alone and drops no-op moves', () => {
    expect(completeChannelMoves([{ from: 1, to: 2 }, { from: 2, to: 1 }, { from: 3, to: 3 }]))
      .toEqual([{ from: 1, to: 2 }, { from: 2, to: 1 }]);
  });
});

describe('remapMeshCoreChannelSetting', () => {
  const map = new Map([[1, 2], [2, 1]]);
  it('keeps non-numeric CSV parts and returns null when nothing changes', () => {
    expect(remapMeshCoreChannelSetting('meshcoreAutoAckChannels', '1, 2 ,x', map)).toBe('2,1,x');
    expect(remapMeshCoreChannelSetting('meshcoreAutoAckChannels', '0,5', map)).toBeNull();
  });
  it('leaves unparseable JSON untouched', () => {
    expect(remapMeshCoreChannelSetting('meshcoreTimerTriggers', '{not json', map)).toBeNull();
    expect(remapMeshCoreChannelSetting('meshcoreAutoResponderTriggers', '{"a":1}', map)).toBeNull();
  });
  it('ignores unknown keys', () => {
    expect(remapMeshCoreChannelSetting('somethingElse', '1', map)).toBeNull();
  });
});
