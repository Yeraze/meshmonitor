/**
 * #6382 — the pure node-name sanitizer.
 */
import { describe, it, expect } from 'vitest';
import {
  buildNameSanitizerRules,
  compileCustomPattern,
  meshtasticLongNameLimit,
  parseNodeNameSanitizerConfig,
  sanitizeNodeName,
  validateNodeNameSanitizerSettings,
  type NodeNameSanitizerConfig,
} from './nodeNameSanitizer.js';
import { utf8ByteLength } from './nodeNameSanitizerConstants.js';

function rulesFor(partial: Partial<NodeNameSanitizerConfig> = {}) {
  return buildNameSanitizerRules({
    enabled: true,
    builtins: true,
    customPatterns: [],
    placeholder: '[spammer]',
    ...partial,
  }).rules;
}

const builtins = rulesFor();
const clean = (name: string, maxBytes?: number) => sanitizeNodeName(name, builtins, { maxBytes }).value;

describe('sanitizeNodeName — built-in rules', () => {
  it('replaces only the link and keeps the rest of the name', () => {
    const r = sanitizeNodeName('NodeName t.me/x', builtins);
    expect(r).toEqual({ value: 'NodeName [spammer]', changed: true, matchedRule: 'builtin:host:t.me' });
  });

  it('handles https:// links and bare hosts', () => {
    expect(clean('NodeName https://t.me/spam_channel')).toBe('NodeName [spammer]');
    expect(clean('Visit https://example.com/x now')).toBe('Visit [spammer] now');
    expect(clean('A telegram.me/x')).toBe('A [spammer]');
    expect(clean('A telegram.dog/x')).toBe('A [spammer]');
    expect(clean('A discord.gg/abc')).toBe('A [spammer]');
    expect(clean('A wa.me/123')).toBe('A [spammer]');
    expect(clean('A chat.whatsapp.com/abc')).toBe('A [spammer]');
  });

  it('is case-insensitive', () => {
    expect(clean('Node T.ME/Spam')).toBe('Node [spammer]');
  });

  it('uses the placeholder alone when the name was only a link', () => {
    expect(clean('t.me/spam')).toBe('[spammer]');
  });

  it('collapses leftover whitespace', () => {
    expect(clean('  Node    t.me/x    tail  ')).toBe('Node [spammer] tail');
  });

  it('merges adjacent links into one placeholder', () => {
    expect(clean('Bob t.me/a discord.gg/b')).toBe('Bob [spammer]');
  });

  it('leaves clean names alone, including dotted words and a host without a path', () => {
    for (const name of ['Base Station', 'Bot.me', 'v2.1 relay', 'meet.me', 'Node t.me']) {
      expect(sanitizeNodeName(name, builtins)).toEqual({ value: name, changed: false, matchedRule: null });
    }
  });

  it('does not match a host glued to a preceding letter', () => {
    expect(clean('Robot.me/x')).toBe('Robot.me/x');
  });
});

describe('sanitizeNodeName — obfuscation', () => {
  it('folds full-width characters', () => {
    expect(clean('Node ｔ．ｍｅ／spam')).toBe('Node [spammer]');
  });

  it('ignores zero-width characters inside the host', () => {
    expect(clean('Node t\u200B.\u200Dme/spam')).toBe('Node [spammer]');
    expect(clean('Node t\uFEFF.me/spam')).toBe('Node [spammer]');
  });

  it('matches spaced and bracketed dots', () => {
    expect(clean('Node t . me/spam')).toBe('Node [spammer]');
    expect(clean('Node t[.]me/spam')).toBe('Node [spammer]');
    expect(clean('Node t(dot)me/spam')).toBe('Node [spammer]');
    expect(clean('Node t。me/spam')).toBe('Node [spammer]');
  });

  it('keeps the exact spelling of the kept text', () => {
    // Full-width kept text is not folded: only the matched span changes.
    expect(clean('ＡＢＣ t.me/x')).toBe('ＡＢＣ [spammer]');
  });
});

describe('sanitizeNodeName — placeholder and byte limit', () => {
  it('uses a custom placeholder', () => {
    const r = rulesFor({ placeholder: '<link>' });
    expect(sanitizeNodeName('Node t.me/x', r).value).toBe('Node <link>');
  });

  it('trims the kept text, never the placeholder, to fit the limit', () => {
    const value = clean('ABCDEFGHIJKLMNOPQRS t.me/x', 24);
    expect(value).toBe('ABCDEFGHIJKLMN [spammer]');
    expect(utf8ByteLength(value)).toBeLessThanOrEqual(24);
  });

  it('trims multi-byte text by whole code points', () => {
    const value = clean('ÄÖÜÄÖÜÄÖÜÄÖÜ t.me/x', 24);
    expect(utf8ByteLength(value)).toBeLessThanOrEqual(24);
    expect(value.endsWith(' [spammer]')).toBe(true);
    expect(value).not.toContain('�');
  });

  it('keeps the placeholder even when it alone exceeds the limit', () => {
    expect(clean('t.me/x', 4)).toBe('[spammer]');
    expect(clean('AB t.me/x', 4)).toBe('[spammer]');
  });

  it('long-name limit is 24 bytes, or the original size up to 39', () => {
    expect(meshtasticLongNameLimit('short')).toBe(24);
    expect(meshtasticLongNameLimit('x'.repeat(30))).toBe(30);
    expect(meshtasticLongNameLimit('x'.repeat(60))).toBe(39);
  });
});

