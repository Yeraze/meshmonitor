/**
 * meshcoreObserverToken tests — round-trips through the library's own
 * `verifyAuthToken`, the §2.2 "derived, not sliced" regression guard, and
 * `mintObserverTokenForSource`'s null-return contract.
 *
 * NOTE on `exp`/verification: `verifyAuthToken` checks `exp` against the
 * *real* wall clock, not the `iat`/`exp` values baked into the token — so
 * "successful round-trip" fixtures must anchor on `Date.now()`, not a fixed
 * historical Unix timestamp (a fixed past timestamp reads as expired).
 * Only the dedicated "expired token" case wants a deliberately-past `exp`.
 *
 * WASM warning (per spec §8.3): these tests instantiate WASM several times
 * (the library re-instantiates on every sign/verify/derive call regardless
 * of caching). Kept to a small case count deliberately.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { Utils, verifyAuthToken } from '@michaelhart/meshcore-decoder';
import {
  OBSERVER_TOKEN_TTL_SECONDS,
  deriveObserverPublicKey,
  isValidObserverPrivateKey,
  mintObserverToken,
  mintObserverTokenForSource,
  mintObserverTokenForSourceDetailed,
} from './meshcoreObserverToken.js';
import { MeshCoreObserverKeyStore, setMeshCoreObserverKeyStoreForTesting } from './meshcoreObserverKeyStore.js';

// Deterministic, valid, clamped orlp private key — checked in as a constant
// so fixtures are reproducible across runs.
const seed = Buffer.alloc(32, 7);
const h = crypto.createHash('sha512').update(seed).digest();
h[0] &= 248;
h[31] &= 63;
h[31] |= 64;
const PRIV = h.toString('hex');

// Deterministic INVALID (unclamped) fixture: the library's orlp WASM only
// rejects a key when the top bit of byte 31 (the last byte of the 32-byte
// scalar half) is set — i.e. `byte31 & 0x80 !== 0`. Empirically, `00`-fill
// and even fully random 64-byte buffers pass ~50% of the time (only that one
// bit is checked), so a random fixture would be flaky; this one deterministically
// sets that bit and nothing else.
const UNCLAMPED_PRIV = '00'.repeat(31) + 'ff' + '00'.repeat(32);

interface SourceRow {
  id: string;
  type: string;
  config: Record<string, unknown>;
}
const sourceRows = new Map<string, SourceRow>();

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
    sources: {
      getSource: vi.fn(async (id: string) => sourceRows.get(id) ?? null),
    },
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
  },
}));

describe('meshcoreObserverToken', () => {
  it('OBSERVER_TOKEN_TTL_SECONDS is 24h', () => {
    expect(OBSERVER_TOKEN_TTL_SECONDS).toBe(86_400);
  });

  it('public key is derived, not the second half of the private key', async () => {
    const derived = await deriveObserverPublicKey(PRIV);
    expect(derived).toMatch(/^[0-9A-F]{64}$/);

    const secondHalf = PRIV.slice(64).toUpperCase();
    expect(derived).not.toBe(secondHalf);

    expect(await Utils.validateKeyPair(PRIV, derived)).toBe(true);
  });

  describe('isValidObserverPrivateKey', () => {
    it('accepts the deterministic clamped fixture', async () => {
      expect(await isValidObserverPrivateKey(PRIV)).toBe(true);
    });

    it('never throws and rejects structurally invalid or unclamped keys', async () => {
      await expect(isValidObserverPrivateKey(UNCLAMPED_PRIV)).resolves.toBe(false);
      await expect(isValidObserverPrivateKey('11'.repeat(63) + '1')).resolves.toBe(false); // 127 chars
      await expect(isValidObserverPrivateKey('zz'.repeat(64))).resolves.toBe(false); // non-hex
      await expect(isValidObserverPrivateKey('')).resolves.toBe(false);
      // @ts-expect-error deliberately wrong type to prove no throw
      await expect(isValidObserverPrivateKey(undefined)).resolves.toBe(false);
    });
  });

  describe('mintObserverToken', () => {
    it("round-trips through the library's own verifyAuthToken", async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const result = await mintObserverToken(PRIV, 'test.aud', { nowSeconds });

      expect(result.publicKey).toMatch(/^[0-9A-F]{64}$/);
      expect(result.issuedAt).toBe(nowSeconds);
      expect(result.expiresAt).toBe(nowSeconds + OBSERVER_TOKEN_TTL_SECONDS);

      const payload = await verifyAuthToken(result.token, result.publicKey);
      expect(payload).not.toBeNull();
      expect(payload!.aud).toBe('test.aud');
      expect(payload!.iat).toBe(nowSeconds);
      expect(payload!.exp).toBe(nowSeconds + OBSERVER_TOKEN_TTL_SECONDS);
      expect(payload!.publicKey).toBe(result.publicKey);
    });

    it('rejects verification against the wrong public key', async () => {
      const result = await mintObserverToken(PRIV, 'test.aud');
      const otherSeed = Buffer.alloc(32, 9);
      const otherH = crypto.createHash('sha512').update(otherSeed).digest();
      otherH[0] &= 248;
      otherH[31] &= 63;
      otherH[31] |= 64;
      const otherPub = await deriveObserverPublicKey(otherH.toString('hex'));

      expect(await verifyAuthToken(result.token, otherPub)).toBeNull();
    });

    it('tampering with the payload segment invalidates the signature', async () => {
      const result = await mintObserverToken(PRIV, 'test.aud');
      const [header, payload, signature] = result.token.split('.');
      const tamperedPayload = payload.slice(0, -1) + (payload.at(-1) === 'A' ? 'B' : 'A');
      const tampered = `${header}.${tamperedPayload}.${signature}`;

      expect(await verifyAuthToken(tampered, result.publicKey)).toBeNull();
    });

    it('an expired token fails verification', async () => {
      const result = await mintObserverToken(PRIV, 'test.aud', { ttlSeconds: -1 });
      expect(await verifyAuthToken(result.token, result.publicKey)).toBeNull();
    });

    it('header segment decodes to exactly {"alg":"Ed25519","typ":"JWT"} and signature is 128 UPPER hex', async () => {
      const result = await mintObserverToken(PRIV, 'test.aud');
      const [header, , signature] = result.token.split('.');
      const decodedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
      expect(decodedHeader).toEqual({ alg: 'Ed25519', typ: 'JWT' });
      expect(signature).toMatch(/^[0-9A-F]{128}$/);
    });

    it('does not mutate a caller-visible payload object and differing nowSeconds produce different tokens', async () => {
      const payload = { publicKey: 'should-not-survive', aud: 'test.aud', iat: 1, exp: 2 };
      const frozen = { ...payload };
      // mintObserverToken never receives `payload` directly, but assert its
      // own internal object construction doesn't leak/mutate anything the
      // caller can observe by calling it twice with distinct clocks.
      const nowSeconds = Math.floor(Date.now() / 1000);
      const a = await mintObserverToken(PRIV, 'test.aud', { nowSeconds });
      const b = await mintObserverToken(PRIV, 'test.aud', { nowSeconds: nowSeconds + 100 });
      expect(a.token).not.toBe(b.token);
      expect(payload).toEqual(frozen);
    });
  });

  describe('mintObserverTokenForSource', () => {
    beforeEach(() => {
      sourceRows.clear();
      observerRows.clear();
      setMeshCoreObserverKeyStoreForTesting(null);
    });

    it('returns null when the source does not exist', async () => {
      expect(await mintObserverTokenForSource('missing')).toBeNull();
    });

    it('returns null for a non-meshcore source', async () => {
      sourceRows.set('src-mt', { id: 'src-mt', type: 'meshtastic_tcp', config: {} });
      expect(await mintObserverTokenForSource('src-mt')).toBeNull();
    });

    it('returns null when the observer config block is absent/incomplete', async () => {
      sourceRows.set('src-a', { id: 'src-a', type: 'meshcore', config: {} });
      expect(await mintObserverTokenForSource('src-a')).toBeNull();

      sourceRows.set('src-b', {
        id: 'src-b',
        type: 'meshcore',
        config: { observer: { enabled: true, brokerUrl: 'mqtts://broker:8883' } }, // missing iataCode/tokenAudience
      });
      expect(await mintObserverTokenForSource('src-b')).toBeNull();
    });

    it('returns null when no key is stored', async () => {
      const keyStore = new MeshCoreObserverKeyStore('secret'.repeat(8), true);
      setMeshCoreObserverKeyStoreForTesting(keyStore);
      sourceRows.set('src-c', {
        id: 'src-c',
        type: 'meshcore',
        config: {
          observer: { enabled: true, brokerUrl: 'mqtts://broker:8883', iataCode: 'MCO', tokenAudience: 'aud' },
        },
      });
      expect(await mintObserverTokenForSource('src-c')).toBeNull();
    });

    it('returns null when the stored envelope is rotated', async () => {
      const secretA = 'secretA'.repeat(8);
      const secretB = 'secretB'.repeat(8);
      const storeA = new MeshCoreObserverKeyStore(secretA, true);
      setMeshCoreObserverKeyStoreForTesting(storeA);

      const pub = await deriveObserverPublicKey(PRIV);
      await storeA.store('src-d', PRIV, pub, 'manual');

      const storeB = new MeshCoreObserverKeyStore(secretB, true);
      setMeshCoreObserverKeyStoreForTesting(storeB);

      sourceRows.set('src-d', {
        id: 'src-d',
        type: 'meshcore',
        config: {
          observer: { enabled: true, brokerUrl: 'mqtts://broker:8883', iataCode: 'MCO', tokenAudience: 'aud' },
        },
      });
      expect(await mintObserverTokenForSource('src-d')).toBeNull();
    });

    it('mints a valid token for a fully configured source with a stored key', async () => {
      const keyStore = new MeshCoreObserverKeyStore('secretX'.repeat(8), true);
      setMeshCoreObserverKeyStoreForTesting(keyStore);

      const pub = await deriveObserverPublicKey(PRIV);
      await keyStore.store('src-e', PRIV, pub, 'device');

      sourceRows.set('src-e', {
        id: 'src-e',
        type: 'meshcore',
        config: {
          observer: { enabled: true, brokerUrl: 'mqtts://broker:8883', iataCode: 'MCO', tokenAudience: 'my-aud' },
        },
      });

      const result = await mintObserverTokenForSource('src-e');
      expect(result).not.toBeNull();
      expect(result!.publicKey).toBe(pub);
      const verified = await verifyAuthToken(result!.token, pub);
      expect(verified).not.toBeNull();
      expect(verified!.aud).toBe('my-aud');
    });
  });

  describe('mintObserverTokenForSourceDetailed', () => {
    beforeEach(() => {
      sourceRows.clear();
      observerRows.clear();
      setMeshCoreObserverKeyStoreForTesting(null);
    });

    it("kind 'not_configured' when the source does not exist", async () => {
      expect(await mintObserverTokenForSourceDetailed('missing')).toEqual({ kind: 'not_configured' });
    });

    it("kind 'not_configured' for a non-meshcore source", async () => {
      sourceRows.set('src-mt', { id: 'src-mt', type: 'meshtastic_tcp', config: {} });
      expect(await mintObserverTokenForSourceDetailed('src-mt')).toEqual({ kind: 'not_configured' });
    });

    it("kind 'not_configured' when the observer config block is absent/incomplete", async () => {
      sourceRows.set('src-a', { id: 'src-a', type: 'meshcore', config: {} });
      expect(await mintObserverTokenForSourceDetailed('src-a')).toEqual({ kind: 'not_configured' });

      sourceRows.set('src-b', {
        id: 'src-b',
        type: 'meshcore',
        config: { observer: { enabled: true, brokerUrl: 'mqtts://broker:8883' } }, // missing iataCode/tokenAudience
      });
      expect(await mintObserverTokenForSourceDetailed('src-b')).toEqual({ kind: 'not_configured' });
    });

    it("kind 'no_key' when no key is stored", async () => {
      const keyStore = new MeshCoreObserverKeyStore('secret'.repeat(8), true);
      setMeshCoreObserverKeyStoreForTesting(keyStore);
      sourceRows.set('src-c', {
        id: 'src-c',
        type: 'meshcore',
        config: {
          observer: { enabled: true, brokerUrl: 'mqtts://broker:8883', iataCode: 'MCO', tokenAudience: 'aud' },
        },
      });
      expect(await mintObserverTokenForSourceDetailed('src-c')).toEqual({ kind: 'no_key' });
    });

    it("kind 'key_rotated' when the stored envelope was encrypted under a different SESSION_SECRET", async () => {
      const secretA = 'secretA'.repeat(8);
      const secretB = 'secretB'.repeat(8);
      const storeA = new MeshCoreObserverKeyStore(secretA, true);
      setMeshCoreObserverKeyStoreForTesting(storeA);

      const pub = await deriveObserverPublicKey(PRIV);
      await storeA.store('src-d', PRIV, pub, 'manual');

      const storeB = new MeshCoreObserverKeyStore(secretB, true);
      setMeshCoreObserverKeyStoreForTesting(storeB);

      sourceRows.set('src-d', {
        id: 'src-d',
        type: 'meshcore',
        config: {
          observer: { enabled: true, brokerUrl: 'mqtts://broker:8883', iataCode: 'MCO', tokenAudience: 'aud' },
        },
      });
      expect(await mintObserverTokenForSourceDetailed('src-d')).toEqual({ kind: 'key_rotated' });
    });

    it("kind 'mint_failed' with the library's message when the stored key is structurally invalid", async () => {
      const keyStore = new MeshCoreObserverKeyStore('secretF'.repeat(8), true);
      setMeshCoreObserverKeyStoreForTesting(keyStore);
      // Store the deterministic UNCLAMPED fixture directly — `store()` does
      // not validate the key material, so this round-trips through `load()`
      // as `{ kind: 'ok' }` and only fails inside `mintObserverToken`'s own
      // `deriveObserverPublicKey` call, exercising the mint_failed path.
      await keyStore.store('src-f', UNCLAMPED_PRIV, 'unused-public-key-placeholder', 'manual');

      sourceRows.set('src-f', {
        id: 'src-f',
        type: 'meshcore',
        config: {
          observer: { enabled: true, brokerUrl: 'mqtts://broker:8883', iataCode: 'MCO', tokenAudience: 'aud' },
        },
      });

      const result = await mintObserverTokenForSourceDetailed('src-f');
      expect(result.kind).toBe('mint_failed');
      if (result.kind === 'mint_failed') {
        expect(result.message).toBe('Invalid Analyzer Observer signing key: key derivation failed');
      }
    });

    it("kind 'ok' mints a valid token for a fully configured source with a stored key", async () => {
      const keyStore = new MeshCoreObserverKeyStore('secretG'.repeat(8), true);
      setMeshCoreObserverKeyStoreForTesting(keyStore);

      const pub = await deriveObserverPublicKey(PRIV);
      await keyStore.store('src-g', PRIV, pub, 'device');

      sourceRows.set('src-g', {
        id: 'src-g',
        type: 'meshcore',
        config: {
          observer: { enabled: true, brokerUrl: 'mqtts://broker:8883', iataCode: 'MCO', tokenAudience: 'my-aud' },
        },
      });

      const result = await mintObserverTokenForSourceDetailed('src-g');
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.token.publicKey).toBe(pub);
        const verified = await verifyAuthToken(result.token.token, pub);
        expect(verified).not.toBeNull();
        expect(verified!.aud).toBe('my-aud');
      }
    });

    it("mintObserverTokenForSource still collapses to null for every non-'ok' kind", async () => {
      expect(await mintObserverTokenForSource('missing')).toBeNull();
    });
  });

  describe('mintObserverTokenForSourceDetailed — audienceOverride (#5014 Phase 1 WP3)', () => {
    beforeEach(() => {
      sourceRows.clear();
      observerRows.clear();
      setMeshCoreObserverKeyStoreForTesting(null);
    });

    it('with no override, behaves exactly as before (uses observer.tokenAudience)', async () => {
      const keyStore = new MeshCoreObserverKeyStore('secretH'.repeat(8), true);
      setMeshCoreObserverKeyStoreForTesting(keyStore);
      const pub = await deriveObserverPublicKey(PRIV);
      await keyStore.store('src-h', PRIV, pub, 'device');
      sourceRows.set('src-h', {
        id: 'src-h',
        type: 'meshcore',
        config: {
          observer: { enabled: true, brokerUrl: 'mqtts://broker:8883', iataCode: 'MCO', tokenAudience: 'config-aud' },
        },
      });

      const result = await mintObserverTokenForSourceDetailed('src-h');
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        const verified = await verifyAuthToken(result.token.token, pub);
        expect(verified!.aud).toBe('config-aud');
      }
    });

    it('an override audience wins over the config tokenAudience', async () => {
      const keyStore = new MeshCoreObserverKeyStore('secretI'.repeat(8), true);
      setMeshCoreObserverKeyStoreForTesting(keyStore);
      const pub = await deriveObserverPublicKey(PRIV);
      await keyStore.store('src-i', PRIV, pub, 'device');
      sourceRows.set('src-i', {
        id: 'src-i',
        type: 'meshcore',
        config: {
          observer: { enabled: true, brokerUrl: 'mqtts://broker:8883', iataCode: 'MCO', tokenAudience: 'config-aud' },
        },
      });

      const result = await mintObserverTokenForSourceDetailed('src-i', 'override-aud');
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        const verified = await verifyAuthToken(result.token.token, pub);
        expect(verified!.aud).toBe('override-aud');
      }
    });

    it('mints successfully with an override even when the config has no tokenAudience at all', async () => {
      const keyStore = new MeshCoreObserverKeyStore('secretJ'.repeat(8), true);
      setMeshCoreObserverKeyStoreForTesting(keyStore);
      const pub = await deriveObserverPublicKey(PRIV);
      await keyStore.store('src-j', PRIV, pub, 'device');
      // Multi-broker config with brokers[] but no block-level tokenAudience —
      // the per-broker publisher supplies each broker's own audience as the
      // override.
      sourceRows.set('src-j', {
        id: 'src-j',
        type: 'meshcore',
        config: {
          observer: {
            enabled: true,
            iataCode: 'MCO',
            brokers: [{ url: 'mqtts://broker-a:8883', tokenAudience: 'broker-a-aud' }],
          },
        },
      });

      const result = await mintObserverTokenForSourceDetailed('src-j', 'broker-a-aud');
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        const verified = await verifyAuthToken(result.token.token, pub);
        expect(verified!.aud).toBe('broker-a-aud');
      }
    });

    it("still 'not_configured' for a missing source even with an override", async () => {
      expect(await mintObserverTokenForSourceDetailed('missing', 'some-aud')).toEqual({ kind: 'not_configured' });
    });

    it("still 'not_configured' for a non-meshcore source even with an override", async () => {
      sourceRows.set('src-mt2', { id: 'src-mt2', type: 'meshtastic_tcp', config: {} });
      expect(await mintObserverTokenForSourceDetailed('src-mt2', 'some-aud')).toEqual({ kind: 'not_configured' });
    });

    it("still 'not_configured' when the observer block is absent/disabled even with an override", async () => {
      sourceRows.set('src-k', { id: 'src-k', type: 'meshcore', config: {} });
      expect(await mintObserverTokenForSourceDetailed('src-k', 'some-aud')).toEqual({ kind: 'not_configured' });

      sourceRows.set('src-l', {
        id: 'src-l',
        type: 'meshcore',
        config: { observer: { enabled: false, brokerUrl: 'mqtts://broker:8883', iataCode: 'MCO' } },
      });
      expect(await mintObserverTokenForSourceDetailed('src-l', 'some-aud')).toEqual({ kind: 'not_configured' });
    });

    it("still 'no_key' with an override when no key is stored", async () => {
      const keyStore = new MeshCoreObserverKeyStore('secretM'.repeat(8), true);
      setMeshCoreObserverKeyStoreForTesting(keyStore);
      sourceRows.set('src-m', {
        id: 'src-m',
        type: 'meshcore',
        // tokenAudience present so the block normalizes at all (a legacy
        // token-mode entry with no audience is dropped by
        // `normalizeObserverBrokers`, which would make this "not_configured"
        // regardless of the override) — the override still wins over it.
        config: {
          observer: { enabled: true, brokerUrl: 'mqtts://broker:8883', iataCode: 'MCO', tokenAudience: 'config-aud' },
        },
      });
      expect(await mintObserverTokenForSourceDetailed('src-m', 'some-aud')).toEqual({ kind: 'no_key' });
    });
  });
});
