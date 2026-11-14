/**
 * Migration 236 + MqttNativeIdentitiesRepository on SQLite.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../db/schema/index.js';
import { migration } from './236_create_mqtt_native_identities.js';
import { MqttNativeIdentitiesRepository } from '../../db/repositories/mqttNativeIdentities.js';

describe('migration 236 — SQLite', () => {
  it('creates the table idempotently and the repository round-trips', async () => {
    const db = new Database(':memory:');
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();
    const cols = (db.prepare('PRAGMA table_info(mqtt_native_identities)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(['sourceId', 'nodeNum', 'publicKey', 'encryptedPrivateKey', 'lastNodeInfoAt', 'sendTimes', 'createdAt', 'updatedAt']);

    const repo = new MqttNativeIdentitiesRepository(drizzleSqlite(db, { schema }) as never, 'sqlite');
    await repo.create({ sourceId: 'src-a', nodeNum: 0xfffffffe, publicKey: 'cHVi', encryptedPrivateKey: '{"v":1}' });
    await expect(repo.create({ sourceId: 'src-a', nodeNum: 1, publicKey: 'x', encryptedPrivateKey: 'y' })).rejects.toThrow();
    expect(await repo.getBySourceId('src-a')).toMatchObject({ nodeNum: 0xfffffffe, lastNodeInfoAt: null, sendTimes: null });
    await repo.setLastNodeInfoAt('src-a', 1_800_000_000_123);
    await repo.setSendTimes('src-a', [5]);
    const row = await repo.getBySourceId('src-a');
    expect(row?.lastNodeInfoAt).toBe(1_800_000_000_123);
    expect(row?.sendTimes).toBe('[5]');
    await repo.deleteBySourceId('src-a');
    expect(await repo.getBySourceId('src-a')).toBeNull();
    db.close();
  });
});
