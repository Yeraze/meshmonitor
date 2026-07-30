import { describe, it, expect, vi } from 'vitest';
import {
  deriveHashtagSecretHex,
  formatMeshCoreChannelName,
  isHashtagChannelName,
  LOCAL_NODE_OFFSET,
  mapContactsToNodes,
  sha256PureJS,
  type MeshCoreContact,
} from './meshcoreHelpers';

describe('mapContactsToNodes (#4438 — isLocal flag, not the "(local)" naming convention)', () => {
  it('offsets the local node when isLocal is true', () => {
    const contacts: MeshCoreContact[] = [
      { publicKey: 'a'.repeat(64), advName: 'MyNode (local)', isLocal: true, latitude: 10, longitude: 20 },
    ];
    const [node] = mapContactsToNodes(contacts);
    expect(node.latitude).toBeCloseTo(10 + LOCAL_NODE_OFFSET);
    expect(node.longitude).toBeCloseTo(20 + LOCAL_NODE_OFFSET);
  });

  it('T-C4 negative control: a non-local contact named "(local)" is NOT offset', () => {
    // A stranger whose device name happens to contain "(local)" must not be
    // treated as the local node — this is the exact bug #4438 exists to fix.
    // Before the fix, mapContactsToNodes matched on the advName substring
    // and this assertion failed.
    const contacts: MeshCoreContact[] = [
      { publicKey: 'b'.repeat(64), advName: 'Imposter (local)', isLocal: false, latitude: 10, longitude: 20 },
    ];
    const [node] = mapContactsToNodes(contacts);
    expect(node.latitude).toBe(10);
    expect(node.longitude).toBe(20);
  });

  it('does not offset a contact with no isLocal field at all', () => {
    const contacts: MeshCoreContact[] = [
      { publicKey: 'c'.repeat(64), advName: 'Plain Node', latitude: 5, longitude: 6 },
    ];
    const [node] = mapContactsToNodes(contacts);
    expect(node.latitude).toBe(5);
    expect(node.longitude).toBe(6);
  });

  it('filters out contacts with no coordinates', () => {
    const contacts: MeshCoreContact[] = [
      { publicKey: 'd'.repeat(64), advName: 'NoPosition' },
    ];
    expect(mapContactsToNodes(contacts)).toEqual([]);
  });
});

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
