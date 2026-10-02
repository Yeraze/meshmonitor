/**
 * Repository reads behind the MeshCore channel resend (#5512) on SQLite,
 * PostgreSQL and MySQL:
 *  - MeshCoreRepository.insertMessage / getMessageForSource round-trip the new
 *    `senderTimestamp` column (migration 186) and stay per-source;
 *  - MessageEventsRepository.getEventsForMessages filters by type and source.
 *
 * Every backend gets the REAL schema from the migration registry (SQLite via
 * createTestDb, PG/MySQL via runLedgeredMigrations on an isolated database).
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
import { MessageEventsRepository } from './messageEvents.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from './test-utils.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const SRC = 'rs-src-a';
const OTHER = 'rs-src-b';
const NOW = 1_760_000_000_000;
// Past 2^31: the column must be BIGINT on PG/MySQL.
const WIRE_TS = 4_300_000_000;

interface Ctx {
  meshcore: MeshCoreRepository;
  events: MessageEventsRepository;
  reset: () => Promise<void>;
}

function runSharedTests(getCtx: () => Ctx) {
  beforeEach(async () => {
    await getCtx().reset();
  });

  it('round-trips senderTimestamp and scopes the lookup by source', async () => {
    const { meshcore } = getCtx();
    await meshcore.insertMessage({
      id: 'm1', fromPublicKey: 'self', toPublicKey: 'channel-1', text: 'hi',
      timestamp: NOW, createdAt: NOW, senderTimestamp: WIRE_TS,
    }, SRC);
    await meshcore.insertMessage({
      id: 'm2', fromPublicKey: 'self', toPublicKey: 'channel-1', text: 'legacy',
      timestamp: NOW, createdAt: NOW,
    }, SRC);

    const m1 = await meshcore.getMessageForSource('m1', SRC);
    expect(m1).toMatchObject({ id: 'm1', text: 'hi', toPublicKey: 'channel-1', senderTimestamp: WIRE_TS });
    expect(typeof m1!.senderTimestamp).toBe('number');
    expect((await meshcore.getMessageForSource('m2', SRC))!.senderTimestamp).toBeNull();
    expect(await meshcore.getMessageForSource('m1', OTHER)).toBeNull();
    expect(await meshcore.getMessageForSource('missing', SRC)).toBeNull();
    await expect(meshcore.getMessageForSource('m1', '')).rejects.toThrow(/sourceId/);
  });

  it('getEventsForMessages returns one type, for the given ids, in one source, oldest first', async () => {
    const { events } = getCtx();
    const rec = (sourceId: string, messageId: string, eventType: 'retry' | 'submitted', ts: number) =>
      events.recordEvent({ sourceId, messageId, eventType, provenance: 'observed', timestamp: ts, detail: `{"t":${ts}}` });
    await rec(SRC, 'm1', 'retry', NOW + 20);
    await rec(SRC, 'm1', 'retry', NOW + 10);
    await rec(SRC, 'm1', 'submitted', NOW);
    await rec(SRC, 'm2', 'retry', NOW + 30);
    await rec(SRC, 'm3', 'retry', NOW + 40);
    await rec(OTHER, 'm1', 'retry', NOW + 50);

    const rows = await events.getEventsForMessages(SRC, ['m1', 'm2'], 'retry');
    expect(rows.map(r => [r.messageId, Number(r.timestamp)])).toEqual([
      ['m1', NOW + 10],
      ['m1', NOW + 20],
      ['m2', NOW + 30],
    ]);
    expect(await events.getEventsForMessages(SRC, [], 'retry')).toEqual([]);
    await expect(events.getEventsForMessages('', ['m1'], 'retry')).rejects.toThrow(/sourceId/);
  });
}

describe('MeshCore resend repositories — SQLite', () => {
  let testDb: ReturnType<typeof createTestDb>;
  const ctx = {} as Ctx;
  beforeEach(() => {
    testDb?.close();
    testDb = createTestDb();
    ctx.meshcore = new MeshCoreRepository(testDb.db as any, 'sqlite');
    ctx.events = new MessageEventsRepository(testDb.db as any, 'sqlite');
    ctx.reset = async () => {};
  });
  afterAll(() => testDb?.close());
  runSharedTests(() => ctx);
});

describe.skipIf(!postgresAvailable)('MeshCore resend repositories — PostgreSQL', () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedPostgresDatabase>>;
  const ctx = {} as Ctx;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase('mcresend');
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
    ctx.events = new MessageEventsRepository(db as any, 'postgres');
    ctx.reset = async () => {
      await isolated.pool.query('TRUNCATE meshcore_messages, message_events RESTART IDENTITY CASCADE');
    };
  }, 120_000);
  afterAll(async () => { await isolated?.cleanup(); });
  runSharedTests(() => ctx);
});

describe.skipIf(!mysqlAvailable)('MeshCore resend repositories — MySQL', () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedMysqlDatabase>>;
  const ctx = {} as Ctx;
  beforeAll(async () => {
    isolated = await createIsolatedMysqlDatabase('mcresend');
    await runLedgeredMigrations({
      backend: 'MySQL', handle: isolated.pool, migrations: registry.getAll(), pick: (m) => m.mysql,
      readApplied: readAppliedMigrationsMysql, markApplied: markMigrationAppliedMysql,
    });
    const db = drizzleMysql(isolated.pool, { schema, mode: 'default' });
    ctx.meshcore = new MeshCoreRepository(db as any, 'mysql');
    ctx.events = new MessageEventsRepository(db as any, 'mysql');
    ctx.reset = async () => {
      await isolated.pool.query('TRUNCATE TABLE meshcore_messages');
      await isolated.pool.query('TRUNCATE TABLE message_events');
    };
  }, 180_000);
  afterAll(async () => { await isolated?.cleanup(); });
  runSharedTests(() => ctx);
});
