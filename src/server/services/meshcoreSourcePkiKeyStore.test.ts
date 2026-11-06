/**
 * MeshCoreSourcePkiKeyStore tests (#6195) — encryption round-trip, key-rotation
 * detection, capability gating, keyMismatch surfacing, and key separation from
 * MeshCoreObserverKeyStore / SourcePkiKeyStore. The DB layer is mocked with an
 * in-memory map keyed by sourceId (mirroring `meshcore_source_pki_keys`).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  MeshCoreSourcePkiKeyStore,
  type SourcePkiKeyStatus,
} from './meshcoreSourcePkiKeyStore.js';
import { MeshCoreObserverKeyStore } from './meshcoreObserverKeyStore.js';

interface Row {
  sourceId: string;
  encryptedPrivateKey: string;
  publicKey: string | null;
  keyMismatch: number;
  createdAt: number;
  updatedAt: number;
}
const rows = new Map<string, Row>();

interface ObserverRow {
  sourceId: string;
  encryptedPrivateKey: string;
  publicKey: string | null;
  keyOrigin: string | null;
  createdAt: number;
  updatedAt: number;
}
const observerRows = new Map<string, ObserverRow>();

vi.mock('../../services/database.js', () => ({
  default: {
    meshcoreSourcePkiKeys: {
      upsert: vi.fn(
        async (sourceId: string, encryptedPrivateKey: string, publicKey: string | null, keyMismatch = 0) => {
          const existing = rows.get(sourceId);
          rows.set(sourceId, {
            sourceId,
            encryptedPrivateKey,
            publicKey,
            keyMismatch,
            createdAt: existing?.createdAt ?? 1,
            updatedAt: (existing?.updatedAt ?? 0) + 1,
          });
        },
      ),
      getBySourceId: vi.fn(async (sourceId: string) => rows.get(sourceId) ?? null),
      setKeyMismatch: vi.fn(async (sourceId: string, mismatch: boolean) => {
        const r = rows.get(sourceId);
        if (r) r.keyMismatch = mismatch ? 1 : 0;
      }),
      deleteBySourceId: vi.fn(async (sourceId: string) => {
        rows.delete(sourceId);
      }),
    },
    meshcoreObserverKeys: {
      upsert: vi.fn(
        async (sourceId: string, encryptedPrivateKey: string, publicKey: string | null, keyOrigin: string) => {
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
      deleteBySourceId: vi.fn(async (sourceId: string) => {
        observerRows.delete(sourceId);
      }),
    },
  },
}));

vi.mock('../config/environment.js', () => ({
  getEnvironmentConfig: vi.fn(() => ({ sessionSecret: 'unused', sessionSecretProvided: false })),
}));

const SECRET = 'a'.repeat(64);
const PRIV = '11'.repeat(64); // 128-char orlp private key hex (shape only)
const PUB = '22'.repeat(32); // 64-char Ed25519 public key hex

describe('MeshCoreSourcePkiKeyStore', () => {
  beforeEach(() => {
    rows.clear();
    observerRows.clear();
    vi.clearAllMocks();
  });

  it('round-trips a device key (store -> load) with identical hex and publicKey', async () => {
    const store = new MeshCoreSourcePkiKeyStore(SECRET, true);
    await store.store('src-a', PRIV, PUB);

    const loaded = await store.load('src-a');
    expect(loaded.kind).toBe('ok');
    if (loaded.kind === 'ok') {
      expect(loaded.privateKeyHex).toBe(PRIV);
      expect(loaded.publicKeyHex).toBe(PUB);
      expect(loaded.keyMismatch).toBe(false);
    }
  });

  it('flags key_rotated when the SESSION_SECRET changed, with publicKey still readable via status()', async () => {
    const a = new MeshCoreSourcePkiKeyStore(SECRET, true);
    await a.store('src-a', PRIV, PUB);

    const b = new MeshCoreSourcePkiKeyStore('b'.repeat(64), true);
    const loaded = await b.load('src-a');
    expect(loaded.kind).toBe('key_rotated');

    const status: SourcePkiKeyStatus = await b.status('src-a');
    expect(status.keyRotated).toBe(true);
    expect(status.stored).toBe(true);
    expect(status.publicKey).toBe(PUB);
    // storedKid must never leak through status().
    expect(Object.keys(status)).not.toContain('storedKid');
  });

  it('refuses to store when SESSION_SECRET is auto-generated', async () => {
    const store = new MeshCoreSourcePkiKeyStore(SECRET, false);
    expect(store.capability.canStore).toBe(false);
    expect(store.capability.reason).toMatch(/auto-generated/);
    await expect(store.store('src-a', PRIV, PUB)).rejects.toThrow(/auto-generated/);
  });

  it('surfaces a keyMismatch flag through load() and status()', async () => {
    const store = new MeshCoreSourcePkiKeyStore(SECRET, true);
    await store.store('src-a', PRIV, PUB);
    rows.get('src-a')!.keyMismatch = 1;

    const loaded = await store.load('src-a');
    expect(loaded.kind).toBe('ok');
    if (loaded.kind === 'ok') expect(loaded.keyMismatch).toBe(true);
    expect((await store.status('src-a')).keyMismatch).toBe(true);
  });

  it('key separation: a MeshCoreObserverKeyStore with the same SESSION_SECRET cannot decrypt a device-key envelope', async () => {
    const pkiStore = new MeshCoreSourcePkiKeyStore(SECRET, true);
    const observerStore = new MeshCoreObserverKeyStore(SECRET, true);

    // Different KDF info strings must yield different fingerprints even though
    // both stores are built from the identical secret.
    expect(pkiStore.currentFingerprint).not.toBe(observerStore.currentFingerprint);

    await pkiStore.store('src-a', PRIV, PUB);
    const envelope = rows.get('src-a')!.encryptedPrivateKey;

    // Feed the device-key envelope into the observer table and try to load it
    // as an observer key. It must not be usable.
    observerRows.set('src-a', {
      sourceId: 'src-a',
      encryptedPrivateKey: envelope,
      publicKey: null,
      keyOrigin: 'device',
      createdAt: 1,
      updatedAt: 1,
    });
    expect((await observerStore.load('src-a')).kind).toBe('key_rotated');
  });

  it('clear() is idempotent and status() on an empty source returns stored:false', async () => {
    const store = new MeshCoreSourcePkiKeyStore(SECRET, true);
    expect((await store.status('src-empty')).stored).toBe(false);
    await store.clear('src-empty');
    await store.clear('src-empty');

    await store.store('src-a', PRIV, PUB);
    expect((await store.status('src-a')).stored).toBe(true);
    await store.clear('src-a');
    expect((await store.status('src-a')).stored).toBe(false);
    expect((await store.load('src-a')).kind).toBe('none');
    await store.clear('src-a');
  });

  it('envelope shape: {v, kid, iv, ct, tag} with correct lengths, and never contains the raw key', async () => {
    const store = new MeshCoreSourcePkiKeyStore(SECRET, true);
    await store.store('src-a', PRIV, PUB);

    const raw = rows.get('src-a')!.encryptedPrivateKey;
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
    expect(raw).not.toContain(PRIV);
    expect(raw.toLowerCase()).not.toContain(PRIV.toLowerCase());
  });
});
