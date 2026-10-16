/**
 * MeshCore Repository — location override per-source isolation (#5842).
 *
 * The override (migration 206) is keyed by (sourceId, publicKey) like the rest
 * of `meshcore_nodes`: setting it on one source never shows up on another
 * source's row for the same public key, and advert ingest (`upsertNode`)
 * never writes or clears it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { MeshCoreRepository } from './meshcore.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const PUBKEY = 'a'.repeat(64);
const PUBKEY_B = 'b'.repeat(64);
const PIN = { enabled: true, latitude: 28.5, longitude: -81.4, altitude: 30, isPrivate: true };

describe('MeshCoreRepository — position override per-source isolation', () => {
  let db: Database.Database;
  let repo: MeshCoreRepository;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    repo = new MeshCoreRepository(t.db, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  it('every method requires a sourceId', async () => {
    await expect(repo.setNodePositionOverride('', PUBKEY, PIN)).rejects.toThrow(/sourceId/);
    await expect(repo.clearNodePositionOverride('', PUBKEY)).rejects.toThrow(/sourceId/);
    await expect(repo.getNodePositionOverride('', PUBKEY)).rejects.toThrow(/sourceId/);
    await expect(repo.getPositionOverridesBySource('')).rejects.toThrow(/sourceId/);
  });

  it('an override on source A does not appear on source B', async () => {
    await repo.upsertNode({ publicKey: PUBKEY, name: 'N', latitude: 40, longitude: -105 }, 'src-a');
    await repo.upsertNode({ publicKey: PUBKEY, name: 'N', latitude: 40, longitude: -105 }, 'src-b');
    await repo.setNodePositionOverride('src-a', PUBKEY, PIN);

    expect(await repo.getNodePositionOverride('src-a', PUBKEY)).toEqual({ publicKey: PUBKEY, ...PIN });
    expect(await repo.getNodePositionOverride('src-b', PUBKEY)).toMatchObject({ enabled: false, isPrivate: false });
    expect(await repo.getNodePositionOverride('src-b', PUBKEY)).not.toHaveProperty('latitude', 28.5);

    expect([...(await repo.getPositionOverridesBySource('src-a')).keys()]).toEqual([PUBKEY]);
    expect((await repo.getPositionOverridesBySource('src-b')).size).toBe(0);
  });

  it('clearing on source A leaves source B alone', async () => {
    await repo.upsertNode({ publicKey: PUBKEY, name: 'N' }, 'src-a');
    await repo.upsertNode({ publicKey: PUBKEY, name: 'N' }, 'src-b');
    await repo.setNodePositionOverride('src-a', PUBKEY, PIN);
    await repo.setNodePositionOverride('src-b', PUBKEY, { ...PIN, latitude: 10 });
    await repo.clearNodePositionOverride('src-a', PUBKEY);

    expect((await repo.getNodePositionOverride('src-a', PUBKEY))?.enabled).toBe(false);
    expect(await repo.getNodePositionOverride('src-b', PUBKEY)).toMatchObject({ enabled: true, latitude: 10 });
  });

  it('enabled:false wipes the stored coordinates', async () => {
    await repo.upsertNode({ publicKey: PUBKEY }, 'src-a');
    await repo.setNodePositionOverride('src-a', PUBKEY, PIN);
    await repo.setNodePositionOverride('src-a', PUBKEY, { enabled: false });
    expect(await repo.getNodePositionOverride('src-a', PUBKEY)).toEqual({
      publicKey: PUBKEY, enabled: false, isPrivate: false,
      latitude: undefined, longitude: undefined, altitude: undefined,
    });
  });

  it('seeds a stub row for a node seen only in memory', async () => {
    await repo.setNodePositionOverride('src-a', PUBKEY_B, PIN);
    const row = await repo.getNodeByPublicKeyAndSource(PUBKEY_B, 'src-a');
    expect(row?.positionOverrideEnabled).toBe(true);
    expect(row?.latitude ?? null).toBeNull();
    expect(await repo.getNodeByPublicKeyAndSource(PUBKEY_B, 'src-b')).toBeNull();
  });

  it('advert ingest keeps writing lat/lon and never touches the override', async () => {
    await repo.upsertNode({ publicKey: PUBKEY, latitude: 40, longitude: -105, positionSource: 'contact' }, 'src-a');
    await repo.setNodePositionOverride('src-a', PUBKEY, PIN);

    await repo.upsertNode({
      publicKey: PUBKEY,
      latitude: 41,
      longitude: -106,
      positionSource: 'contact',
      // A caller that spreads stale override fields back in.
      positionOverrideEnabled: false,
      latitudeOverride: null,
      longitudeOverride: 1,
      positionOverrideIsPrivate: false,
    }, 'src-a');

    const row = await repo.getNodeByPublicKeyAndSource(PUBKEY, 'src-a');
    expect(row).toMatchObject({ latitude: 41, longitude: -106 });
    expect(await repo.getNodePositionOverride('src-a', PUBKEY)).toEqual({ publicKey: PUBKEY, ...PIN });
  });

  it('getPositionOverridesBySource skips a row with no coordinates', async () => {
    await repo.upsertNode({ publicKey: PUBKEY }, 'src-a');
    await repo.setNodePositionOverride('src-a', PUBKEY, { enabled: true, latitude: null, longitude: 5 });
    expect((await repo.getPositionOverridesBySource('src-a')).size).toBe(0);
  });
});
