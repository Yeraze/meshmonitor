/**
 * The shared Auto-Responder matcher, both syntaxes (#5924): anchoring, case,
 * params, homoglyphs, emoji, the ReDoS rejection and the length cap. Runs the
 * server build (RE2).
 */
import { describe, it, expect } from 'vitest';
import { matchResponderTrigger, validateResponderTrigger } from './autoResponderMatcher.js';
import { compileAutoAckRegex, validateAutoAckRegex } from './autoAckRegex.js';
import { compileUserRegex } from '../../utils/safeRegex.js';
import { resolveResponderSyntax, substituteResponderParams } from '../../utils/responderTrigger.js';

const pat = (pattern: string | string[], text: string) => matchResponderTrigger({ pattern, syntax: 'pattern' }, text);
const rx = (pattern: string, text: string) => matchResponderTrigger({ pattern, syntax: 'regex' }, text);

describe('resolveResponderSyntax', () => {
  it('keeps a known value and falls back to the legacy default otherwise', () => {
    expect(resolveResponderSyntax('regex', 'pattern')).toBe('regex');
    expect(resolveResponderSyntax('pattern', 'regex')).toBe('pattern');
    expect(resolveResponderSyntax(undefined, 'pattern')).toBe('pattern');
    expect(resolveResponderSyntax(undefined, 'regex')).toBe('regex');
    expect(resolveResponderSyntax('bogus', 'regex')).toBe('regex');
  });
});

describe('pattern mode', () => {
  it('is anchored and case-insensitive', () => {
    expect(pat('ping', 'PING').matched).toBe(true);
    expect(pat('ping', 'ping me').matched).toBe(false);
    expect(pat('ping', 'say ping').matched).toBe(false);
  });

  it('splits on top-level commas and reports the matching alternative', () => {
    const m = pat('weather, w {city}', 'w Miami');
    expect(m).toEqual({ matched: true, params: { city: 'Miami' }, matchedPattern: 'w {city}' });
  });

  it('captures {name} and {name:regex} params', () => {
    expect(pat('zip {z:\\d{5}}', 'zip 33076').params).toEqual({ z: '33076' });
    expect(pat('zip {z:\\d{5}}', 'zip 3307').matched).toBe(false);
  });

  it('escapes regex specials in literal text', () => {
    expect(pat('a.b', 'a.b').matched).toBe(true);
    expect(pat('a.b', 'axb').matched).toBe(false);
  });

  it('normalises homoglyphs and keeps the original text in the param', () => {
    // Cyrillic "е" in the message still matches the Latin pattern.
    expect(pat('weather {city}', 'w\u0435ather Miami').matched).toBe(true);
    // The param comes from the original text, so "Барнаул" is not mangled.
    expect(pat('weather {city}', 'weather Барнаул').params.city).toBe('Барнаул');
  });

  it('matches emoji, accented and CJK literals', () => {
    expect(pat('🔋', '🔋').matched).toBe(true);
    expect(pat('👋 {who}', '👋 Alice').params).toEqual({ who: 'Alice' });
    expect(pat('café', 'CAFÉ').matched).toBe(true);
    expect(pat('天気 {city}', '天気 東京').params).toEqual({ city: '東京' });
    expect(pat('👨‍👩‍👧', '👨‍👩‍👧').matched).toBe(true);
  });

  it('an alternative whose param regex does not compile matches nothing, the others still work', () => {
    expect(pat(['bad {x:(}', 'good'], 'good').matched).toBe(true);
    expect(pat(['bad {x:(}'], 'bad x').matched).toBe(false);
  });
});

