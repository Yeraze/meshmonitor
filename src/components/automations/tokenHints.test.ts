import { describe, it, expect } from 'vitest';
import { validTokenSet, tokenize, unknownTokens } from './tokenHints';

describe('validTokenSet', () => {
  it('includes NOW, the trigger tokens, universals, and known vars', () => {
    const set = validTokenSet('trigger.message', ['threshold']);
    expect(set.has('NOW')).toBe(true);
    expect(set.has('trigger.text')).toBe(true);      // message token
    expect(set.has('trigger.timestamp')).toBe(true); // universal
    expect(set.has('trigger.sourceId')).toBe(true);  // universal
    expect(set.has('var.threshold')).toBe(true);
    expect(set.has('trigger.nope')).toBe(false);
    expect(set.has('var.missing')).toBe(false);
  });
});

describe('unknownTokens', () => {
  const set = validTokenSet('trigger.system', ['flag']);
  it('flags typos and unknown var names', () => {
    expect(unknownTokens('{{ trigger.lastestVersion }} at {{ trigger.timestamp }}', set)).toEqual(['trigger.lastestVersion']);
    expect(unknownTokens('{{ var.flag }} {{ var.nope }}', set)).toEqual(['var.nope']);
  });
  it('returns nothing for all-valid text and ignores empty tokens', () => {
    expect(unknownTokens('{{ trigger.event }} at {{ NOW }} {{  }}', set)).toEqual([]);
    expect(unknownTokens('plain text', set)).toEqual([]);
  });
  it('de-dups repeated unknown tokens', () => {
    expect(unknownTokens('{{ var.x }} {{ var.x }}', set)).toEqual(['var.x']);
  });
});

describe('tokenize', () => {
  const set = validTokenSet('trigger.message', []);
  it('splits text into plain + token segments with known flags', () => {
    const segs = tokenize('hi {{ trigger.text }} / {{ trigger.bad }}', set);
    expect(segs.map((s) => s.token)).toEqual([false, true, false, true]);
    expect(segs[1].known).toBe(true);   // trigger.text
    expect(segs[3].known).toBe(false);  // trigger.bad
    expect(segs.map((s) => s.text).join('')).toBe('hi {{ trigger.text }} / {{ trigger.bad }}');
  });
});
