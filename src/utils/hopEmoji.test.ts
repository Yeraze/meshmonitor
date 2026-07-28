import { describe, it, expect } from 'vitest';
import { HOP_COUNT_EMOJIS, HOP_EMOJI_MAX, hopCountEmoji } from './hopEmoji';

describe('hopEmoji', () => {
  describe('HOP_COUNT_EMOJIS', () => {
    it('has exactly 8 glyphs, pinned as exact string literals', () => {
      // Pinned individually (not just .toEqual on the whole array) so a
      // copy-paste of 0️⃣ for *️⃣ at index 0 fails loudly rather than being
      // masked by an array-level diff.
      expect(HOP_COUNT_EMOJIS[0]).toBe('*️⃣');
      expect(HOP_COUNT_EMOJIS[1]).toBe('1️⃣');
      expect(HOP_COUNT_EMOJIS[2]).toBe('2️⃣');
      expect(HOP_COUNT_EMOJIS[3]).toBe('3️⃣');
      expect(HOP_COUNT_EMOJIS[4]).toBe('4️⃣');
      expect(HOP_COUNT_EMOJIS[5]).toBe('5️⃣');
      expect(HOP_COUNT_EMOJIS[6]).toBe('6️⃣');
      expect(HOP_COUNT_EMOJIS[7]).toBe('7️⃣');
      expect(HOP_COUNT_EMOJIS.length).toBe(8);
    });

    it('HOP_EMOJI_MAX is 7', () => {
      expect(HOP_EMOJI_MAX).toBe(7);
    });
  });

  describe('hopCountEmoji', () => {
    it('maps 0 to the direct asterisk keycap, not 0️⃣', () => {
      expect(hopCountEmoji(0)).toBe('*️⃣');
    });

    it('maps 1-7 to their own glyphs', () => {
      expect(hopCountEmoji(1)).toBe('1️⃣');
      expect(hopCountEmoji(2)).toBe('2️⃣');
      expect(hopCountEmoji(3)).toBe('3️⃣');
      expect(hopCountEmoji(4)).toBe('4️⃣');
      expect(hopCountEmoji(5)).toBe('5️⃣');
      expect(hopCountEmoji(6)).toBe('6️⃣');
      expect(hopCountEmoji(7)).toBe('7️⃣');
    });

    it('clamps values above 7 to 7️⃣', () => {
      expect(hopCountEmoji(8)).toBe('7️⃣');
      expect(hopCountEmoji(99)).toBe('7️⃣');
    });

    it('clamps negative values to 0 (a malformed hopStart < hopLimit packet)', () => {
      expect(hopCountEmoji(-1)).toBe('*️⃣');
      expect(hopCountEmoji(-99)).toBe('*️⃣');
    });

    it('truncates fractional hop counts toward zero', () => {
      expect(hopCountEmoji(2.9)).toBe('2️⃣');
    });

    it('returns undefined for unknown hop counts', () => {
      expect(hopCountEmoji(undefined)).toBeUndefined();
      expect(hopCountEmoji(null)).toBeUndefined();
      expect(hopCountEmoji(NaN)).toBeUndefined();
      expect(hopCountEmoji(Infinity)).toBeUndefined();
    });
  });
});