describe('custom patterns', () => {
  it('treats a plain host like a built-in host', () => {
    const r = rulesFor({ builtins: false, customPatterns: ['spam.example'] });
    expect(sanitizeNodeName('Node spam . example/abc', r)).toEqual({
      value: 'Node [spammer]', changed: true, matchedRule: 'custom:0',
    });
    // Built-ins are off here.
    expect(sanitizeNodeName('Node t.me/x', r).changed).toBe(false);
  });

  it('compiles other entries as RE2 regexes, case-insensitively', () => {
    const r = rulesFor({ builtins: false, customPatterns: ['buy\\s+crypto'] });
    expect(sanitizeNodeName('Node BUY  CRYPTO', r).value).toBe('Node [spammer]');
  });

  it('rejects patterns RE2 cannot compile (backreferences, lookaround)', () => {
    expect(() => compileCustomPattern('(a)\\1', 0)).toThrow();
    expect(() => compileCustomPattern('(?=x)', 0)).toThrow();
    expect(() => compileCustomPattern('[unclosed', 0)).toThrow();
  });

  it('rejects over-long and empty-matching patterns', () => {
    expect(() => compileCustomPattern('a'.repeat(257), 0)).toThrow(/256/);
    expect(() => compileCustomPattern('x*', 0)).toThrow(/empty/);
  });

  it('skips an invalid stored pattern instead of disabling the filter', () => {
    const { rules, skipped } = buildNameSanitizerRules({
      enabled: true, builtins: true, customPatterns: ['(a)\\1', 'ok\\.example/\\S+'], placeholder: '[x]',
    });
    expect(skipped).toEqual([0]);
    expect(sanitizeNodeName('N ok.example/z', rules).value).toBe('N [x]');
    expect(sanitizeNodeName('N t.me/z', rules).value).toBe('N [x]');
  });
});

describe('settings parsing and validation', () => {
  it('defaults: off, built-ins on, [spammer]', () => {
    expect(parseNodeNameSanitizerConfig({})).toEqual({
      enabled: false, builtins: true, customPatterns: [], placeholder: '[spammer]',
    });
  });

  it('reads stored values', () => {
    expect(parseNodeNameSanitizerConfig({
      nodeNameSanitizeEnabled: 'true',
      nodeNameSanitizeBuiltins: 'false',
      nodeNameSanitizeCustomPatterns: '["a\\\\.b/"]',
      nodeNameSanitizePlaceholder: ' [x] ',
    })).toEqual({ enabled: true, builtins: false, customPatterns: ['a\\.b/'], placeholder: '[x]' });
  });

  it('accepts valid input', () => {
    expect(validateNodeNameSanitizerSettings({
      nodeNameSanitizeEnabled: 'true',
      nodeNameSanitizeCustomPatterns: JSON.stringify(['spam.example', 'bit\\.ly/\\S*']),
      nodeNameSanitizePlaceholder: '[spam]',
    })).toBeNull();
    expect(validateNodeNameSanitizerSettings({ unrelated: 'x' })).toBeNull();
  });

  it('rejects a bad regex, a non-array, a non-boolean and an over-long placeholder', () => {
    expect(validateNodeNameSanitizerSettings({ nodeNameSanitizeCustomPatterns: '["(a)\\\\1"]' })).toMatch(/pattern 1/i);
    expect(validateNodeNameSanitizerSettings({ nodeNameSanitizeCustomPatterns: '{"a":1}' })).toMatch(/array/);
    expect(validateNodeNameSanitizerSettings({ nodeNameSanitizeCustomPatterns: 'not json' })).toMatch(/array/);
    expect(validateNodeNameSanitizerSettings({ nodeNameSanitizeCustomPatterns: JSON.stringify(['a'.repeat(300)]) })).toMatch(/256/);
    expect(validateNodeNameSanitizerSettings({ nodeNameSanitizeEnabled: 'yes' })).toMatch(/boolean/);
    expect(validateNodeNameSanitizerSettings({ nodeNameSanitizePlaceholder: 'x'.repeat(25) })).toMatch(/24 bytes/);
  });
});
