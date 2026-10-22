/**
 * The MeshCore Auto-Responder test box (#5808) must give the same answer as
 * the server. This compares the client copy against the server's own
 * `compileAutoAckRegex` (RE2, `i` flag, `regex.test`) on a spread of
 * patterns, including ones the server rejects.
 */
import { describe, it, expect } from 'vitest';
import { compileAutoAckRegex } from '../../server/utils/autoAckRegex';
import {
  compileMeshCoreResponderPattern,
  matchMeshCoreResponderPattern,
  meshCoreResponderPatternMatches,
  meshCoreTriggerSyntax,
  validateMeshCoreResponderPattern,
} from './meshcoreResponderMatch';

const PATTERNS = [
  '^ping', 'ping$', 'help', '^(test|ping)', 'weather\\s+\\w+', '[0-9]{5}', '^status$',
  // Unicode classes: RE2 reads them natively, the browser engine needs `u`
  '\\p{L}', '\\pL+', '^\\P{L}',
  // Any printable Unicode since #5924: emoji, ZWJ sequences, accents, CJK
  '🔋', '👋\\s*hi', '[🔋⚡]', '👨‍👩‍👧', 'café', '天気',
  // rejected by the server
  '', 'x'.repeat(101), '.*.*', 'a+b+', '(?=ping)', '(a)\\1', 'a{1000}', 'a{2,}', 'ping\u0007',
];
const MESSAGES = [
  'ping', 'PING please', 'say ping', 'I need HELP', 'weather Miami', 'zip 33076', 'status', 'STATUS now', '',
  'battery 🔋 low', 'oh 👋 HI', '⚡', '👨‍👩‍👧', 'CAFÉ', '今日の天気',
];

describe('meshcoreResponderMatch mirrors the server', () => {
  it.each(PATTERNS)('pattern %j: accepted by both or rejected by both', (pattern) => {
    expect(!!compileMeshCoreResponderPattern(pattern).regex).toBe(!!compileAutoAckRegex(pattern).regex);
  });

  it('matches the same messages as the server for every accepted pattern', () => {
    for (const pattern of PATTERNS) {
      const server = compileAutoAckRegex(pattern).regex;
      for (const text of MESSAGES) {
        expect(meshCoreResponderPatternMatches(pattern, text), `${pattern} vs ${text}`).toBe(!!server && server.test(text));
      }
    }
  });
});

describe('meshcoreResponderMatch syntax modes (#5924)', () => {
  it('a trigger with no syntax is regex mode; pattern mode is the anchored DSL with params', () => {
    expect(meshCoreTriggerSyntax({})).toBe('regex');
    expect(meshCoreTriggerSyntax({ syntax: 'pattern' })).toBe('pattern');
    expect(meshCoreResponderPatternMatches('ping', 'say ping')).toBe(true);
    expect(meshCoreResponderPatternMatches('ping', 'say ping', 'pattern')).toBe(false);
    expect(matchMeshCoreResponderPattern('weather {city}', 'WEATHER Miami', 'pattern').params).toEqual({ city: 'Miami' });
  });

  it('accepts emoji and rejects control characters in either mode', () => {
    for (const syntax of ['regex', 'pattern'] as const) {
      expect(validateMeshCoreResponderPattern('👋 hi', syntax).valid).toBe(true);
      expect(validateMeshCoreResponderPattern('hi\u0001', syntax)).toEqual({ valid: false, error: 'Pattern contains characters the server does not accept' });
    }
  });
});
