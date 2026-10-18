/**
 * MqttBrokerPresetsRepository + migration 211 (#5794) on all three backends.
 * The PG/MySQL suites skip silently without the test containers; confirm via
 * numPendingTests.
 */
import Database from 'better-sqlite3';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import * as schema from '../schema/index.js';
import { MqttBrokerPresetsRepository, type MqttBrokerPresetInput } from './mqttBrokerPresets.js';
import {
  migration,
  runMigration211Postgres,
  runMigration211Mysql,
} from '../../server/migrations/211_create_mqtt_broker_presets.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from './test-utils.js';

const FLORIDA: MqttBrokerPresetInput = {
  name: 'Florida Mesh Broker',
  host: 'broker.fl-mesh.org',
  port: 1883,
  tls: false,
  username: 'fluser',
  password: 'flpass',
  rootTopic: 'msh/US/FL',
};

function crudSuite(getRepo: () => MqttBrokerPresetsRepository) {
  it('creates, reads back booleans and nulls, updates, and deletes', async () => {
    const repo = getRepo();
    expect(await repo.listAsync()).toEqual([]);

    const created = await repo.createAsync(FLORIDA, 1000);
    expect(created).toMatchObject({ ...FLORIDA, createdAt: 1000, updatedAt: 1000 });
    expect(created.id).toBeGreaterThan(0);

    const tls = await repo.createAsync(
      { name: 'Alpha TLS', host: 'a.example.org', port: 8883, tls: true, username: null, password: null, rootTopic: null },
      2000,
    );
    expect(tls.tls).toBe(true);
    expect(tls.username).toBeNull();
    // Sorted by name.
    expect((await repo.listAsync()).map((p) => p.name)).toEqual(['Alpha TLS', 'Florida Mesh Broker']);

    const updated = await repo.updateAsync(created.id, { ...FLORIDA, name: 'FL', tls: true, port: 8883 }, 3000);
    expect(updated).toMatchObject({ name: 'FL', tls: true, port: 8883, createdAt: 1000, updatedAt: 3000 });
    expect(await repo.updateAsync(999999, FLORIDA)).toBeNull();

    expect(await repo.isNameTakenAsync('fl')).toBe(true);
    expect(await repo.isNameTakenAsync('FL', created.id)).toBe(false);
    expect(await repo.isNameTakenAsync('nope')).toBe(false);

    expect(await repo.deleteAsync(created.id)).toBe(true);
    expect(await repo.deleteAsync(created.id)).toBe(false);
    expect(await repo.getAsync(created.id)).toBeNull();
    expect((await repo.listAsync()).map((p) => p.id)).toEqual([tls.id]);
  });
}

describe('MqttBrokerPresetsRepository — SQLite', () => {
  const db = new Database(':memory:');
  migration.up(db);
  migration.up(db); // idempotent
  const repo = new MqttBrokerPresetsRepository(drizzleSqlite(db, { schema }), 'sqlite');
  afterAll(() => db.close());
  crudSuite(() => repo);
});

describe.skipIf(!postgresAvailable)('MqttBrokerPresetsRepository — PostgreSQL (container)', () => {
  let repo: MqttBrokerPresetsRepository;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const isolated = await createIsolatedPostgresDatabase('mqttpresets');
    cleanup = isolated.cleanup;
    const client = await isolated.pool.connect();
    try {
      await runMigration211Postgres(client);
      await runMigration211Postgres(client);
    } finally {
      client.release();
    }
    repo = new MqttBrokerPresetsRepository(drizzlePostgres(isolated.pool, { schema }) as never, 'postgres');
  });
  afterAll(async () => {
    await cleanup?.();
  });
  crudSuite(() => repo);
});

describe.skipIf(!mysqlAvailable)('MqttBrokerPresetsRepository — MySQL (container)', () => {
  let repo: MqttBrokerPresetsRepository;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const isolated = await createIsolatedMysqlDatabase('mqttpresets');
    cleanup = isolated.cleanup;
    await runMigration211Mysql(isolated.pool);
    await runMigration211Mysql(isolated.pool);
    repo = new MqttBrokerPresetsRepository(drizzleMysql(isolated.pool, { schema, mode: 'default' }) as never, 'mysql');
  });
  afterAll(async () => {
    await cleanup?.();
  });
  crudSuite(() => repo);
});
