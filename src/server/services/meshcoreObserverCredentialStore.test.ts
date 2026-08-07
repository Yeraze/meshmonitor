/**
 * MeshCoreObserverCredentialStore tests (#4595) — encryption round-trip,
 * key-rotation detection, capability gating, "the password never leaves via
 * status()", and key separation from the sibling observer *signing key* store
 * (a leaked SESSION_SECRET plus one table must not decrypt the other).
 *
 * The DB layer is mocked with an in-memory map keyed by sourceId, mirroring
 * `meshcore_observer_credentials`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MeshCoreObserverCredentialStore } from './meshcoreObserverCredentialStore.js';
import { MeshCoreObserverKeyStore } from './meshcoreObserverKeyStore.js';

interface CredRow {
  sourceId: string;
  username: string;
  encryptedPassword: string;
  createdAt: number;
  updatedAt: number;
}
const credRows = new Map<string, CredRow>();

interface KeyRow {
  sourceId: string;
  encryptedPrivateKey: string;
  publicKey: string | null;
  keyOrigin: string | null;
  createdAt: number;
  updatedAt: number;
}
const keyRows = new Map<string, KeyRow>();

vi.mock('../../services/database.js', () => ({
  default: {
    meshcoreObserverCredentials: {
      upsert: vi.fn(async (sourceId: string, username: string, encryptedPassword: string) => {
        const existing = credRows.get(sourceId);
        credRows.set(sourceId, {
          sourceId,
          username,
          encryptedPassword,
          createdAt: existing?.createdAt ?? 1,
          updatedAt: (existing?.updatedAt ?? 0) + 1,
        });
      }),
      getBySourceId: vi.fn(async (sourceId: string) => credRows.get(sourceId) ?? null),
      deleteBySourceId: vi.fn(async (sourceId: string) => {
        credRows.delete(sourceId);
      }),
    },
    meshcoreObserverKeys: {
      upsert: vi.fn(
        async (
          sourceId: string,
          encryptedPrivateKey: string,
          publicKey: string | null,
          keyOrigin: 'device' | 'manual',
        ) => {
          keyRows.set(sourceId, {
            sourceId,
            encryptedPrivateKey,
            publicKey,
            keyOrigin,
            createdAt: 1,
            updatedAt: 1,
          });
        },
      ),
      getBySourceId: vi.fn(async (sourceId: string) => keyRows.get(sourceId) ?? null),
      deleteBySourceId: vi.fn(async (sourceId: string) => {
        keyRows.delete(sourceId);
      }),
    },
  },
}));

const SECRET_A = 'a'.repeat(64);
const SECRET_B = 'b'.repeat(64);
const SOURCE = 'src-1';

describe('MeshCoreObserverCredentialStore', () => {
  beforeEach(() => {
    credRows.clear();
    keyRows.clear();
  });

  it('round-trips a username/password through the encrypted envelope', async () => {
    const store = new MeshCoreObserverCredentialStore(SECRET_A, true);
    await store.store(SOURCE, 'meshcore', 'meshcore');

    const loaded = await store.load(SOURCE);
    expect(loaded).toEqual({ kind: 'ok', username: 'meshcore', password: 'meshcore' });
  });

  it('never writes the password in the clear', async () => {
    const store = new MeshCoreObserverCredentialStore(SECRET_A, true);
    await store.store(SOURCE, 'meshcore', 'sup3r-s3cret-pw');

    const row = credRows.get(SOURCE)!;
    expect(row.encryptedPassword).not.toContain('sup3r-s3cret-pw');
    // It is an AEAD envelope, not the raw value.
    const env = JSON.parse(row.encryptedPassword);
    expect(env).toMatchObject({ v: 1 });
    expect(env.kid).toEqual(expect.any(String));
    expect(env.iv).toMatch(/^[0-9a-f]{24}$/);
    expect(env.tag).toMatch(/^[0-9a-f]{32}$/);
    // The username IS clear, by design.
    expect(row.username).toBe('meshcore');
  });

  it('preserves passwords with leading/trailing whitespace and unicode', async () => {
    const store = new MeshCoreObserverCredentialStore(SECRET_A, true);
    await store.store(SOURCE, 'u', '  pä ss  ');
    const loaded = await store.load(SOURCE);
    expect(loaded).toEqual({ kind: 'ok', username: 'u', password: '  pä ss  ' });
  });

  it('reports key_rotated when SESSION_SECRET changed', async () => {
    await new MeshCoreObserverCredentialStore(SECRET_A, true).store(SOURCE, 'u', 'p');

    const other = new MeshCoreObserverCredentialStore(SECRET_B, true);
    const loaded = await other.load(SOURCE);
    expect(loaded.kind).toBe('key_rotated');
    expect((await other.status(SOURCE)).keyRotated).toBe(true);
  });

  it('treats a malformed envelope as rotated rather than throwing', async () => {
    credRows.set(SOURCE, {
      sourceId: SOURCE,
      username: 'u',
      encryptedPassword: 'not-json',
      createdAt: 1,
      updatedAt: 1,
    });
    const store = new MeshCoreObserverCredentialStore(SECRET_A, true);
    expect((await store.load(SOURCE)).kind).toBe('key_rotated');
    expect((await store.status(SOURCE)).keyRotated).toBe(true);
  });

  it('status() returns no password and no storedKid, ever', async () => {
    const store = new MeshCoreObserverCredentialStore(SECRET_A, true);
    await store.store(SOURCE, 'meshcore', 'meshcore');

    const status = await store.status(SOURCE);
    expect(Object.keys(status).sort()).toEqual(
      ['canStore', 'keyRotated', 'reason', 'stored', 'updatedAt', 'username'].sort(),
    );
    expect(JSON.stringify(status)).not.toContain('meshcore-pw');
    expect(status).toMatchObject({ stored: true, username: 'meshcore', keyRotated: false, canStore: true });
    expect(status).not.toHaveProperty('password');
    expect(status).not.toHaveProperty('storedKid');
  });

  it('status() on an unknown source reports not-stored', async () => {
    const status = await new MeshCoreObserverCredentialStore(SECRET_A, true).status('nope');
    expect(status).toMatchObject({ stored: false, username: null, updatedAt: null, keyRotated: false });
  });

  it('refuses to store when SESSION_SECRET is auto-generated', async () => {
    const store = new MeshCoreObserverCredentialStore(SECRET_A, false);
    expect(store.capability.canStore).toBe(false);
    expect(store.capability.reason).toMatch(/SESSION_SECRET/);
    await expect(store.store(SOURCE, 'u', 'p')).rejects.toThrow(/auto-generated/);
    expect(credRows.size).toBe(0);
  });

  it('clear() removes the row and is idempotent', async () => {
    const store = new MeshCoreObserverCredentialStore(SECRET_A, true);
    await store.store(SOURCE, 'u', 'p');
    await store.clear(SOURCE);
    await store.clear(SOURCE);
    expect((await store.load(SOURCE)).kind).toBe('none');
  });

  it('is key-separated from the observer signing-key store under one SESSION_SECRET', async () => {
    const creds = new MeshCoreObserverCredentialStore(SECRET_A, true);
    const keys = new MeshCoreObserverKeyStore(SECRET_A, true);
    expect(creds.currentFingerprint).not.toBe(keys.currentFingerprint);

    // Cross-feeding one store's envelope into the other must fail closed.
    await creds.store(SOURCE, 'u', 'p');
    keyRows.set(SOURCE, {
      sourceId: SOURCE,
      encryptedPrivateKey: credRows.get(SOURCE)!.encryptedPassword,
      publicKey: null,
      keyOrigin: 'manual',
      createdAt: 1,
      updatedAt: 1,
    });
    expect((await keys.load(SOURCE)).kind).toBe('key_rotated');
  });
});
