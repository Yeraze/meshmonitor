/**
 * MeshCore Observer Keys Repository — per-source isolation tests.
 *
 * The `meshcore_observer_keys` table (migration 133) carries a `sourceId`
 * primary key. These tests assert that stored envelopes never leak across
 * sources (epic #4457, Phase 1 WP1).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { MeshCoreObserverKeysRepository } from './meshcoreObserverKeys.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

describe('MeshCoreObserverKeysRepository — per-source isolation', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: MeshCoreObserverKeysRepository;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    repo = new MeshCoreObserverKeysRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  it('upsert requires a sourceId', async () => {
    await expect(repo.upsert('', 'envelope', 'PUBKEY', 'manual')).rejects.toThrow(/sourceId/);
  });

  it('getBySourceId returns each source own row and never the other’s', async () => {
    await repo.upsert('source-a', 'envelope-a', 'PUBKEYA', 'device');
    await repo.upsert('source-b', 'envelope-b', 'PUBKEYB', 'manual');

    const a = await repo.getBySourceId('source-a');
    const b = await repo.getBySourceId('source-b');

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.sourceId).toBe('source-a');
    expect(a!.encryptedPrivateKey).toBe('envelope-a');
    expect(a!.publicKey).toBe('PUBKEYA');
    expect(a!.keyOrigin).toBe('device');

    expect(b!.sourceId).toBe('source-b');
    expect(b!.encryptedPrivateKey).toBe('envelope-b');
    expect(b!.publicKey).toBe('PUBKEYB');
    expect(b!.keyOrigin).toBe('manual');
  });

  it('getBySourceId returns null for a source with no stored key', async () => {
    await repo.upsert('source-a', 'envelope-a', 'PUBKEYA', 'device');
    expect(await repo.getBySourceId('source-b')).toBeNull();
  });

  it('deleteBySourceId removes only the targeted source, leaving others intact', async () => {
    await repo.upsert('source-a', 'envelope-a', 'PUBKEYA', 'device');
    await repo.upsert('source-b', 'envelope-b', 'PUBKEYB', 'manual');

    await repo.deleteBySourceId('source-a');

    expect(await repo.getBySourceId('source-a')).toBeNull();
    const b = await repo.getBySourceId('source-b');
    expect(b).not.toBeNull();
    expect(b!.sourceId).toBe('source-b');
  });

  it('deleteBySourceId is idempotent (no-op on an absent key)', async () => {
    await expect(repo.deleteBySourceId('source-a')).resolves.not.toThrow();
  });

  it('hasKey is per-source', async () => {
    await repo.upsert('source-a', 'envelope-a', 'PUBKEYA', 'device');

    expect(await repo.hasKey('source-a')).toBe(true);
    expect(await repo.hasKey('source-b')).toBe(false);
  });

  it('upsert on source-a twice updates in place (one row) and does not create a row for source-b', async () => {
    await repo.upsert('source-a', 'envelope-a-v1', 'PUBKEYA1', 'device');
    await repo.upsert('source-a', 'envelope-a-v2', 'PUBKEYA2', 'manual');

    const a = await repo.getBySourceId('source-a');
    expect(a).not.toBeNull();
    expect(a!.encryptedPrivateKey).toBe('envelope-a-v2');
    expect(a!.publicKey).toBe('PUBKEYA2');
    expect(a!.keyOrigin).toBe('manual');

    expect(await repo.getBySourceId('source-b')).toBeNull();
  });
});
