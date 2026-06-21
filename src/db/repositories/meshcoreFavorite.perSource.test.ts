/**
 * MeshCore Repository — node-favorite per-source isolation tests (issue #3588).
 *
 * The `meshcore_nodes.isFavorite` flag (migration 094) is stored server-side
 * only — MeshCore firmware has no native favorite concept, so toggling it
 * never round-trips to the device. The flag carries a `sourceId` (composite PK
 * with `publicKey`), so these tests assert that favoriting a node under one
 * source never leaks into another source's view of the same public key.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { MeshCoreRepository } from './meshcore.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const PUBKEY = 'a'.repeat(64);
const PUBKEY_B = 'b'.repeat(64);

describe('MeshCoreRepository — node favorite per-source isolation', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: MeshCoreRepository;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    repo = new MeshCoreRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  it('setNodeFavorite requires a sourceId', async () => {
    await expect(repo.setNodeFavorite('', PUBKEY, true)).rejects.toThrow(/sourceId/);
  });

  it('seeds a stub row when the node has only been seen in-memory', async () => {
    await repo.setNodeFavorite('src-a', PUBKEY, true);
    const node = await repo.getNodeByPublicKeyAndSource(PUBKEY, 'src-a');
    expect(node).not.toBeNull();
    expect(Boolean(node?.isFavorite)).toBe(true);
  });

  it('updates an existing row without clobbering other fields', async () => {
    await repo.upsertNode({ publicKey: PUBKEY, name: 'Repeater One', advType: 2 }, 'src-a');
    await repo.setNodeFavorite('src-a', PUBKEY, true);

    const node = await repo.getNodeByPublicKeyAndSource(PUBKEY, 'src-a');
    expect(Boolean(node?.isFavorite)).toBe(true);
    expect(node?.name).toBe('Repeater One');
    expect(node?.advType).toBe(2);
  });

  it('favoriting under one source does not affect the same key under another', async () => {
    await repo.upsertNode({ publicKey: PUBKEY, name: 'Shared' }, 'src-a');
    await repo.upsertNode({ publicKey: PUBKEY, name: 'Shared' }, 'src-b');

    await repo.setNodeFavorite('src-a', PUBKEY, true);

    const a = await repo.getNodeByPublicKeyAndSource(PUBKEY, 'src-a');
    const b = await repo.getNodeByPublicKeyAndSource(PUBKEY, 'src-b');
    expect(Boolean(a?.isFavorite)).toBe(true);
    expect(Boolean(b?.isFavorite)).toBe(false);
  });

  it('getNodesBySource only returns favorites scoped to that source', async () => {
    await repo.setNodeFavorite('src-a', PUBKEY, true);
    await repo.setNodeFavorite('src-b', PUBKEY_B, true);

    const aNodes = await repo.getNodesBySource('src-a');
    const bNodes = await repo.getNodesBySource('src-b');

    expect(aNodes.map(n => n.publicKey)).toEqual([PUBKEY]);
    expect(Boolean(aNodes[0].isFavorite)).toBe(true);
    expect(bNodes.map(n => n.publicKey)).toEqual([PUBKEY_B]);
    expect(Boolean(bNodes[0].isFavorite)).toBe(true);
  });

  it('un-favoriting flips the flag back to false', async () => {
    await repo.setNodeFavorite('src-a', PUBKEY, true);
    await repo.setNodeFavorite('src-a', PUBKEY, false);
    const node = await repo.getNodeByPublicKeyAndSource(PUBKEY, 'src-a');
    expect(Boolean(node?.isFavorite)).toBe(false);
  });
});
