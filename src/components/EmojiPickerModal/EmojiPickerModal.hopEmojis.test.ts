import { describe, it, expect } from 'vitest';
import { DEFAULT_TAPBACK_EMOJIS } from './EmojiPickerModal';
import { MQTT_SOURCE_EMOJI } from '../../utils/hopEmoji';

// Regression test for #4340 WP1 §2.3: the 8 hop-count entries in
// DEFAULT_TAPBACK_EMOJIS used to be hand-typed literals — a second copy of the
// same table AutoAck carries. They're now generated from the shared
// src/utils/hopEmoji.ts table. This pins the resulting array so the generated
// entries stay element-for-element identical to the original literals (same
// order, same glyphs, same titles).

describe('EmojiPickerModal - DEFAULT_TAPBACK_EMOJIS hop-count entries (#4340)', () => {
  const HOP_TITLES = [
    'Direct (0 hops)',
    '1 hop',
    '2 hops',
    '3 hops',
    '4 hops',
    '5 hops',
    '6 hops',
    '7+ hops',
  ];
  const HOP_GLYPHS = ['*️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣'];

  it('contains exactly the 8 hop entries, in order, with the original titles', () => {
    const hopEntries = DEFAULT_TAPBACK_EMOJIS.filter((e) => HOP_GLYPHS.includes(e.emoji));
    expect(hopEntries).toHaveLength(8);
    expect(hopEntries.map((e) => e.emoji)).toEqual(HOP_GLYPHS);
    expect(hopEntries.map((e) => e.title)).toEqual(HOP_TITLES);
  });

  it('places the hop entries as a contiguous block right after "Double exclamation"', () => {
    const idx = DEFAULT_TAPBACK_EMOJIS.findIndex((e) => e.title === 'Double exclamation');
    expect(idx).toBeGreaterThanOrEqual(0);
    const following = DEFAULT_TAPBACK_EMOJIS.slice(idx + 1, idx + 9);
    expect(following.map((e) => e.emoji)).toEqual(HOP_GLYPHS);
  });

  // #4594 grew the list by one: the MQTT-source glyph, the transport counterpart
  // to the hop keycaps. It sits immediately after the hop block, NOT inside it —
  // HOP_GLYPHS is indexed by hop count and must stay 8 long.
  it('array length and non-hop entries are otherwise unchanged (33 total after #4594)', () => {
    expect(DEFAULT_TAPBACK_EMOJIS).toHaveLength(33);
    expect(DEFAULT_TAPBACK_EMOJIS[0]).toEqual({ emoji: '👍', title: 'Thumbs up' });
    expect(DEFAULT_TAPBACK_EMOJIS[DEFAULT_TAPBACK_EMOJIS.length - 1]).toEqual({ emoji: '💯', title: '100' });
  });

  it('offers the MQTT-source glyph exactly once, right after the hop block (#4594)', () => {
    const mqttEntries = DEFAULT_TAPBACK_EMOJIS.filter((e) => e.emoji === MQTT_SOURCE_EMOJI);
    expect(mqttEntries).toEqual([{ emoji: MQTT_SOURCE_EMOJI, title: 'Received via MQTT' }]);
    const lastHopIdx = DEFAULT_TAPBACK_EMOJIS.findIndex((e) => e.emoji === HOP_GLYPHS[HOP_GLYPHS.length - 1]);
    expect(DEFAULT_TAPBACK_EMOJIS[lastHopIdx + 1].emoji).toBe(MQTT_SOURCE_EMOJI);
  });

  it('the MQTT glyph is not part of the hop table (it is a transport axis, not a hop count) (#4594)', () => {
    expect(HOP_GLYPHS).not.toContain(MQTT_SOURCE_EMOJI);
  });
});
