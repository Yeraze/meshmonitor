import { describe, it, expect } from 'vitest';
import { validTokenSet, classifyToken, tokenize, diagnoseTokens } from './tokenHints';

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

describe('diagnoseTokens', () => {
  it('gives a type-specific message per problematic token, in order, deduped', () => {
    const sys = validTokenSet('trigger.system', ['known']);
    const text = 'Hi {{ trigger.from }} {{ trigger.asfd }} {{ var.asfd }} {{ trigger.event }} {{ NOW }} {{ foo }}';
    expect(diagnoseTokens(text, sys)).toEqual([
      { token: 'trigger.from', severity: 'warn', detail: 'is undefined for this trigger' },
      { token: 'trigger.asfd', severity: 'error', detail: 'is not a recognized trigger field' },
      { token: 'var.asfd', severity: 'error', detail: 'does not exist' },
      // trigger.event (system token) and NOW are valid → omitted
      { token: 'foo', severity: 'error', detail: 'is not a recognized token' },
    ]);
  });
  it('returns nothing when all tokens are valid for the trigger', () => {
    const msg = validTokenSet('trigger.message', ['flag']);
    expect(diagnoseTokens('{{ trigger.from }} {{ var.flag }} {{ NOW }}', msg)).toEqual([]);
  });
  it('ignores empty tokens and de-dups repeats', () => {
    const msg = validTokenSet('trigger.message', []);
    expect(diagnoseTokens('{{ var.x }} {{ var.x }} {{  }}', msg)).toEqual([
      { token: 'var.x', severity: 'error', detail: 'does not exist' },
    ]);
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
