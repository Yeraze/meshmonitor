import { describe, it, expect } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { derivePublicKeyFromPrivateHex } from './meshcoreKeyDerive.js';

/**
 * orlp/ed25519 (used by MeshCore firmware) builds its 64-byte private key as
 * SHA-512(seed) with the low half clamped — so bytes 0-31 ARE the scalar, not
 * the seed. Rebuild that format from a seed and check the derived public key
 * matches the RFC 8032 public key for the same seed.
 */
function orlpPrivateFromSeed(seed: Buffer): Buffer {
  const h = createHash('sha512').update(seed).digest();
  h[0] &= 248;
  h[31] &= 63;
  h[31] |= 64;
  return h;
}

describe('derivePublicKeyFromPrivateHex', () => {
  it('matches the RFC 8032 public key for orlp-format private keys', () => {
    for (let i = 0; i < 5; i++) {
      const seed = randomBytes(32);
      const priv = orlpPrivateFromSeed(seed).toString('hex');
      const expected = Buffer.from(ed25519.getPublicKey(seed)).toString('hex');
      expect(derivePublicKeyFromPrivateHex(priv)).toBe(expected);
    }
  });

  it('returns null on malformed input', () => {
    expect(derivePublicKeyFromPrivateHex('zz')).toBeNull();
    expect(derivePublicKeyFromPrivateHex('00'.repeat(64))).toBeNull();
  });
});
