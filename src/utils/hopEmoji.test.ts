import { describe, it, expect } from 'vitest';
import { HOP_COUNT_EMOJIS, HOP_EMOJI_MAX, hopCountEmoji, hopOrMqttEmoji, MQTT_SOURCE_EMOJI } from './hopEmoji';

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

  // #4594 — the transport dimension.
  describe('MQTT_SOURCE_EMOJI', () => {
    it('is the keycap hash, matching the style of the hop keycaps', () => {
      expect(MQTT_SOURCE_EMOJI).toBe('#️⃣');
    });

    it('is NOT a member of HOP_COUNT_EMOJIS — it is a different axis', () => {
      expect(HOP_COUNT_EMOJIS).not.toContain(MQTT_SOURCE_EMOJI);
      // Guards the index contract: HOP_COUNT_EMOJIS[n] must stay "n hops".
      expect(HOP_COUNT_EMOJIS.length).toBe(HOP_EMOJI_MAX + 1);
    });
  });

  describe('hopOrMqttEmoji', () => {
    it('is exactly hopCountEmoji when the source is not MQTT', () => {
      for (const hops of [0, 1, 2, 7, 8, 99, -1, 2.9]) {
        expect(hopOrMqttEmoji(hops, false)).toBe(hopCountEmoji(hops));
      }
      for (const unknown of [undefined, null, NaN, Infinity]) {
        expect(hopOrMqttEmoji(unknown, false)).toBeUndefined();
      }
    });

    it('treats an absent/null MQTT flag as not-MQTT (back-compat default)', () => {
      expect(hopOrMqttEmoji(3, undefined)).toBe('3️⃣');
      expect(hopOrMqttEmoji(3, null)).toBe('3️⃣');
    });

    it('overrides every hop count with the MQTT glyph when the source is MQTT', () => {
      for (const hops of [0, 1, 7, 99, -1]) {
        expect(hopOrMqttEmoji(hops, true)).toBe(MQTT_SOURCE_EMOJI);
      }
    });

    it('returns the MQTT glyph even when the hop count is unknown', () => {
      // Unlike a hop count, "arrived over MQTT" is never in doubt — so this is a
      // glyph where hopCountEmoji would have returned undefined.
      expect(hopCountEmoji(undefined)).toBeUndefined();
      expect(hopOrMqttEmoji(undefined, true)).toBe(MQTT_SOURCE_EMOJI);
      expect(hopOrMqttEmoji(NaN, true)).toBe(MQTT_SOURCE_EMOJI);
    });

    it('only the literal `true` counts as MQTT (no truthiness coercion)', () => {
      expect(hopOrMqttEmoji(2, 0 as unknown as boolean)).toBe('2️⃣');
      expect(hopOrMqttEmoji(2, '' as unknown as boolean)).toBe('2️⃣');
      expect(hopOrMqttEmoji(2, 'mqtt_bridge' as unknown as boolean)).toBe('2️⃣');
    });
  });
});
