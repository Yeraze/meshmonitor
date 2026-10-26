/**
 * MeshCore message reads order by server arrival time (`createdAt`), not the
 * sender's clock (#5973), on SQLite, PostgreSQL and MySQL. The channel view
 * draws in receipt order, so its pages must break at the same places; the
 * unread marker and the connect-time tail use the same clock.
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

const SRC = 'ro-src-a';
const NOW = 1_790_000_000_000;
const MIN = 60_000;

interface Ctx {
  meshcore: MeshCoreRepository;
  reset: () => Promise<void>;
}

function runSharedTests(getCtx: () => Ctx) {
  beforeEach(async () => {
    await getCtx().reset();
    const { meshcore } = getCtx();
    // Received in a, b, c order. b's sender clock runs 15 min fast, c's 15 min
    // slow, so a sender-time order would be c, a, b.
    const rows = [
      { id: 'a', timestamp: NOW, createdAt: NOW },
      { id: 'b', timestamp: NOW + MIN + 15 * MIN, createdAt: NOW + MIN },
      { id: 'c', timestamp: NOW + 2 * MIN - 15 * MIN, createdAt: NOW + 2 * MIN },
    ];
    for (const r of rows) {
      await meshcore.insertMessage({ ...r, fromPublicKey: 'channel-1', fromName: 'X', text: r.id }, SRC);
    }
  });

  it('pages a channel newest-first by receipt time', async () => {
    const { meshcore } = getCtx();
    expect((await meshcore.getChannelMessages(1, 2, SRC, 0)).map(r => r.id)).toEqual(['c', 'b']);
    expect((await meshcore.getChannelMessages(1, 2, SRC, 2)).map(r => r.id)).toEqual(['a']);
  });

  it('serves the recent tail by receipt time', async () => {
    const { meshcore } = getCtx();
    expect((await meshcore.getRecentMessages(2, SRC)).map(r => r.id)).toEqual(['c', 'b']);
  });

  it('reports the newest receipt time per channel', async () => {
    const { meshcore } = getCtx();
    expect(await meshcore.getChannelLatestTimestamps([1], SRC)).toEqual({ 1: NOW + 2 * MIN });
  });
}

describe('MeshCore receipt-time order — SQLite', () => {
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

describe.skipIf(!postgresAvailable)('MeshCore receipt-time order — PostgreSQL', () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedPostgresDatabase>>;
  const ctx = {} as Ctx;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase('mcrecvorder');
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

describe.skipIf(!mysqlAvailable)('MeshCore receipt-time order — MySQL', () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedMysqlDatabase>>;
  const ctx = {} as Ctx;
  beforeAll(async () => {
    isolated = await createIsolatedMysqlDatabase('mcrecvorder');
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
