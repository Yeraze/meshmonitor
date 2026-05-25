/**
 * Tests for the channel-URL import helpers. Covers the shorthand forms
 * (`default`, `simple1..9`) that `channelUrlService.decodeUrl` returns,
 * plus real-key passthrough and the no-crypto / malformed skip cases.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeChannelUrlPskToBase64,
  getPskBase64ByteLength,
} from './channelUrl';

describe('normalizeChannelUrlPskToBase64', () => {
  it("returns 'AQ==' for the 'default' shorthand", () => {
    // This matches the MQTT default-channel bootstrap row exactly.
    expect(normalizeChannelUrlPskToBase64('default')).toBe('AQ==');
  });

  it('maps simpleN to a 1-byte base64 of (N+1)', () => {
    // simple1 → byte 0x02 → base64 'Ag=='
    expect(normalizeChannelUrlPskToBase64('simple1')).toBe('Ag==');
    // simple9 → byte 0x0a → base64 'Cg=='
    expect(normalizeChannelUrlPskToBase64('simple9')).toBe('Cg==');
  });

  it('returns null for the no-crypto / empty forms', () => {
    expect(normalizeChannelUrlPskToBase64('none')).toBeNull();
    expect(normalizeChannelUrlPskToBase64('')).toBeNull();
    expect(normalizeChannelUrlPskToBase64(undefined)).toBeNull();
    expect(normalizeChannelUrlPskToBase64(null)).toBeNull();
  });

  it('passes a real 16-byte base64 key through unchanged', () => {
    // 16 raw bytes of 0xAB.
    const sixteenAB = Buffer.alloc(16, 0xab).toString('base64');
    expect(normalizeChannelUrlPskToBase64(sixteenAB)).toBe(sixteenAB);
  });

  it('passes a real 32-byte base64 key through unchanged', () => {
    const thirtyTwoCD = Buffer.alloc(32, 0xcd).toString('base64');
    expect(normalizeChannelUrlPskToBase64(thirtyTwoCD)).toBe(thirtyTwoCD);
  });

  it('returns null on a string that decodes to zero bytes', () => {
    // Pathological but possible — base64 of empty buffer is ''.
    expect(normalizeChannelUrlPskToBase64('')).toBeNull();
  });
});

describe('getPskBase64ByteLength', () => {
  it('reports 1 byte for the default-key shorthand', () => {
    expect(getPskBase64ByteLength('AQ==')).toBe(1);
  });

  it('reports 16 bytes for a typical AES-128 key', () => {
    const sixteen = Buffer.alloc(16, 0xab).toString('base64');
    expect(getPskBase64ByteLength(sixteen)).toBe(16);
  });

  it('reports 32 bytes for a typical AES-256 key', () => {
    const thirtyTwo = Buffer.alloc(32, 0xcd).toString('base64');
    expect(getPskBase64ByteLength(thirtyTwo)).toBe(32);
  });

  it('returns 0 for null / undefined / empty inputs', () => {
    expect(getPskBase64ByteLength(null)).toBe(0);
    expect(getPskBase64ByteLength(undefined)).toBe(0);
    expect(getPskBase64ByteLength('')).toBe(0);
  });
});
