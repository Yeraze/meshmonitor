/**
 * The browser copy of the Auto-Responder matcher (#5924) must give the same
 * answer as the server, in both syntaxes: same accept / reject, same match,
 * same params. Compares `responderTriggerNative` (built-in engine) against
 * `autoResponderMatcher` (RE2).
 */
import { describe, it, expect } from 'vitest';
import { matchResponderTrigger, validateResponderTrigger } from '../server/utils/autoResponderMatcher';
import { matchResponderTriggerNative, validateResponderTriggerNative } from './responderTriggerNative';
import type { ResponderSyntax } from './responderTrigger';

const CASES: Record<ResponderSyntax, string[]> = {
  regex: [
    '^ping', 'ping$', 'help', '^(test|ping)', 'weather\\s+\\w+', '[0-9]{5}', '^status$', '!(signal|chat)\\b',
    '\\p{L}', '\\pL+', '^\\P{L}',
    '(?<city>\\w+) weather', '^a{1,2}b$',
    // Unicode: emoji, ZWJ sequence, variation selector, accents, CJK
    '🔋', '👋\\s*hi', '[🔋⚡]', '^.$', '👨‍👩‍👧', '☀️', 'café', '天気', 'тест',
    // rejected by the server
    '', 'x'.repeat(101), '.*.*', 'a+b+', '(?=ping)', '(a)\\1', 'a{1000}', 'a{2,}', 'ping\u0007', 'ping\u202E',
  ],
  pattern: [
    'ping', 'weather {city}', 'weather, w {city}', 'zip {z:\\d{5}}', 'a.b', 'coords {lat:-?\\d+} {lon:-?\\d+}',
    '🔋', '👋 {who}', 'café {x}', '天気 {city}', '👨‍👩‍👧',
    // rejected by the server
    'bad {x:(}', 'ok, ' + 'b'.repeat(101), 'ping\u0000', 'look {x:(?=a)}',
  ],
};

const MESSAGES = [
  'ping', 'PING please', 'say ping', 'I need HELP', 'weather Miami', 'w Miami', 'WEATHER Miami', 'zip 33076', 'zip 3307',
  'status', 'STATUS now', '', 'hey !SIGNAL', 'a.b', 'axb', 'aab', 'coords 40 -74', 'Miami weather',
  '🔋', 'battery 🔋 low', 'oh 👋 HI', '👋 Alice', '⚡', '👨‍👩‍👧', '☀️', 'CAFÉ', 'café latte', '天気 東京', '今日の天気',
  'ТЕСТ', 'w\u0435ather Барнаул', 'look a',
];

describe('responder trigger: browser copy mirrors the server', () => {
  for (const syntax of ['regex', 'pattern'] as const) {
    it.each(CASES[syntax])(`${syntax} %j: accepted by both or rejected by both`, (pattern) => {
      expect(validateResponderTriggerNative(pattern, syntax).valid).toBe(validateResponderTrigger(pattern, syntax).ok);
    });

    it(`${syntax}: same match and params as the server for every message`, () => {
      for (const pattern of CASES[syntax]) {
        for (const text of MESSAGES) {
          const server = matchResponderTrigger({ pattern, syntax }, text);
          const client = matchResponderTriggerNative({ pattern, syntax }, text);
          expect(client.matched, `${syntax} ${pattern} vs ${text}`).toBe(server.matched);
          expect(client.params, `${syntax} ${pattern} vs ${text}`).toEqual(server.params);
        }
      }
    });
  }
});
