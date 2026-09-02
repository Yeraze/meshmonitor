/**
 * MeshCoreObserverCredentialStore tests (#4595) — encryption round-trip,
 * key-rotation detection, capability gating, "the password never leaves via
 * status()", and key separation from the sibling observer *signing key* store
 * (a leaked SESSION_SECRET plus one table must not decrypt the other).
 *
 * Also covers the #5014 Phase 1 multi-broker extension: the v1->v2 credential
 * document upgrade, per-broker isolation, and the four new per-broker methods
 * (tests 16-24 in `MESHMAPPER_OBSERVER_PHASE1_SPEC.md` §6.4).
 *
 * The DB layer is mocked with an in-memory map keyed by sourceId, mirroring
 * `meshcore_observer_credentials`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  MeshCoreObserverCredentialStore,
  OBSERVER_MAX_BROKER_CREDENTIALS,
} from './meshcoreObserverCredentialStore.js';
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

  // ---------------------------------------------------------------------
  // #5014 Phase 1 WP2: per-broker credential store (spec §6.4, tests 16-24)
  // ---------------------------------------------------------------------

  const BROKER_A = 'wss://mqtt.meshmapper.net:443';
  const BROKER_B = 'wss://mqtt-us-v1.letsmesh.net:443';

  it('[16] v1 read path unchanged: a legacy row still loads via load() and status() keeps its shape', async () => {
    const store = new MeshCoreObserverCredentialStore(SECRET_A, true);
    await store.store(SOURCE, 'meshcore', 'meshcore-pw');

    expect(await store.load(SOURCE)).toEqual({ kind: 'ok', username: 'meshcore', password: 'meshcore-pw' });

    const status = await store.status(SOURCE);
    expect(Object.keys(status).sort()).toEqual(
      ['canStore', 'keyRotated', 'reason', 'stored', 'updatedAt', 'username'].sort(),
    );
    expect(status).toMatchObject({ stored: true, username: 'meshcore', keyRotated: false });
    expect(status).not.toHaveProperty('brokers');
  });

  it('[17] v1 -> v2 upgrade is lossless: legacy stays intact after storeForBroker() adds a broker', async () => {
    const store = new MeshCoreObserverCredentialStore(SECRET_A, true);
    await store.store(SOURCE, 'legacy-user', 'legacy-pw');
    await store.storeForBroker(SOURCE, BROKER_A, 'broker-a-user', 'broker-a-pw');

    expect(await store.load(SOURCE)).toEqual({ kind: 'ok', username: 'legacy-user', password: 'legacy-pw' });
    expect(await store.loadForBroker(SOURCE, BROKER_A)).toEqual({
      kind: 'ok',
      username: 'broker-a-user',
      password: 'broker-a-pw',
    });
  });

  it('[18] per-broker isolation: A and B round-trip independently; an unconfigured broker returns none', async () => {
    const store = new MeshCoreObserverCredentialStore(SECRET_A, true);
    await store.storeForBroker(SOURCE, BROKER_A, 'user-a', 'pw-a');
    await store.storeForBroker(SOURCE, BROKER_B, 'user-b', 'pw-b');

    expect(await store.loadForBroker(SOURCE, BROKER_A)).toEqual({ kind: 'ok', username: 'user-a', password: 'pw-a' });
    expect(await store.loadForBroker(SOURCE, BROKER_B)).toEqual({ kind: 'ok', username: 'user-b', password: 'pw-b' });

    const loadedA = await store.loadForBroker(SOURCE, BROKER_A);
    if (loadedA.kind === 'ok') {
      expect(loadedA.password).not.toBe('pw-b');
    }

    expect(await store.loadForBroker(SOURCE, 'wss://never-configured/')).toEqual({ kind: 'none' });
  });

  it('[19] no legacy leak: with only a legacy credential stored, loadForBroker never falls back to it', async () => {
    const store = new MeshCoreObserverCredentialStore(SECRET_A, true);
    await store.store(SOURCE, 'legacy-user', 'legacy-pw');

    expect(await store.loadForBroker(SOURCE, BROKER_A)).toEqual({ kind: 'none' });
    expect(await store.loadForBroker(SOURCE, 'anything-at-all')).toEqual({ kind: 'none' });
  });

  it('[20] clearForBroker removes one entry and leaves the others; clearing the last entry with no legacy deletes the row', async () => {
    const store = new MeshCoreObserverCredentialStore(SECRET_A, true);
    await store.storeForBroker(SOURCE, BROKER_A, 'user-a', 'pw-a');
    await store.storeForBroker(SOURCE, BROKER_B, 'user-b', 'pw-b');

    await store.clearForBroker(SOURCE, BROKER_A);
    expect(await store.loadForBroker(SOURCE, BROKER_A)).toEqual({ kind: 'none' });
    expect(await store.loadForBroker(SOURCE, BROKER_B)).toEqual({ kind: 'ok', username: 'user-b', password: 'pw-b' });
    expect(credRows.has(SOURCE)).toBe(true);

    await store.clearForBroker(SOURCE, BROKER_B);
    expect(credRows.has(SOURCE)).toBe(false);
    expect(await store.loadForBroker(SOURCE, BROKER_B)).toEqual({ kind: 'none' });

    // No-op on an already-absent broker / a row that no longer exists.
    await expect(store.clearForBroker(SOURCE, BROKER_A)).resolves.toBeUndefined();
  });

  it('[20b] clearForBroker preserves a legacy entry when brokers become empty', async () => {
    const store = new MeshCoreObserverCredentialStore(SECRET_A, true);
    await store.store(SOURCE, 'legacy-user', 'legacy-pw');
    await store.storeForBroker(SOURCE, BROKER_A, 'user-a', 'pw-a');

    await store.clearForBroker(SOURCE, BROKER_A);

    expect(credRows.has(SOURCE)).toBe(true);
    expect(await store.load(SOURCE)).toEqual({ kind: 'ok', username: 'legacy-user', password: 'legacy-pw' });
  });

  it('[21] listBrokers returns {brokerKey, username} pairs and never a password field', async () => {
    const store = new MeshCoreObserverCredentialStore(SECRET_A, true);
    await store.storeForBroker(SOURCE, BROKER_A, 'user-a', 'pw-a');
    await store.storeForBroker(SOURCE, BROKER_B, 'user-b', 'pw-b');

    const listed = await store.listBrokers(SOURCE);
    expect(listed).toHaveLength(2);
    for (const entry of listed) {
      expect(Object.keys(entry).sort()).toEqual(['brokerKey', 'username']);
    }
    expect(listed).toEqual(
      expect.arrayContaining([
        { brokerKey: BROKER_A, username: 'user-a' },
        { brokerKey: BROKER_B, username: 'user-b' },
      ]),
    );
    expect(JSON.stringify(listed)).not.toContain('pw-a');
    expect(JSON.stringify(listed)).not.toContain('pw-b');
  });

  it('[21b] listBrokers returns [] when there is no row', async () => {
    const store = new MeshCoreObserverCredentialStore(SECRET_A, true);
    expect(await store.listBrokers('nope')).toEqual([]);
  });

  it('[22] key_rotated: a doc encrypted under a different SESSION_SECRET reports rotated everywhere, and listBrokers is []', async () => {
    const original = new MeshCoreObserverCredentialStore(SECRET_A, true);
    await original.storeForBroker(SOURCE, BROKER_A, 'user-a', 'pw-a');

    const rotated = new MeshCoreObserverCredentialStore(SECRET_B, true);
    expect((await rotated.load(SOURCE)).kind).toBe('key_rotated');
    expect((await rotated.loadForBroker(SOURCE, BROKER_A)).kind).toBe('key_rotated');
    expect(await rotated.listBrokers(SOURCE)).toEqual([]);
    expect((await rotated.status(SOURCE)).keyRotated).toBe(true);
  });

  it('[23] storeForBroker throws when capability.canStore is false, and rejects the 9th distinct broker', async () => {
    const noStore = new MeshCoreObserverCredentialStore(SECRET_A, false);
    await expect(noStore.storeForBroker(SOURCE, BROKER_A, 'u', 'p')).rejects.toThrow(/auto-generated/);
    expect(credRows.size).toBe(0);

    const store = new MeshCoreObserverCredentialStore(SECRET_A, true);
    for (let i = 0; i < OBSERVER_MAX_BROKER_CREDENTIALS; i++) {
      await store.storeForBroker(SOURCE, `wss://broker-${i}.test/`, `user-${i}`, `pw-${i}`);
    }
    expect(await store.listBrokers(SOURCE)).toHaveLength(OBSERVER_MAX_BROKER_CREDENTIALS);

    await expect(
      store.storeForBroker(SOURCE, 'wss://one-too-many.test/', 'user-x', 'pw-x'),
    ).rejects.toThrow(/maximum/i);
    expect(await store.listBrokers(SOURCE)).toHaveLength(OBSERVER_MAX_BROKER_CREDENTIALS);

    // Updating an already-stored broker's credential is not a NEW broker and
    // must not be blocked by the cap.
    await expect(store.storeForBroker(SOURCE, 'wss://broker-0.test/', 'user-0b', 'pw-0b')).resolves.toBeUndefined();
    expect(await store.loadForBroker(SOURCE, 'wss://broker-0.test/')).toEqual({
      kind: 'ok',
      username: 'user-0b',
      password: 'pw-0b',
    });
  });

  it('[24] a v1 password that is not valid JSON, and one that is valid JSON but not the v2 shape, both decode as v1', async () => {
    const store = new MeshCoreObserverCredentialStore(SECRET_A, true);

    // Not JSON at all — a typical real-world legacy password.
    await store.store(SOURCE, 'u1', 'not-json-at-all!!');
    expect(await store.load(SOURCE)).toEqual({ kind: 'ok', username: 'u1', password: 'not-json-at-all!!' });

    // Valid JSON, but not the v2 {v:2, brokers:{...}} shape (an array).
    await store.store(SOURCE, 'u2', '[1,2,3]');
    expect(await store.load(SOURCE)).toEqual({ kind: 'ok', username: 'u2', password: '[1,2,3]' });

    // Valid JSON object, but missing the v2 discriminator.
    await store.store(SOURCE, 'u3', '{"hello":"world"}');
    expect(await store.load(SOURCE)).toEqual({ kind: 'ok', username: 'u3', password: '{"hello":"world"}' });
  });
});
