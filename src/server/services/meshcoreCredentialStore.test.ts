/**
 * MeshCoreCredentialStore tests
 *
 * Covers the security-relevant invariants:
 *   - capability gating on auto-generated SESSION_SECRET
 *   - round-trip encryption (store → load returns the same password)
 *   - key-rotation detection (different SESSION_SECRET → key_rotated)
 *   - tamper detection (modified envelope → key_rotated)
 *   - listRotated only reports envelopes encrypted under a different key
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MeshCoreCredentialStore } from './meshcoreCredentialStore.js';

// Stable hex strings used for both pubkey args and snapshot stability.
const SOURCE_A = 'source-a';
const PUBKEY_1 = 'a'.repeat(64);
const PUBKEY_2 = 'b'.repeat(64);

// In-memory backing for databaseService.meshcore methods that the store
// touches. Reset in beforeEach so each test starts clean.
type Row = { sourceId: string; publicKey: string; name: string | null; adminCredential: string | null };
const rows = new Map<string, Row>();
const keyOf = (s: string, p: string) => `${s}|${p}`;

vi.mock('../../services/database.js', () => ({
  default: {
    meshcore: {
      setAdminCredential: vi.fn(async (sourceId: string, publicKey: string, envelope: string | null) => {
        const k = keyOf(sourceId, publicKey);
        const existing = rows.get(k);
        rows.set(k, {
          sourceId,
          publicKey,
          name: existing?.name ?? null,
          adminCredential: envelope,
        });
      }),
      getAdminCredential: vi.fn(async (sourceId: string, publicKey: string) => {
        return rows.get(keyOf(sourceId, publicKey))?.adminCredential ?? null;
      }),
      listAdminCredentials: vi.fn(async () => {
        return Array.from(rows.values())
          .filter((r) => r.adminCredential != null)
          .map((r) => ({
            sourceId: r.sourceId,
            publicKey: r.publicKey,
            name: r.name,
            adminCredential: r.adminCredential as string,
          }));
      }),
    },
  },
}));

// Avoid pulling the real env config (which would import the whole server
// bootstrap). Tests construct stores directly with explicit secrets.
vi.mock('../config/environment.js', () => ({
  getEnvironmentConfig: vi.fn(() => ({
    sessionSecret: 'not-used-in-these-tests',
    sessionSecretProvided: false,
  })),
}));

describe('MeshCoreCredentialStore', () => {
  beforeEach(() => {
    rows.clear();
    vi.clearAllMocks();
  });

  describe('capability', () => {
    it('reports canRemember=true when SESSION_SECRET was explicitly provided', () => {
      const store = new MeshCoreCredentialStore('a'.repeat(64), true);
      expect(store.capability.canRemember).toBe(true);
      expect(store.capability.reason).toBeUndefined();
    });

    it('reports canRemember=false when SESSION_SECRET was auto-generated', () => {
      const store = new MeshCoreCredentialStore('a'.repeat(64), false);
      expect(store.capability.canRemember).toBe(false);
      expect(store.capability.reason).toContain('SESSION_SECRET');
    });
  });

  describe('store / load round-trip', () => {
    it('round-trips a password through encrypt + decrypt', async () => {
      const store = new MeshCoreCredentialStore('a'.repeat(64), true);
      await store.store(SOURCE_A, PUBKEY_1, 'hunter2');
      const result = await store.load(SOURCE_A, PUBKEY_1);
      expect(result).toEqual({ kind: 'ok', password: 'hunter2' });
    });

    it('returns kind=none when nothing is stored', async () => {
      const store = new MeshCoreCredentialStore('a'.repeat(64), true);
      const result = await store.load(SOURCE_A, PUBKEY_1);
      expect(result).toEqual({ kind: 'none' });
    });

    it('throws when storing under an auto-generated SESSION_SECRET', async () => {
      const store = new MeshCoreCredentialStore('a'.repeat(64), false);
      await expect(store.store(SOURCE_A, PUBKEY_1, 'hunter2')).rejects.toThrow(
        /auto-generated/,
      );
    });

    it('clear() removes a saved credential', async () => {
      const store = new MeshCoreCredentialStore('a'.repeat(64), true);
      await store.store(SOURCE_A, PUBKEY_1, 'hunter2');
      await store.clear(SOURCE_A, PUBKEY_1);
      const result = await store.load(SOURCE_A, PUBKEY_1);
      expect(result).toEqual({ kind: 'none' });
    });
  });

  describe('key rotation', () => {
    it('detects a rotated SESSION_SECRET as key_rotated', async () => {
      const original = new MeshCoreCredentialStore('a'.repeat(64), true);
      await original.store(SOURCE_A, PUBKEY_1, 'hunter2');

      const rotated = new MeshCoreCredentialStore('b'.repeat(64), true);
      const result = await rotated.load(SOURCE_A, PUBKEY_1);
      expect(result.kind).toBe('key_rotated');
      // The stored kid should be the original store's fingerprint
      if (result.kind === 'key_rotated') {
        expect(result.storedKid).toBe(original.currentFingerprint);
        expect(result.storedKid).not.toBe(rotated.currentFingerprint);
      }
    });

    it('treats a malformed envelope as key_rotated', async () => {
      const store = new MeshCoreCredentialStore('a'.repeat(64), true);
      // Plant a junk row directly through the mocked repo.
      rows.set(keyOf(SOURCE_A, PUBKEY_1), {
        sourceId: SOURCE_A,
        publicKey: PUBKEY_1,
        name: null,
        adminCredential: 'not-json',
      });
      const result = await store.load(SOURCE_A, PUBKEY_1);
      expect(result.kind).toBe('key_rotated');
    });

    it('treats a tampered auth tag as key_rotated (not silent acceptance)', async () => {
      const store = new MeshCoreCredentialStore('a'.repeat(64), true);
      await store.store(SOURCE_A, PUBKEY_1, 'hunter2');
      const raw = rows.get(keyOf(SOURCE_A, PUBKEY_1))!.adminCredential!;
      const env = JSON.parse(raw) as { tag: string };
      // Flip a hex nibble in the tag — kid still matches, decrypt must fail.
      env.tag = env.tag.replace(/^./, (c) => (c === '0' ? '1' : '0'));
      rows.get(keyOf(SOURCE_A, PUBKEY_1))!.adminCredential = JSON.stringify(env);

      const result = await store.load(SOURCE_A, PUBKEY_1);
      expect(result.kind).toBe('key_rotated');
    });

    it('listStored returns only entries whose kid matches the current secret', async () => {
      const original = new MeshCoreCredentialStore('a'.repeat(64), true);
      await original.store(SOURCE_A, PUBKEY_1, 'pw1');
      await original.store(SOURCE_A, PUBKEY_2, 'pw2');

      const stored = await original.listStored();
      expect(stored).toHaveLength(2);
      expect(stored.map((s) => s.publicKey).sort()).toEqual([PUBKEY_1, PUBKEY_2].sort());
      for (const entry of stored) {
        expect(entry.sourceId).toBe(SOURCE_A);
      }

      // Rotate → listStored now empty (everything is rotated).
      const rotated = new MeshCoreCredentialStore('b'.repeat(64), true);
      expect(await rotated.listStored()).toEqual([]);
    });

    it('listStored and listRotated are mutually exclusive for any given row', async () => {
      const original = new MeshCoreCredentialStore('a'.repeat(64), true);
      await original.store(SOURCE_A, PUBKEY_1, 'pw1');

      const storedKeys = (await original.listStored()).map((s) => s.publicKey);
      const rotatedKeys = (await original.listRotated()).map((r) => r.publicKey);
      const intersection = storedKeys.filter((k) => rotatedKeys.includes(k));
      expect(intersection).toEqual([]);
    });

    it('listRotated returns only entries whose kid does not match the current secret', async () => {
      const original = new MeshCoreCredentialStore('a'.repeat(64), true);
      await original.store(SOURCE_A, PUBKEY_1, 'pw1');
      await original.store(SOURCE_A, PUBKEY_2, 'pw2');

      // Same secret → both decrypt cleanly, listRotated is empty.
      expect(await original.listRotated()).toEqual([]);

      // Rotate to a different secret → both should now be reported.
      const rotated = new MeshCoreCredentialStore('b'.repeat(64), true);
      const stale = await rotated.listRotated();
      expect(stale).toHaveLength(2);
      expect(stale.map((s) => s.publicKey).sort()).toEqual([PUBKEY_1, PUBKEY_2].sort());
      for (const entry of stale) {
        expect(entry.storedKid).toBe(original.currentFingerprint);
      }
    });
  });
});
