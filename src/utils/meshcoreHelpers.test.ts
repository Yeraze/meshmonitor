import { describe, it, expect, vi } from 'vitest';
import {
  deriveHashtagSecretHex,
  formatMeshCoreChannelName,
  isHashtagChannelName,
  sha256PureJS,
} from './meshcoreHelpers';

describe('isHashtagChannelName', () => {
  it('is true for names starting with #', () => {
    expect(isHashtagChannelName('#general')).toBe(true);
    expect(isHashtagChannelName('  #test')).toBe(true); // leading whitespace trimmed
  });

  it('is false for plain names and empty/nullish input', () => {
    expect(isHashtagChannelName('Public')).toBe(false);
    expect(isHashtagChannelName('')).toBe(false);
    expect(isHashtagChannelName(null)).toBe(false);
    expect(isHashtagChannelName(undefined)).toBe(false);
  });
});

describe('formatMeshCoreChannelName', () => {
  it('keeps the leading # for hashtag channels (no double #)', () => {
    expect(formatMeshCoreChannelName('#general', 'Channel 0')).toBe('#general');
  });

  it('decoratively prepends "# " for plain names', () => {
    expect(formatMeshCoreChannelName('Public', 'Channel 0')).toBe('# Public');
  });

  it('falls back to the supplied label for empty names', () => {
    expect(formatMeshCoreChannelName('', 'Channel 5')).toBe('# Channel 5');
    expect(formatMeshCoreChannelName(null, 'Channel 5')).toBe('# Channel 5');
  });
});

describe('deriveHashtagSecretHex', () => {
  // Authoritative MeshCore value: SHA-256("#test")[0:16].
  it('matches the well-known MeshCore #test derivation', async () => {
    await expect(deriveHashtagSecretHex('#test')).resolves.toBe('9cd8fcf22a47333b591d96a2b848b73f');
  });

  it('hashes the literal "#" prefix — adds it when missing', async () => {
    // "test" and "#test" must yield the same key (the # is always hashed).
    await expect(deriveHashtagSecretHex('test')).resolves.toBe('9cd8fcf22a47333b591d96a2b848b73f');
  });

  it('is case-sensitive', async () => {
    const lower = await deriveHashtagSecretHex('#general');
    const upper = await deriveHashtagSecretHex('#General');
    expect(lower).not.toBe(upper);
  });

  it('returns a 32-char (16-byte) lowercase hex string', async () => {
    const hex = await deriveHashtagSecretHex('#general');
    expect(hex).toMatch(/^[0-9a-f]{32}$/);
  });
});

// Regression: crypto.subtle is undefined in non-secure HTTP contexts (plain HTTP
// over IP). The pure-JS fallback must produce the same key as crypto.subtle.
// See issue #3606.
describe('deriveHashtagSecretHex — pure-JS fallback (non-secure context)', () => {
  it('sha256PureJS matches the authoritative #test vector', () => {
    const encoded = new TextEncoder().encode('#test');
    const result = sha256PureJS(encoded);
    const hex = Array.from(result.slice(0, 16))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    expect(hex).toBe('9cd8fcf22a47333b591d96a2b848b73f');
  });

  it('sha256PureJS matches the authoritative #general vector', () => {
    const encoded = new TextEncoder().encode('#general');
    const result = sha256PureJS(encoded);
    const hex = Array.from(result.slice(0, 16))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    // Verify against the known base64 from the component test: TEnz8kYp9e5K1bOWXbR5hQ==
    // = 0x4c49f3f24629f5ee4ad5b3965db47985
    expect(hex).toBe('4c49f3f24629f5ee4ad5b3965db47985');
  });

  it('deriveHashtagSecretHex falls back to pure-JS when crypto.subtle is unavailable', async () => {
    const originalSubtle = crypto.subtle;
    try {
      // Simulate a non-secure context where crypto.subtle is undefined
      Object.defineProperty(crypto, 'subtle', { value: undefined, configurable: true });
      await expect(deriveHashtagSecretHex('#test')).resolves.toBe('9cd8fcf22a47333b591d96a2b848b73f');
    } finally {
      Object.defineProperty(crypto, 'subtle', { value: originalSubtle, configurable: true });
    }
  });
});
