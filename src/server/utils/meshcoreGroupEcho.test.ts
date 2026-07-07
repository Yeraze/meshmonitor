/**
 * Unit tests for the MeshCore GRP_TXT self-echo crypto (#3979).
 *
 * These exercise the decrypt path end-to-end against fixtures built with the
 * real inverse (`encodeGroupTextPayload`), so the AES-128-ECB / HMAC / channel-
 * hash logic is validated as a matched pair. Defensive behaviour (wrong
 * channel, MAC tamper, garbage) must return null and never throw.
 */
import { describe, it, expect } from 'vitest';
import {
  deriveMeshCoreChannelHash,
  encodeGroupTextPayload,
  tryDecodeGroupTextPayload,
} from './meshcoreGroupEcho.js';

/** Deterministic 16-byte AES-128 channel secret. */
function secretBytes(seed = 0): Uint8Array {
  const s = new Uint8Array(16);
  for (let i = 0; i < 16; i++) s[i] = (seed + i * 7) & 0xff;
  return s;
}

describe('meshcoreGroupEcho crypto', () => {
  it('round-trips sender + text through encode → decode', () => {
    const secret = secretBytes(3);
    const payloadHex = encodeGroupTextPayload(secret, 'MyNode', 'hello world', 1_700_000_000);
    const decoded = tryDecodeGroupTextPayload(payloadHex, secret);
    expect(decoded).not.toBeNull();
    expect(decoded!.body).toBe('MyNode: hello world');
    expect(decoded!.timestamp).toBe(1_700_000_000);
  });

  it('preserves leading/trailing whitespace in the text exactly', () => {
    const secret = secretBytes(9);
    const text = '  spaced out  ';
    const payloadHex = encodeGroupTextPayload(secret, 'N', text);
    const decoded = tryDecodeGroupTextPayload(payloadHex, secret);
    // Body is "<name>: <text>"; slicing off "N: " must return the exact text.
    expect(decoded!.body).toBe(`N: ${text}`);
    expect(decoded!.body.slice('N: '.length)).toBe(text);
  });

  it('handles a text whose buffer length is an exact multiple of 16 (no padding NUL)', () => {
    const secret = secretBytes(1);
    // header(5) + "N: " (3) => 8; add 8 chars => 16 exactly.
    const payloadHex = encodeGroupTextPayload(secret, 'N', '12345678');
    const decoded = tryDecodeGroupTextPayload(payloadHex, secret);
    expect(decoded!.body).toBe('N: 12345678');
  });

  it('channel hash matches SHA-256(secret)[0]', () => {
    const secret = secretBytes(5);
    const payloadHex = encodeGroupTextPayload(secret, 'A', 'x');
    const firstByte = parseInt(payloadHex.slice(0, 2), 16);
    expect(firstByte).toBe(deriveMeshCoreChannelHash(secret));
  });

  it('returns null for the WRONG channel secret (channel-hash / MAC reject)', () => {
    const secret = secretBytes(2);
    const other = secretBytes(42);
    const payloadHex = encodeGroupTextPayload(secret, 'MyNode', 'hi', 1);
    expect(tryDecodeGroupTextPayload(payloadHex, other)).toBeNull();
  });

  it('returns null when the MAC is tampered (same channel hash, bad MAC)', () => {
    const secret = secretBytes(7);
    const payloadHex = encodeGroupTextPayload(secret, 'MyNode', 'hi', 1);
    // Flip a MAC byte (bytes 1-2), leaving the channel hash (byte 0) intact.
    const bytes = Buffer.from(payloadHex, 'hex');
    bytes[1] ^= 0xff;
    expect(tryDecodeGroupTextPayload(bytes.toString('hex'), secret)).toBeNull();
  });

  it('returns null (never throws) for garbage / truncated payloads', () => {
    const secret = secretBytes(0);
    expect(tryDecodeGroupTextPayload('', secret)).toBeNull();
    expect(tryDecodeGroupTextPayload('00', secret)).toBeNull();
    expect(tryDecodeGroupTextPayload('deadbeef', secret)).toBeNull();
    // A payload with correct length but random bytes must not throw.
    expect(tryDecodeGroupTextPayload('ab'.repeat(19), secret)).toBeNull();
  });

  it('returns null for a too-short secret', () => {
    const payloadHex = encodeGroupTextPayload(secretBytes(0), 'A', 'x');
    expect(tryDecodeGroupTextPayload(payloadHex, new Uint8Array(8))).toBeNull();
  });
});
