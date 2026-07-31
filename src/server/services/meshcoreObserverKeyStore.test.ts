/**
 * MeshCoreObserverKeyStore tests — encryption round-trip, key-rotation
 * detection, capability gating, and key separation from SourcePkiKeyStore.
 * The DB layer is mocked with in-memory maps keyed by sourceId (mirroring
 * the `meshcore_observer_keys` / `source_pki_keys` tables).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  MeshCoreObserverKeyStore,
  type ObserverKeyStatus,
} from './meshcoreObserverKeyStore.js';
import { SourcePkiKeyStore } from './sourcePkiKeyStore.js';

interface ObserverRow {
  sourceId: string;
  encryptedPrivateKey: string;
  publicKey: string | null;
  keyOrigin: string | null;
  createdAt: number;
  updatedAt: number;
}
const observerRows = new Map<string, ObserverRow>();

interface PkiRow {
  sourceId: string;
  nodeNum: number | null;
  encryptedPrivateKey: string;
  publicKey: string | null;
  createdAt: number;
  updatedAt: number;
}
const pkiRows = new Map<string, PkiRow>();

vi.mock('../../services/database.js', () => ({
  default: {
    meshcoreObserverKeys: {
      upsert: vi.fn(
        async (
          sourceId: string,
          encryptedPrivateKey: string,
          publicKey: string | null,
          keyOrigin: 'device' | 'manual',
        ) => {
          const existing = observerRows.get(sourceId);
          observerRows.set(sourceId, {
            sourceId,
            encryptedPrivateKey,
            publicKey,
            keyOrigin,
            createdAt: existing?.createdAt ?? 1,
            updatedAt: (existing?.updatedAt ?? 0) + 1,
          });
        },
      ),
      getBySourceId: vi.fn(async (sourceId: string) => observerRows.get(sourceId) ?? null),
      hasKey: vi.fn(async (sourceId: string) => observerRows.has(sourceId)),
      deleteBySourceId: vi.fn(async (sourceId: string) => {
        observerRows.delete(sourceId);
      }),
    },
    sourcePkiKeys: {
      upsert: vi.fn(
        async (sourceId: string, nodeNum: number | null, encryptedPrivateKey: string, publicKey: string | null) => {
          const existing = pkiRows.get(sourceId);
          pkiRows.set(sourceId, {
            sourceId,
            nodeNum,
            encryptedPrivateKey,
            publicKey,
            createdAt: existing?.createdAt ?? 1,
            updatedAt: (existing?.updatedAt ?? 0) + 1,
          });
        },
      ),
      getBySourceId: vi.fn(async (sourceId: string) => pkiRows.get(sourceId) ?? null),
      getByNodeNum: vi.fn(async (_nodeNum: number) => null),
      hasKey: vi.fn(async (sourceId: string) => pkiRows.has(sourceId)),
      deleteBySourceId: vi.fn(async (sourceId: string) => {
        pkiRows.delete(sourceId);
      }),
      deleteAll: vi.fn(async () => {
        const n = pkiRows.size;
        pkiRows.clear();
        return n;
      }),
    },
    settings: {
      getSetting: vi.fn(async (_key: string) => null),
    },
  },
}));

vi.mock('../config/environment.js', () => ({
  getEnvironmentConfig: vi.fn(() => ({ sessionSecret: 'unused', sessionSecretProvided: false })),
}));

const SECRET = 'a'.repeat(64);
// 128-char hex — shape only matters here, this module never validates
// orlp clamping (that lives in meshcoreObserverToken.ts).
const PRIV = '11'.repeat(64);
const PUB = '22'.repeat(32);

describe('MeshCoreObserverKeyStore', () => {
  beforeEach(() => {
    observerRows.clear();
    pkiRows.clear();
    vi.clearAllMocks();
  });

  it('round-trips a signing key (store -> load) with identical hex, publicKey, and origin', async () => {
    const store = new MeshCoreObserverKeyStore(SECRET, true);
    await store.store('src-a', PRIV, PUB, 'manual');

    const loaded = await store.load('src-a');
    expect(loaded.kind).toBe('ok');
    if (loaded.kind === 'ok') {
      expect(loaded.privateKeyHex).toBe(PRIV);
      expect(loaded.publicKeyHex).toBe(PUB);
      expect(loaded.origin).toBe('manual');
    }
  });

  it('flags key_rotated when the SESSION_SECRET changed, with publicKey still readable via status()', async () => {
    const a = new MeshCoreObserverKeyStore(SECRET, true);
    await a.store('src-a', PRIV, PUB, 'device');

    const b = new MeshCoreObserverKeyStore('b'.repeat(64), true);
    const loaded = await b.load('src-a');
    expect(loaded.kind).toBe('key_rotated');

    const status: ObserverKeyStatus = await b.status('src-a');
    expect(status.keyRotated).toBe(true);
    expect(status.stored).toBe(true);
    expect(status.publicKey).toBe(PUB);
    // storedKid must never leak through status().
    expect(Object.keys(status)).not.toContain('storedKid');
  });

  it('refuses to store when SESSION_SECRET is auto-generated', async () => {
    const store = new MeshCoreObserverKeyStore(SECRET, false);
    expect(store.capability.canStore).toBe(false);
    expect(store.capability.reason).toMatch(/auto-generated/);
    await expect(store.store('src-a', PRIV, PUB, 'manual')).rejects.toThrow(/auto-generated/);
  });

  it('key separation: a SourcePkiKeyStore with the same SESSION_SECRET cannot decrypt an observer envelope', async () => {
    const observerStore = new MeshCoreObserverKeyStore(SECRET, true);
    const pkiStore = new SourcePkiKeyStore(SECRET, true);

    // Different KDF info strings must yield different fingerprints even
    // though both stores are constructed from the identical secret.
    expect(observerStore.currentFingerprint).not.toBe((pkiStore as unknown as { currentKid: string }).currentKid ?? '');

    await observerStore.store('src-a', PRIV, PUB, 'manual');
    const observerRow = observerRows.get('src-a')!;

    // Feed the observer envelope directly into the PKI store's table and
    // attempt to load it as if it were a PKI key. It must not be usable.
    pkiRows.set('src-a', {
      sourceId: 'src-a',
      nodeNum: null,
      encryptedPrivateKey: observerRow.encryptedPrivateKey,
      publicKey: null,
      createdAt: 1,
      updatedAt: 1,
    });

    const crossLoad = await pkiStore.load('src-a');
    expect(crossLoad.kind).toBe('key_rotated');
  });

  it('clear() is idempotent and status() on an empty source returns stored:false', async () => {
    const store = new MeshCoreObserverKeyStore(SECRET, true);
    expect((await store.status('src-empty')).stored).toBe(false);

    // Clearing a source that never had a key must not throw.
    await store.clear('src-empty');
    await store.clear('src-empty');

    await store.store('src-a', PRIV, PUB, 'device');
    expect((await store.status('src-a')).stored).toBe(true);
    await store.clear('src-a');
    expect((await store.status('src-a')).stored).toBe(false);
    expect((await store.load('src-a')).kind).toBe('none');
    // Idempotent second clear.
    await store.clear('src-a');
  });

  it('envelope shape: {v, kid, iv, ct, tag} with correct lengths, and never contains the raw key', async () => {
    const store = new MeshCoreObserverKeyStore(SECRET, true);
    await store.store('src-a', PRIV, PUB, 'manual');

    const raw = observerRows.get('src-a')!.encryptedPrivateKey;
    const parsed = JSON.parse(raw);
    expect(parsed).toMatchObject({
      v: 1,
      kid: expect.any(String),
      iv: expect.any(String),
      ct: expect.any(String),
      tag: expect.any(String),
    });
    expect(parsed.iv).toHaveLength(24); // 12 bytes hex
    expect(parsed.tag).toHaveLength(32); // 16 bytes hex

    // The raw private key hex must never appear as a substring anywhere in
    // the persisted envelope JSON.
    expect(raw).not.toContain(PRIV);
    expect(raw.toLowerCase()).not.toContain(PRIV.toLowerCase());
  });
});
