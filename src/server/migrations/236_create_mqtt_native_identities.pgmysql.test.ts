/**
 * Migration 236 + MqttNativeIdentitiesRepository on PostgreSQL / MySQL
 * (isolated DBs). A silent skip still reports success; confirm via
 * `numPendingTests`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import * as schema from '../../db/schema/index.js';
import { runMigration236Postgres, runMigration236Mysql } from './236_create_mqtt_native_identities.js';
import { MqttNativeIdentitiesRepository } from '../../db/repositories/mqttNativeIdentities.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

async function exerciseRepository(repo: MqttNativeIdentitiesRepository): Promise<void> {
  // Unsigned 32-bit node number above INT range: must survive as BIGINT.
  await repo.create({ sourceId: 'src-a', nodeNum: 0xfffffffe, publicKey: 'cHVi', encryptedPrivateKey: '{"v":1}' });
  await expect(repo.create({ sourceId: 'src-a', nodeNum: 1, publicKey: 'x', encryptedPrivateKey: 'y' })).rejects.toThrow();
  const row = await repo.getBySourceId('src-a');
  expect(row).toMatchObject({ sourceId: 'src-a', nodeNum: 0xfffffffe, publicKey: 'cHVi', lastNodeInfoAt: null, sendTimes: null });
  await repo.setLastNodeInfoAt('src-a', 1_800_000_000_123);
  await repo.setSendTimes('src-a', [1, 2, 3]);
  const after = await repo.getBySourceId('src-a');
  expect(after?.lastNodeInfoAt).toBe(1_800_000_000_123);
  expect(JSON.parse(after!.sendTimes!)).toEqual([1, 2, 3]);
  expect(await repo.getBySourceId('src-b')).toBeNull();
  expect((await repo.listAll()).map((r) => r.sourceId)).toEqual(['src-a']);
  await repo.deleteBySourceId('src-a');
  expect(await repo.getBySourceId('src-a')).toBeNull();
}

describe.skipIf(!postgresAvailable)('migration 236 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig236'));
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('creates the table idempotently and the repository round-trips', async () => {
    const client = await pool.connect();
    try {
      await runMigration236Postgres(client);
      await expect(runMigration236Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }
    const repo = new MqttNativeIdentitiesRepository(drizzlePostgres(pool, { schema }) as never, 'postgres');
    await exerciseRepository(repo);
  });
});

describe.skipIf(!mysqlAvailable)('migration 236 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig236'));
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('creates the table idempotently and the repository round-trips', async () => {
    await runMigration236Mysql(pool);
    await expect(runMigration236Mysql(pool)).resolves.toBeUndefined();
    const repo = new MqttNativeIdentitiesRepository(drizzleMysql(pool, { schema, mode: 'default' }) as never, 'mysql');
    await exerciseRepository(repo);
  });
});
