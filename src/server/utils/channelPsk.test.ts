import { describe, it, expect } from 'vitest';
import { channelPskToBytes, channelPskToStoredBase64 } from './channelPsk.js';

describe('channelPsk (#5183)', () => {
  it('translates shorthand to the firmware key bytes', () => {
    expect([...channelPskToBytes('none')]).toEqual([0]);
    expect([...channelPskToBytes('default')]).toEqual([1]);
    expect([...channelPskToBytes('simple0')]).toEqual([1]);
    expect([...channelPskToBytes('simple5')]).toEqual([6]);
  });

  it('passes a base64 key through as its bytes', () => {
    const key = Buffer.alloc(32, 7);
    expect(channelPskToBytes(key.toString('base64')).equals(key)).toBe(true);
  });

  it('rejects a malformed simple shorthand instead of silently disabling encryption', () => {
    for (const bad of ['simple', 'simplex', 'simple-1', 'simple255']) {
      expect(() => channelPskToBytes(bad)).toThrow(/simple0 to simple254/);
    }
  });

  it('stores the same base64 the device sync would', () => {
    expect(channelPskToStoredBase64('default')).toBe('AQ==');
    expect(channelPskToStoredBase64('')).toBeUndefined();
  });
});
