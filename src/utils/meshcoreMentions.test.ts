import { describe, expect, it } from 'vitest';
import { meshcoreMentionedNames, textMentionsMeshCoreName } from './meshcoreMentions';

describe('meshcoreMentionedNames', () => {
  it('lists each mentioned name once, in order', () => {
    expect(meshcoreMentionedNames('@[KZ4DE 🏠 G3] hi @[Bob] and @[bob] again')).toEqual(['KZ4DE 🏠 G3', 'Bob']);
  });

  it('reads the reply form with a trailing colon', () => {
    expect(meshcoreMentionedNames('@[TheBeeKeeper]: negative')).toEqual(['TheBeeKeeper']);
  });

  it('ignores empty brackets, an unclosed bracket and plain @words', () => {
    expect(meshcoreMentionedNames('@[] @[  ] @[open and @bob')).toEqual([]);
    expect(meshcoreMentionedNames(null)).toEqual([]);
  });
});

describe('textMentionsMeshCoreName', () => {
  it('matches the whole name, ignoring case and outer spaces', () => {
    expect(textMentionsMeshCoreName('hey @[ mc-sandbox ]', 'MC-Sandbox')).toBe(true);
  });

  it('does not match part of a name, or a name with no brackets', () => {
    expect(textMentionsMeshCoreName('@[Bobby] hi', 'Bob')).toBe(false);
    expect(textMentionsMeshCoreName('@[Bob] hi', 'Bobby')).toBe(false);
    expect(textMentionsMeshCoreName('Bob: hi @Bob', 'Bob')).toBe(false);
  });

  it('a blank name never matches', () => {
    expect(textMentionsMeshCoreName('@[ ] hi', '')).toBe(false);
    expect(textMentionsMeshCoreName('@[x]', null)).toBe(false);
  });
});
