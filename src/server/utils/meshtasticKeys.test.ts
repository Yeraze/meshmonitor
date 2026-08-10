import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { isValidMeshtasticKey, decodeKey, derivePublicKey } from './meshtasticKeys.js';

/** A real X25519 pair in raw-base64 form, the way Meshtastic stores them. */
function realPair(): { priv: string; pub: string } {
  const kp = generateKeyPairSync('x25519');
  const priv = kp.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = kp.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { priv: priv.toString('base64'), pub: pub.toString('base64') };
}

describe('isValidMeshtasticKey', () => {
  it('accepts base64 of exactly 32 bytes', () => {
    expect(isValidMeshtasticKey(realPair().priv)).toBe(true);
  });

  it('accepts a base64: prefix', () => {
    expect(isValidMeshtasticKey(`base64:${realPair().priv}`)).toBe(true);
  });

  it('rejects the wrong length', () => {
    // 16 bytes and 64 bytes, both valid base64, both wrong for a key.
    expect(isValidMeshtasticKey(Buffer.alloc(16).toString('base64'))).toBe(false);
    expect(isValidMeshtasticKey(Buffer.alloc(64).toString('base64'))).toBe(false);
  });

  it('rejects hex, empty, and garbage', () => {
    expect(isValidMeshtasticKey('a'.repeat(64))).toBe(false); // hex-looking, no '='
    expect(isValidMeshtasticKey('')).toBe(false);
    expect(isValidMeshtasticKey('   ')).toBe(false);
    expect(isValidMeshtasticKey('not base 64 !!')).toBe(false);
    expect(isValidMeshtasticKey(null as unknown as string)).toBe(false);
  });
});

describe('decodeKey', () => {
  it('returns the 32 raw bytes', () => {
    const buf = decodeKey(realPair().priv);
    expect(buf?.length).toBe(32);
  });
  it('returns null for an invalid key', () => {
    expect(decodeKey('short')).toBeNull();
  });
});

describe('derivePublicKey', () => {
  it('derives the public key that matches the private key', () => {
    const { priv, pub } = realPair();
    expect(derivePublicKey(priv)).toBe(pub);
  });

  it('is stable across calls', () => {
    const { priv } = realPair();
    expect(derivePublicKey(priv)).toBe(derivePublicKey(priv));
  });

  it('tolerates a base64: prefix on the private key', () => {
    const { priv, pub } = realPair();
    expect(derivePublicKey(`base64:${priv}`)).toBe(pub);
  });

  it('throws on an invalid private key rather than emitting a bogus pair', () => {
    expect(() => derivePublicKey('short')).toThrow(/Invalid private key/);
  });
});
