import { describe, it, expect } from 'vitest';
import {
  isValidMeshtasticKey,
  normalizeMeshtasticKey,
  MESHTASTIC_KEY_BYTES,
} from './meshtasticKeyFormat.js';

/** base64 of N zero bytes — valid base64, controllable length. */
const b64 = (n: number) => btoa(String.fromCharCode(...new Array(n).fill(0)));

describe('isValidMeshtasticKey (shared client/server)', () => {
  it('accepts base64 of exactly 32 bytes', () => {
    expect(isValidMeshtasticKey(b64(MESHTASTIC_KEY_BYTES))).toBe(true);
  });

  it('accepts a base64: prefix', () => {
    expect(isValidMeshtasticKey(`base64:${b64(32)}`)).toBe(true);
  });

  it('rejects the wrong length', () => {
    expect(isValidMeshtasticKey(b64(16))).toBe(false);
    expect(isValidMeshtasticKey(b64(64))).toBe(false);
  });

  it('rejects hex, empty, whitespace and garbage', () => {
    expect(isValidMeshtasticKey('a'.repeat(64))).toBe(false); // hex-looking, no '='
    expect(isValidMeshtasticKey('')).toBe(false);
    expect(isValidMeshtasticKey('   ')).toBe(false);
    expect(isValidMeshtasticKey('not base 64 !!')).toBe(false);
    expect(isValidMeshtasticKey(null as unknown as string)).toBe(false);
  });
});

describe('normalizeMeshtasticKey', () => {
  it('strips a base64: prefix and surrounding whitespace', () => {
    const key = b64(32);
    expect(normalizeMeshtasticKey(`  base64:${key}  `)).toBe(key);
  });
  it('leaves a bare key unchanged', () => {
    const key = b64(32);
    expect(normalizeMeshtasticKey(key)).toBe(key);
  });
  it('returns an empty string for non-strings', () => {
    expect(normalizeMeshtasticKey(undefined as unknown as string)).toBe('');
  });
});
