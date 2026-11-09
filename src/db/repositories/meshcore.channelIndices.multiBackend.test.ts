/**
 * `getChannelIndicesWithMessages` (#6307): the slot channel indices that carry
 * channel messages on a source, on SQLite, PostgreSQL and MySQL. Scoped by
 * source; keyed (fingerprinted) rows and DMs are excluded.
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
import { MeshCoreRepository } from './meshcore.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from './test-utils.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const A = 'ci-src-a';
const B = 'ci-src-b';

interface Ctx {
  meshcore: MeshCoreRepository;
  reset: () => Promise<void>;
}

function runSharedTests(getCtx: () => Ctx) {
  beforeEach(async () => {
    await getCtx().reset();
  });

  it('lists distinct slot indices for the source only, sorted', async () => {
    const { meshcore } = getCtx();
    const ins = (id: string, key: string, src: string, extra: Record<string, unknown> = {}) =>
      meshcore.insertMessage(
        { id, fromPublicKey: key, fromName: 'X', text: id, timestamp: 100, createdAt: 100, messageType: 'channel', ...extra } as never,
        src,
      );
    await ins('a1', 'channel-3', A);
    await ins('a2', 'channel-3', A);
    await ins('a3', 'channel-0', A);
    await ins('a4', 'channel-1234', A, { keyFingerprint: 'ab12' });
    await ins('a5', 'bb'.repeat(32), A, { messageType: 'text' });
    await ins('b1', 'channel-7', B);
    expect(await meshcore.getChannelIndicesWithMessages(A)).toEqual([0, 3]);
    expect(await meshcore.getChannelIndicesWithMessages(B)).toEqual([7]);
    expect(await meshcore.getChannelIndicesWithMessages('nobody')).toEqual([]);
    expect(await meshcore.getChannelIndicesWithMessages('')).toEqual([]);
  });
}

describe('MeshCore channel indices with messages — SQLite', () => {
  let testDb: ReturnType<typeof createTestDb>;
  const ctx = {} as Ctx;
  beforeEach(() => {
    testDb?.close();
    testDb = createTestDb();
    ctx.meshcore = new MeshCoreRepository(testDb.db as any, 'sqlite');
    ctx.reset = async () => {};
  });
  afterAll(() => testDb?.close());
  runSharedTests(() => ctx);
});

describe.skipIf(!postgresAvailable)('MeshCore channel indices with messages — PostgreSQL', () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedPostgresDatabase>>;
  const ctx = {} as Ctx;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase('mcchanidx');
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
    ctx.meshcore = new MeshCoreRepository(db as any, 'postgres');
    ctx.reset = async () => {
      await isolated.pool.query('TRUNCATE meshcore_messages RESTART IDENTITY CASCADE');
    };
  }, 120_000);
  afterAll(async () => { await isolated?.cleanup(); });
  runSharedTests(() => ctx);
});

describe.skipIf(!mysqlAvailable)('MeshCore channel indices with messages — MySQL', () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedMysqlDatabase>>;
  const ctx = {} as Ctx;
  beforeAll(async () => {
    isolated = await createIsolatedMysqlDatabase('mcchanidx');
    await runLedgeredMigrations({
      backend: 'MySQL', handle: isolated.pool, migrations: registry.getAll(), pick: (m) => m.mysql,
      readApplied: readAppliedMigrationsMysql, markApplied: markMigrationAppliedMysql,
    });
    const db = drizzleMysql(isolated.pool, { schema, mode: 'default' });
    ctx.meshcore = new MeshCoreRepository(db as any, 'mysql');
    ctx.reset = async () => {
      await isolated.pool.query('TRUNCATE TABLE meshcore_messages');
    };
  }, 180_000);
  afterAll(async () => { await isolated?.cleanup(); });
  runSharedTests(() => ctx);
});