describe('regex mode', () => {
  it('is unanchored and case-insensitive', () => {
    expect(rx('ping', 'well PING there').matched).toBe(true);
    expect(rx('^ping$', 'ping me').matched).toBe(false);
  });

  it('never splits on commas', () => {
    expect(rx('^a{1,2}b$', 'aab').matched).toBe(true);
  });

  it('named groups supply params', () => {
    expect(rx('(?<city>\\w+) weather', 'Miami weather today').params).toEqual({ city: 'Miami' });
  });

  it('does not apply homoglyphs (unchanged behaviour)', () => {
    expect(rx('weather', 'w\u0435ather').matched).toBe(false);
  });

  it('matches emoji, accented and CJK patterns (RE2 runs on UTF-8)', () => {
    expect(rx('🔋', 'battery 🔋 low').matched).toBe(true);
    expect(rx('👋\\s*hi', 'oh 👋 HI').matched).toBe(true);
    expect(rx('[🔋⚡]', '⚡').matched).toBe(true);
    expect(rx('^.$', '🔋').matched).toBe(true);
    expect(rx('café', 'CAFÉ au lait').matched).toBe(true);
    expect(rx('天気', '今日の天気').matched).toBe(true);
  });

  it('rejects ReDoS shapes and over-long patterns, so they never match', () => {
    expect(rx('(a+)+', 'aaaa').matched).toBe(false);
    expect(rx('.*.*', 'x').matched).toBe(false);
    expect(rx('a{2,}', 'aaa').matched).toBe(false);
    expect(rx('a'.repeat(101), 'a'.repeat(101)).matched).toBe(false);
    expect(rx('a'.repeat(100), 'a'.repeat(100)).matched).toBe(true);
  });
});

describe('validateResponderTrigger', () => {
  it.each([
    ['🔋', 'regex'], ['👋\\s*hi', 'regex'], ['café', 'regex'], ['天気', 'regex'], ['👨‍👩‍👧', 'regex'],
    ['🏴󠁧󠁢󠁥󠁮󠁧󠁿', 'regex'], ['☀️', 'regex'],
    ['weather {city}', 'pattern'], ['🔋 {level:\\d+}', 'pattern'], ['a, b', 'pattern'],
  ] as const)('accepts %j in %s mode', (pattern, syntax) => {
    expect(validateResponderTrigger(pattern, syntax)).toEqual({ ok: true });
  });

  it.each([
    ['ping\u0007', 'regex', /disallowed characters/],
    ['ping\u0000', 'pattern', /disallowed characters/],
    ['ping\u202E', 'regex', /disallowed characters/], // bidi override (format char)
    ['pi\u2028ng', 'pattern', /disallowed characters/], // line separator
    ['(a+)+', 'regex', /catastrophic/],
    ['a'.repeat(101), 'regex', /too long/],
    ['ok, ' + 'b'.repeat(101), 'pattern', /too long/],
    ['(?=x)', 'regex', /invalid regex/],
    ['bad {x:(}', 'pattern', /invalid regex/],
    ['', 'regex', /empty/],
  ] as const)('rejects %j in %s mode', (pattern, syntax, msg) => {
    const v = validateResponderTrigger(pattern, syntax);
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(msg);
  });
});

describe('auto-ack / forwarding regex check shares the relaxed charset', () => {
  it('accepts emoji and non-ASCII text, still rejects control characters and ReDoS shapes', () => {
    expect(validateAutoAckRegex('🔋').ok).toBe(true);
    expect(validateAutoAckRegex('^(test|ping|тест)').ok).toBe(true);
    expect(validateAutoAckRegex('ping\u0001').ok).toBe(false);
    expect(validateAutoAckRegex('(a+)+').ok).toBe(false);
    expect(compileAutoAckRegex('👋\\s*hi').regex!.test('👋 HI')).toBe(true);
  });
});

describe('compileUserRegex (the DSL path) takes emoji', () => {
  it('compiles and matches emoji literals and classes', () => {
    expect(compileUserRegex('^🔋 (\\d+)$', 'i').exec('🔋 42')?.[1]).toBe('42');
    expect(compileUserRegex('[🔋⚡]+', 'i').test('⚡⚡')).toBe(true);
  });
});

describe('substituteResponderParams', () => {
  it('fills known params, leaves other tokens, and takes values literally', () => {
    expect(substituteResponderParams('{city} at {TIME}', { city: 'Miami' })).toBe('Miami at {TIME}');
    expect(substituteResponderParams('{v}', { v: '$&' })).toBe('$&');
  });
});
