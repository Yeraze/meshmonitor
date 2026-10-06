import { describe, it, expect } from 'vitest';
import { getLeadingEmoji, leadingEmojiWith, splitGraphemes } from './statusMessage';

describe('getLeadingEmoji (#5645)', () => {
  const cases: Array<[string, string | null | undefined, string | null]> = [
    ['empty string', '', null],
    ['null', null, null],
    ['undefined', undefined, null],
    ['simple emoji', '📡 Monitoring', '📡'],
    ['letter first', 'Monitoring', null],
    ['flag (two regional indicators)', '🇺🇸 QRV', '🇺🇸'],
    ['ZWJ family', '👨‍👩‍👧‍👦 Family trip', '👨‍👩‍👧‍👦'],
    ['ZWJ + variation selector', '🏃‍♀️ On the move', '🏃‍♀️'],
    ['digits', '1-800-NUMBER', null],
    ['leading space', ' 📡 leading space', null],
    ['leading newline', '\n📡', null],
    ['skin tone', '👍🏽 ok', '👍🏽'],
    ['skin tone on a text-default base', '☝🏽 one', '☝🏽'],
    ['keycap digit', '1️⃣ first', '1️⃣'],
    ['keycap without variation selector', '2⃣ second', '2⃣'],
    ['keycap hash', '#️⃣ tag', '#️⃣'],
    ['plain hash', '#meshtastic', null],
    ['plain asterisk', '* note', null],
    ['digit plus variation selector, no keycap', '1️ one', null],
    ['text-default pictograph with U+FE0F', '⚠️ storm', '⚠️'],
    ['heart with U+FE0F', '❤️ love', '❤️'],
    ['SOS is only an emoji', '🆘 help', '🆘'],
    ['subdivision flag (tag sequence)', '🏴󠁧󠁢󠁥󠁮󠁧󠁿 England', '🏴󠁧󠁢󠁥󠁮󠁧󠁿'],
    ['rainbow flag (ZWJ)', '🏳️‍🌈 pride', '🏳️‍🌈'],
    ['lone regional indicator', '🇺 half', null],
    ['copyright sign', '© 2026', null],
    ['trademark sign', '™ brand', null],
    ['punctuation', '!!! urgent', null],
    ['bracket', '[away]', null],
    ['accented letter', 'Écoute', null],
    ['CJK', '監視中', null],
    ['emoji only', '💤', '💤'],
    ['emoji after text', 'Home 🏠', null],
    ['html-looking text', '<b>bold</b>', null],
  ];

  it.each(cases)('%s', (_name, input, expected) => {
    expect(getLeadingEmoji(input)).toBe(expected);
  });

  it('returns one grapheme, never the text after it', () => {
    const emoji = getLeadingEmoji('🇺🇸🇨🇦 two flags');
    expect(emoji).toBe('🇺🇸');
    expect(splitGraphemes(emoji!)).toHaveLength(1);
  });

  it('gives no badge when Intl.Segmenter is missing, rather than half a glyph', () => {
    expect(leadingEmojiWith('📡 Monitoring', null)).toBeNull();
    expect(leadingEmojiWith('🇺🇸 QRV', null)).toBeNull();
    expect(leadingEmojiWith('👨‍👩‍👧‍👦 Family trip', null)).toBeNull();
  });
});
