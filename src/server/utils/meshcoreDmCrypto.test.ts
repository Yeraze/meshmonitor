/**
 * Tests for the MeshCore DM self-echo crypto (#6195):
 *   - deriveMeshCoreDmSecret: the X25519 primitive it delegates to matches the
 *     RFC 7748 §5.2 test vector, and the full Ed25519→Curve25519 derivation
 *     commutes between two orlp-style keypairs (a valid ECDH).
 *   - tryDecodeDmTextPayload: round-trips against encodeDmTextPayload and
 *     returns null on MAC failure / malformed input, never throwing.
 *
 * HONESTY: we hold no captured real DM, so the payload decode is validated
 * against our own encoder (the documented encryptThenMAC scheme), not against
 * firmware output. See the module header in meshcoreDmCrypto.ts.
 */
import { describe, it, expect } from 'vitest';
import { x25519, ed25519 } from '@noble/curves/ed25519';
import { sha512 } from '@noble/hashes/sha2';
import crypto from 'node:crypto';
import {
  deriveMeshCoreDmSecret,
  tryDecodeDmTextPayload,
  encodeDmTextPayload,
} from './meshcoreDmCrypto.js';

const L = ed25519.CURVE.n;
function bytesToNumberLE(b: Uint8Array): bigint {
  let r = 0n;
  for (let i = b.length - 1; i >= 0; i--) r = (r << 8n) | BigInt(b[i]);
  return r;
}
/** Build an orlp-style Ed25519 keypair: sha512(seed) → clamp[0:32] = scalar,
 *  64-byte private = scalar||prefix, public = scalar·B. */
function orlpKeypair(seed: Buffer): { privHex: string; pubHex: string } {
  const h = Buffer.from(sha512(seed));
  h[0] &= 248;
  h[31] &= 127;
  h[31] |= 64;
  const scalar = h.subarray(0, 32);
  const priv64 = Buffer.concat([scalar, h.subarray(32, 64)]);
  // B has order L, so (scalar mod L)·B is the same point as scalar·B (noble's
  // edwards multiply requires an in-range scalar).
  const pub = ed25519.Point.BASE.multiply(bytesToNumberLE(scalar) % L).toBytes();
  return { privHex: priv64.toString('hex'), pubHex: Buffer.from(pub).toString('hex') };
}

describe('deriveMeshCoreDmSecret (Ed25519 → X25519 ECDH)', () => {
  it('delegates to an X25519 that matches the RFC 7748 §5.2 vector', () => {
    const scalar = Buffer.from('a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4', 'hex');
    const u = Buffer.from('e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c', 'hex');
    const expected = 'c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552';
    expect(Buffer.from(x25519.getSharedSecret(scalar, u)).toString('hex')).toBe(expected);
  });

  it('commutes between two orlp keypairs (A.derive(B.pub) === B.derive(A.pub))', () => {
    const A = orlpKeypair(crypto.randomBytes(32));
    const B = orlpKeypair(crypto.randomBytes(32));
    const sAB = deriveMeshCoreDmSecret(A.privHex, B.pubHex);
    const sBA = deriveMeshCoreDmSecret(B.privHex, A.pubHex);
    expect(sAB).not.toBeNull();
    expect(sBA).not.toBeNull();
    expect(sAB!.length).toBe(32);
    expect(sAB!.toString('hex')).toBe(sBA!.toString('hex'));
  });

  it('returns null on malformed inputs (never throws)', () => {
    const A = orlpKeypair(crypto.randomBytes(32));
    expect(deriveMeshCoreDmSecret('', A.pubHex)).toBeNull();
    expect(deriveMeshCoreDmSecret(A.privHex, 'zz')).toBeNull(); // too short pub
    expect(deriveMeshCoreDmSecret(A.privHex, '11'.repeat(16))).toBeNull(); // 16-byte pub
    // @ts-expect-error — defensive against non-string inputs
    expect(deriveMeshCoreDmSecret(null, A.pubHex)).toBeNull();
  });
});

describe('tryDecodeDmTextPayload', () => {
  const secret = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);

  it('round-trips an encoded DM payload to its timestamp and text', () => {
    const payload = encodeDmTextPayload(secret, 'hello mesh', 1_700_000_000);
    const decoded = tryDecodeDmTextPayload(payload, secret);
    expect(decoded).not.toBeNull();
    expect(decoded!.timestamp).toBe(1_700_000_000);
    expect(decoded!.text).toBe('hello mesh');
  });

  it('round-trips an empty-text payload', () => {
    const payload = encodeDmTextPayload(secret, '', 42);
    const decoded = tryDecodeDmTextPayload(payload, secret);
    expect(decoded).not.toBeNull();
    expect(decoded!.timestamp).toBe(42);
    expect(decoded!.text).toBe('');
  });

  it('returns null when decrypted with the WRONG secret (MAC fails)', () => {
    const payload = encodeDmTextPayload(secret, 'secret text', 99);
    const wrong = new Uint8Array(32).fill(0xab);
    expect(tryDecodeDmTextPayload(payload, wrong)).toBeNull();
  });

  it('returns null on malformed / short / empty input, never throwing', () => {
    expect(tryDecodeDmTextPayload(null, secret)).toBeNull();
    expect(tryDecodeDmTextPayload('', secret)).toBeNull();
    expect(tryDecodeDmTextPayload('deadbeef', secret)).toBeNull(); // shorter than MAC+1 block
    expect(tryDecodeDmTextPayload('zz'.repeat(20), secret)).toBeNull(); // junk
    expect(tryDecodeDmTextPayload(encodeDmTextPayload(secret, 'x', 1), new Uint8Array(8))).toBeNull(); // short secret
  });
});
