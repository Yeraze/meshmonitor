/**
 * P7b (#6281): MeshCoreRepository security flags (setNodeSecurityFlags,
 * getSecurityFlaggedNodes, clearNodeSecurityFlags) and getLatestDmSenderTimes
 * on SQLite, PostgreSQL and MySQL.
 *
 * The PG/MySQL halves build `meshcore_nodes` from the Drizzle schema in their
 * own isolated database, and skip silently when the containers are down —
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
import { MeshCoreRepository } from './meshcore.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';
import { postgresCreateTable, mysqlCreateTable } from '../../server/test-helpers/drizzleDdl.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from './test-utils.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const NOW = 2_000_000_000_000;

function shared(getRepo: () => MeshCoreRepository) {
  it('setNodeSecurityFlags writes only its own source; clear resets; flagged read is scoped', async () => {
    const repo = getRepo();
    await repo.upsertNode({ publicKey: A, name: 'a' }, 'src-a');
    await repo.upsertNode({ publicKey: A, name: 'a-b' }, 'src-b');
    await repo.setNodeSecurityFlags('src-a', [
      { publicKey: A, isExcessivePackets: true, packetRatePerHour: 44, advertRatePerHour: 40, packetRateLastChecked: NOW },
      { publicKey: B, isExcessivePackets: true }, // not held: ignored
    ]);
    const a = await repo.getNodeByPublicKeyAndSource(A, 'src-a');
    expect(Boolean(a?.isExcessivePackets)).toBe(true);
    expect(Number(a?.packetRatePerHour)).toBe(44);
    expect(Number(a?.packetRateLastChecked)).toBe(NOW);
    const other = await repo.getNodeByPublicKeyAndSource(A, 'src-b');
    expect(Boolean(other?.isExcessivePackets)).toBe(false);
    expect(await repo.getNodeByPublicKeyAndSource(B, 'src-a')).toBeNull();

    expect((await repo.getSecurityFlaggedNodes('src-a')).map((n) => n.publicKey)).toEqual([A]);
    expect(await repo.getSecurityFlaggedNodes('src-b')).toEqual([]);
    expect(await repo.getSecurityFlaggedNodes('')).toEqual([]);

    await repo.setNodeSecurityFlags('src-a', [
      { publicKey: A, isTimeOffsetIssue: true, timeOffsetSeconds: 7200, timeOffsetSource: 'advert', timeOffsetCheckedAt: NOW },
    ]);
    // spam-only clear keeps the offset
    expect(await repo.clearNodeSecurityFlags('src-a', A, 'spam')).toBe(true);
    let n = await repo.getNodeByPublicKeyAndSource(A, 'src-a');
    expect(Boolean(n?.isExcessivePackets)).toBe(false);
    expect(n?.packetRatePerHour).toBeNull();
    expect(Boolean(n?.isTimeOffsetIssue)).toBe(true);
    expect(Number(n?.timeOffsetSeconds)).toBe(7200);
    expect(n?.timeOffsetSource).toBe('advert');
    // clearing on the wrong source is a no-op
    expect(await repo.clearNodeSecurityFlags('src-z', A)).toBe(false);
    expect(await repo.clearNodeSecurityFlags('src-a', A)).toBe(true);
    n = await repo.getNodeByPublicKeyAndSource(A, 'src-a');
    expect(Boolean(n?.isTimeOffsetIssue)).toBe(false);
    expect(n?.timeOffsetSeconds).toBeNull();
    expect(await repo.getSecurityFlaggedNodes('src-a')).toEqual([]);
  });

  it('upsertNode (contact sync) leaves the security flags intact and ignores them in input', async () => {
    const repo = getRepo();
    await repo.upsertNode({ publicKey: A, name: 'a' }, 'src-a');
    await repo.setNodeSecurityFlags('src-a', [{ publicKey: A, isExcessivePackets: true, packetRatePerHour: 50 }]);
    await repo.upsertNode({ publicKey: A, name: 'renamed', lastHeard: NOW }, 'src-a');
    await repo.upsertNode({ publicKey: A, isExcessivePackets: false, packetRatePerHour: 1 }, 'src-a');
    const n = await repo.getNodeByPublicKeyAndSource(A, 'src-a');
    expect(n?.name).toBe('renamed');
    expect(Boolean(n?.isExcessivePackets)).toBe(true);
    expect(Number(n?.packetRatePerHour)).toBe(50);
    // a fresh insert never carries flags
    await repo.upsertNode({ publicKey: B, isExcessivePackets: true }, 'src-a');
    expect(Boolean((await repo.getNodeByPublicKeyAndSource(B, 'src-a'))?.isExcessivePackets)).toBe(false);
  });

  it('getLatestDmSenderTimes: DMs only, no room posts, bounded, newest first, per source', async () => {
    const repo = getRepo();
    const base = { text: 't', timestamp: NOW, rssi: null, snr: null } as const;
    const msg = (id: string, over: Record<string, unknown>) =>
      repo.insertMessage({ id, ...base, fromPublicKey: A, toPublicKey: B, createdAt: NOW, senderTimestamp: 1_900_000_000, ...over } as never, (over.src as string) ?? 'src-a');
    await msg('m1', { createdAt: NOW - 3000 });
    await msg('m2', { createdAt: NOW - 2000, messageType: 'room_post' });
    await msg('m3', { createdAt: NOW - 1000, senderTimestamp: null });
    await msg('m4', { createdAt: NOW - 500, fromPublicKey: 'channel-0' });
    await msg('m5', { createdAt: NOW - 100, fromPublicKey: B.slice(0, 12) });
    await msg('m6', { createdAt: NOW - 50, src: 'src-b' });
    await msg('m7', { createdAt: NOW - 10_000_000 }); // before sinceMs
    const rows = await repo.getLatestDmSenderTimes('src-a', NOW - 5000, 10);
    expect(rows.map((r) => r.fromPublicKey)).toEqual([B.slice(0, 12), A]);
    expect(rows[0].senderTimestamp).toBe(1_900_000_000);
    expect(Number(rows[0].receivedAtMs)).toBe(NOW - 100);
    expect(await repo.getLatestDmSenderTimes('src-a', NOW - 5000, 1)).toHaveLength(1);
    expect(await repo.getLatestDmSenderTimes('src-a', NOW - 5000, 0)).toEqual([]);
    expect(await repo.getLatestDmSenderTimes('', NOW - 5000, 10)).toEqual([]);
  });
}

describe('security flags / DM sender times — SQLite', () => {
  let db: Database.Database;
  let repo: MeshCoreRepository;
  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    repo = new MeshCoreRepository(t.db, 'sqlite');
  });
  afterEach(() => db.close());
  shared(() => repo);
});

describe.skipIf(!postgresAvailable)('security flags / DM sender times — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanupDb: (() => Promise<void>) | undefined;
  let repo: MeshCoreRepository;

  beforeAll(async () => {
    ({ pool, cleanup: cleanupDb } = await createIsolatedPostgresDatabase('mcsec'));
    const tables = buildActiveSchema('postgres') as unknown as Record<string, unknown>;
    for (const statement of postgresCreateTable(tables.meshcoreNodes).split(';\n')) {
      await pool.query(statement);
    }
    for (const statement of postgresCreateTable(tables.meshcoreMessages).split(';\n')) {
      await pool.query(statement);
    }
    repo = new MeshCoreRepository(drizzlePostgres(pool, { schema }) as never, 'postgres');
  }, 60_000);
  afterAll(async () => {
    await cleanupDb?.();
  });
  beforeEach(async () => {
    await pool.query('DELETE FROM meshcore_nodes');
    await pool.query('DELETE FROM meshcore_messages');
  });

  shared(() => repo);
});

describe.skipIf(!mysqlAvailable)('security flags / DM sender times — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanupDb: (() => Promise<void>) | undefined;
  let repo: MeshCoreRepository;

  beforeAll(async () => {
    ({ pool, cleanup: cleanupDb } = await createIsolatedMysqlDatabase('mcsec'));
    const tables = buildActiveSchema('mysql') as unknown as Record<string, unknown>;
    await pool.query(mysqlCreateTable(tables.meshcoreNodes));
    await pool.query(mysqlCreateTable(tables.meshcoreMessages));
    repo = new MeshCoreRepository(drizzleMysql(pool, { schema, mode: 'default' }) as never, 'mysql');
  }, 60_000);
  afterAll(async () => {
    await cleanupDb?.();
  });
  beforeEach(async () => {
    await pool.query('DELETE FROM meshcore_nodes');
    await pool.query('DELETE FROM meshcore_messages');
  });

  shared(() => repo);
});
