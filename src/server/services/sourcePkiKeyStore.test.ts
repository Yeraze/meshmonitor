/**
 * SourcePkiKeyStore tests — encryption round-trip, destination-node lookup,
 * key-rotation detection, and capability gating. The DB layer is mocked with an
 * in-memory map keyed by sourceId (mirroring the source_pki_keys table).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomBytes } from 'crypto';
import { SourcePkiKeyStore, isPkiDmDecryptionGloballyEnabled, invalidatePkiDmGlobalCache } from './sourcePkiKeyStore.js';

interface Row {
  sourceId: string;
  nodeNum: number | null;
  encryptedPrivateKey: string;
  publicKey: string | null;
  createdAt: number;
  updatedAt: number;
}
const rows = new Map<string, Row>();

vi.mock('../../services/database.js', () => ({
  default: {
    sourcePkiKeys: {
      upsert: vi.fn(async (sourceId: string, nodeNum: number | null, encryptedPrivateKey: string, publicKey: string | null) => {
        const existing = rows.get(sourceId);
        rows.set(sourceId, {
          sourceId,
          nodeNum,
          encryptedPrivateKey,
          publicKey,
          createdAt: existing?.createdAt ?? 1,
          updatedAt: (existing?.updatedAt ?? 0) + 1,
        });
      }),
      getBySourceId: vi.fn(async (sourceId: string) => rows.get(sourceId) ?? null),
      getByNodeNum: vi.fn(async (nodeNum: number) => {
        const matches = Array.from(rows.values()).filter((r) => r.nodeNum === nodeNum);
        matches.sort((a, b) => b.updatedAt - a.updatedAt);
        return matches[0] ?? null;
      }),
      hasKey: vi.fn(async (sourceId: string) => rows.has(sourceId)),
      deleteBySourceId: vi.fn(async (sourceId: string) => { rows.delete(sourceId); }),
      deleteAll: vi.fn(async () => { const n = rows.size; rows.clear(); return n; }),
    },
    settings: {
      getSetting: vi.fn(async (_key: string) => globalSettingValue),
    },
  },
}));

let globalSettingValue: string | null = null;

vi.mock('../config/environment.js', () => ({
  getEnvironmentConfig: vi.fn(() => ({ sessionSecret: 'unused', sessionSecretProvided: false })),
}));

const SECRET = 'a'.repeat(64);

describe('SourcePkiKeyStore', () => {
  beforeEach(() => {
    rows.clear();
    vi.clearAllMocks();
  });

  it('round-trips a private key (store → load) and never persists it in the clear', async () => {
    const store = new SourcePkiKeyStore(SECRET, true);
    const priv = randomBytes(32);
    await store.store('src-a', 0x1234, priv, 'pubB64');

    // The persisted envelope must not contain the raw key bytes.
    const persisted = rows.get('src-a')!.encryptedPrivateKey;
    expect(persisted).not.toContain(priv.toString('hex'));
    expect(JSON.parse(persisted)).toMatchObject({ v: 1, kid: expect.any(String), iv: expect.any(String), ct: expect.any(String), tag: expect.any(String) });

    const loaded = await store.load('src-a');
    expect(loaded.kind).toBe('ok');
    if (loaded.kind === 'ok') expect(loaded.privateKey.equals(priv)).toBe(true);
  });

  it('loads by destination node identity (cross-source decrypt path)', async () => {
    const store = new SourcePkiKeyStore(SECRET, true);
    const priv = randomBytes(32);
    await store.store('src-r', 0xaabbccdd, priv, null);

    const loaded = await store.loadByNodeNum(0xaabbccdd);
    expect(loaded.kind).toBe('ok');
    if (loaded.kind === 'ok') expect(loaded.privateKey.equals(priv)).toBe(true);

    expect((await store.loadByNodeNum(0x99999999)).kind).toBe('none');
  });

  it('flags key_rotated when the SESSION_SECRET changed', async () => {
    const a = new SourcePkiKeyStore(SECRET, true);
    await a.store('src-a', 1, randomBytes(32), null);
    const b = new SourcePkiKeyStore('b'.repeat(64), true);
    expect((await b.load('src-a')).kind).toBe('key_rotated');
  });

  it('refuses to store when SESSION_SECRET is auto-generated', async () => {
    const store = new SourcePkiKeyStore(SECRET, false);
    expect(store.capability.canStore).toBe(false);
    await expect(store.store('src-a', 1, randomBytes(32), null)).rejects.toThrow(/auto-generated/);
  });

  it('clear removes the stored key', async () => {
    const store = new SourcePkiKeyStore(SECRET, true);
    await store.store('src-a', 1, randomBytes(32), null);
    expect(await store.hasStored('src-a')).toBe(true);
    await store.clear('src-a');
    expect(await store.hasStored('src-a')).toBe(false);
    expect((await store.load('src-a')).kind).toBe('none');
  });

  describe('global master switch', () => {
    it('reads pkiDmDecryptionGloballyEnabled (cached)', async () => {
      globalSettingValue = 'true';
      invalidatePkiDmGlobalCache();
      expect(await isPkiDmDecryptionGloballyEnabled()).toBe(true);
      // Cached: a change isn't seen until invalidated.
      globalSettingValue = 'false';
      expect(await isPkiDmDecryptionGloballyEnabled()).toBe(true);
      invalidatePkiDmGlobalCache();
      expect(await isPkiDmDecryptionGloballyEnabled()).toBe(false);
    });

    it('defaults to false when unset', async () => {
      globalSettingValue = null;
      invalidatePkiDmGlobalCache();
      expect(await isPkiDmDecryptionGloballyEnabled()).toBe(false);
    });
  });
});
