import { describe, it, expect } from 'vitest';
import {
  validateMqttRoot,
  sanitizeSegment,
  trimToBytes,
  rootFromTopic,
  gatewayFromTopic,
  utf8ByteLength,
} from './mqttRootTopic.js';

const code = (s: string) => {
  const r = validateMqttRoot(s);
  return r.ok ? 'ok' : r.code;
};

describe('validateMqttRoot', () => {
  it('accepts normal roots and the empty default', () => {
    expect(code('msh/US')).toBe('ok');
    expect(code('msh/US/WA')).toBe('ok');
    expect(code('')).toBe('ok');
  });
  it('rejects whitespace', () => {
    expect(code('msh /US')).toBe('WHITESPACE');
    expect(code('msh/US\t')).toBe('WHITESPACE');
    expect(code('msh/ US')).toBe('WHITESPACE');
  });
  it('rejects control characters', () => {
    expect(code('msh/\u0001US')).toBe('CONTROL');
    expect(code('msh/\u0000')).toBe('CONTROL');
  });
  it('rejects invisible characters (ZWSP, ZWJ, BOM)', () => {
    expect(code('msh/U​S')).toBe('INVISIBLE');
    expect(code('msh/U‍S')).toBe('INVISIBLE');
    expect(code('﻿msh/US')).toBe('INVISIBLE');
  });
  it('rejects wildcards', () => {
    expect(code('msh/+')).toBe('WILDCARD');
    expect(code('msh/#')).toBe('WILDCARD');
  });
  it('rejects leading, trailing and doubled slashes', () => {
    expect(code('msh//US')).toBe('SLASH');
    expect(code('/msh')).toBe('SLASH');
    expect(code('msh/US/')).toBe('SLASH');
  });
  it('rejects a root ending in /2', () => {
    expect(code('msh/US/2')).toBe('ENDS_WITH_2');
    expect(code('msh/US/22')).toBe('ok');
  });
  it('enforces 31 bytes, not 31 characters', () => {
    const ok31 = 'a'.repeat(31);
    expect(code(ok31)).toBe('ok');
    expect(code(ok31 + 'a')).toBe('TOO_LONG');
    // æøå are 2 bytes each: 15 chars = 30 bytes, 16 chars = 32 bytes
    expect(utf8ByteLength('æøå')).toBe(6);
    expect(code('æøåæøåæøåæøåæøå')).toBe('ok'); // 30 bytes
    expect(code('æøåæøåæøåæøåæøåæ')).toBe('TOO_LONG'); // 32 bytes
  });
  it('allows non-ASCII letters', () => {
    expect(code('msh/JP/東京都')).toBe('ok'); // 7 + 9 bytes
    expect(code('msh/NO/æøå')).toBe('ok');
  });
});

describe('sanitizeSegment', () => {
  it('keeps letters and digits in any script and drops the rest', () => {
    expect(sanitizeSegment('New York!')).toBe('NewYork');
    expect(sanitizeSegment('東京都')).toBe('東京都');
    expect(sanitizeSegment("São-Paulo 2")).toBe('SãoPaulo2');
  });
  it('NFC-composes', () => {
    const decomposed = 'é'; // e + combining acute
    const out = sanitizeSegment(decomposed);
    expect(out).toBe('é');
    expect(out.length).toBe(1);
  });
});

describe('trimToBytes', () => {
  it('leaves short strings alone', () => {
    expect(trimToBytes('msh/US', 31)).toBe('msh/US');
  });
  it('never splits a code point', () => {
    const s = '東京都東京都東京都東京都'; // 3 bytes each
    const out = trimToBytes(s, 31);
    expect(utf8ByteLength(out)).toBeLessThanOrEqual(31);
    expect(out).toBe('東京都東京都東京都東京都'.slice(0, 10)); // 30 bytes
    expect(s.startsWith(out)).toBe(true);
    // Astral char (4 bytes) must not be cut in half.
    const astral = 'a'.repeat(29) + '\u{1F600}';
    expect(trimToBytes(astral, 31)).toBe('a'.repeat(29));
  });
});

describe('rootFromTopic', () => {
  it('strips the encrypted-stream tail', () => {
    expect(rootFromTopic('msh/US/2/e/LongFast/!abcd1234')).toBe('msh/US');
    expect(rootFromTopic('msh/US/WA/Seattle/2/e/MediumFast/!deadbeef')).toBe('msh/US/WA/Seattle');
  });
  it('strips the map tail', () => {
    expect(rootFromTopic('msh/US/2/map/')).toBe('msh/US');
    expect(rootFromTopic('msh/US/2/map')).toBe('msh/US');
  });
  it('returns null for anything else', () => {
    expect(rootFromTopic('msh/US/2/json/LongFast/!abcd1234')).toBeNull();
    expect(rootFromTopic('msh/US')).toBeNull();
    expect(rootFromTopic('/2/map/')).toBeNull();
    expect(rootFromTopic('')).toBeNull();
  });
});

describe('gatewayFromTopic', () => {
  it('reads the gateway segment', () => {
    expect(gatewayFromTopic('msh/US/2/e/LongFast/!abcd1234')).toBe('!abcd1234');
    expect(gatewayFromTopic('msh/US/2/map/')).toBeNull();
  });
});
