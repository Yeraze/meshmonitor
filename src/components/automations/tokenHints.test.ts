import { describe, it, expect } from 'vitest';
import { validTokenSet, classifyToken, tokenize, unknownTokens, foreignTokens } from './tokenHints';

describe('validTokenSet', () => {
  it('includes NOW, the trigger tokens, universals, and known vars', () => {
    const set = validTokenSet('trigger.message', ['threshold']);
    expect(set.has('NOW')).toBe(true);
    expect(set.has('trigger.from')).toBe(true);      // message token
    expect(set.has('trigger.timestamp')).toBe(true); // universal
    expect(set.has('var.threshold')).toBe(true);
    expect(set.has('trigger.asfd')).toBe(false);
  });
});

describe('classifyToken', () => {
  it('ok for current-trigger tokens, known vars, and NOW', () => {
    const valid = validTokenSet('trigger.message', ['flag']);
    expect(classifyToken('trigger.from', valid)).toBe('ok');
    expect(classifyToken('var.flag', valid)).toBe('ok');
    expect(classifyToken('NOW', valid)).toBe('ok');
  });
  it('foreign for a real token that belongs to a DIFFERENT trigger', () => {
    const sys = validTokenSet('trigger.system', []);
    // trigger.from is a message token — valid somewhere, but not for system
    expect(classifyToken('trigger.from', sys)).toBe('foreign');
  });
  it('bad for genuine typos and unknown var names', () => {
    const valid = validTokenSet('trigger.message', ['flag']);
    expect(classifyToken('trigger.asfd', valid)).toBe('bad');
    expect(classifyToken('var.nope', valid)).toBe('bad');
  });
});

describe('unknownTokens / foreignTokens', () => {
  it('flags only genuine typos as unknown; cross-trigger tokens are foreign, not typos', () => {
    const sys = validTokenSet('trigger.system', []);
    const text = 'Hi {{ trigger.from }} welcome to {{ trigger.asfd }} at {{ trigger.event }}';
    expect(unknownTokens(text, sys)).toEqual(['trigger.asfd']);   // only the real typo
    expect(foreignTokens(text, sys)).toEqual(['trigger.from']);   // valid elsewhere, not here
    // trigger.event IS a system token → neither
  });
  it('on the matching trigger, a real token is neither unknown nor foreign', () => {
    const msg = validTokenSet('trigger.message', []);
    expect(unknownTokens('{{ trigger.from }}', msg)).toEqual([]);
    expect(foreignTokens('{{ trigger.from }}', msg)).toEqual([]);
  });
  it('ignores empty tokens and de-dups', () => {
    const msg = validTokenSet('trigger.message', []);
    expect(unknownTokens('{{ var.x }} {{ var.x }} {{  }}', msg)).toEqual(['var.x']);
  });
});

describe('tokenize', () => {
  it('tags each token segment with its status', () => {
    const sys = validTokenSet('trigger.system', []);
    const segs = tokenize('a {{ trigger.event }} {{ trigger.from }} {{ trigger.asfd }}', sys);
    const tokenSegs = segs.filter((s) => s.token);
    expect(tokenSegs.map((s) => s.status)).toEqual(['ok', 'foreign', 'bad']);
  });
});
