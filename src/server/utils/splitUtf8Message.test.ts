import { describe, it, expect } from 'vitest';
import { splitUtf8Message, truncateUtf8Bytes, utf8ByteLength, partMarker } from './splitUtf8Message.js';

const bytes = utf8ByteLength;
/** Strip the "(i/n) " marker. */
const body = (part: string) => part.replace(/^\(\d+\/\d+\) /, '');
/** True when the string survives a UTF-8 round trip (no halved characters). */
const isWellFormed = (s: string) => Buffer.from(s, 'utf8').toString('utf8') === s && !s.includes('�');

describe('truncateUtf8Bytes', () => {
  it('returns text that fits unchanged', () => {
    expect(truncateUtf8Bytes('hello', 5)).toBe('hello');
    expect(truncateUtf8Bytes('', 5)).toBe('');
  });

  it('cuts ASCII at the byte cap', () => {
    expect(truncateUtf8Bytes('abcdefgh', 3)).toBe('abc');
  });

  it('never halves a multi-byte character', () => {
    // é is 2 bytes: 5 bytes fits "éé" (4), not half of the third.
    expect(truncateUtf8Bytes('ééé', 5)).toBe('éé');
    // CJK is 3 bytes each.
    expect(truncateUtf8Bytes('日本語', 7)).toBe('日本');
    // An emoji is 4 bytes (a surrogate pair in JS).
    expect(truncateUtf8Bytes('a😀b', 4)).toBe('a');
    expect(truncateUtf8Bytes('a😀b', 5)).toBe('a😀');
  });

  it('keeps a multi-code-point character whole', () => {
    const flag = '🇩🇪'; // two regional indicators, 8 bytes
    expect(truncateUtf8Bytes(`x${flag}`, 5)).toBe('x');
    expect(truncateUtf8Bytes(`x${flag}`, 9)).toBe(`x${flag}`);
    const family = '👨‍👩‍👧'; // ZWJ sequence, 18 bytes
    expect(truncateUtf8Bytes(`ab${family}`, 10)).toBe('ab');
    const combining = 'é'; // e + combining acute, 3 bytes
    expect(truncateUtf8Bytes(`a${combining}`, 2)).toBe('a');
  });

  it('falls back to code points when one character exceeds the whole cap', () => {
    const family = '👨‍👩‍👧';
    const out = truncateUtf8Bytes(family, 4);
    expect(out).toBe('👨');
    expect(isWellFormed(out)).toBe(true);
  });

  it('returns empty for a zero or negative cap', () => {
    expect(truncateUtf8Bytes('abc', 0)).toBe('');
    expect(truncateUtf8Bytes('abc', -1)).toBe('');
  });
});

describe('splitUtf8Message', () => {
  it('returns a reply that fits as one part with no marker', () => {
    const text = 'Copy, Alice! 2 hops @ 12:00';
    expect(splitUtf8Message(text, { maxBytes: 150, maxParts: 3 })).toEqual({ parts: [text], truncated: false });
  });

  it('leaves a reply of exactly the cap alone', () => {
    const text = 'x'.repeat(150);
    expect(splitUtf8Message(text, { maxBytes: 150, maxParts: 3 }).parts).toEqual([text]);
  });

  it('measures the cap in bytes, not characters', () => {
    // 60 CJK characters = 180 bytes: over a 150-byte cap though only 60 chars.
    const text = '日'.repeat(60);
    const { parts } = splitUtf8Message(text, { maxBytes: 150, maxParts: 3 });
    expect(parts).toHaveLength(2);
  });

  it('adds ordered markers and keeps every part within the byte cap', () => {
    const text = Array.from({ length: 50 }, (_, i) => `word${i}`).join(' ');
    const { parts, truncated } = splitUtf8Message(text, { maxBytes: 150, maxParts: 3 });
    expect(parts).toHaveLength(3);
    parts.forEach((p, i) => {
      expect(p.startsWith(`(${i + 1}/3) `)).toBe(true);
      expect(bytes(p)).toBeLessThanOrEqual(150);
    });
    expect(truncated).toBe(false);
    // Nothing lost, nothing reordered.
    expect(parts.map(body).join(' ')).toBe(text);
  });

  it('counts the marker in the byte budget', () => {
    // 6-byte marker "(1/3) ": each body may use at most 144 of 150 bytes.
    const text = 'a'.repeat(400);
    const { parts } = splitUtf8Message(text, { maxBytes: 150, maxParts: 3 });
    expect(bytes(partMarker(3, 3))).toBe(6);
    expect(parts.map(bytes)).toEqual([150, 150, 6 + 400 - 288]);
    expect(parts.map((p) => bytes(body(p)))).toEqual([144, 144, 112]);
  });

  it('numbers the parts by how many were needed, not by the cap', () => {
    const text = 'a'.repeat(200);
    const { parts } = splitUtf8Message(text, { maxBytes: 150, maxParts: 3 });
    expect(parts).toHaveLength(2);
    expect(parts[0].startsWith('(1/2) ')).toBe(true);
    expect(parts[1].startsWith('(2/2) ')).toBe(true);
  });

  it('caps the part count and truncates the last part', () => {
    const text = 'a'.repeat(1000);
    const { parts, truncated } = splitUtf8Message(text, { maxBytes: 150, maxParts: 3 });
    expect(parts).toHaveLength(3);
    expect(truncated).toBe(true);
    expect(parts.every((p) => bytes(p) === 150)).toBe(true);
    expect(parts[2].startsWith('(3/3) ')).toBe(true);
  });

  it('truncates to one bare part when maxParts is 1', () => {
    const text = 'a'.repeat(200);
    const { parts, truncated } = splitUtf8Message(text, { maxBytes: 130, maxParts: 1 });
    expect(parts).toEqual(['a'.repeat(130)]);
    expect(truncated).toBe(true);
  });

  it('hard-splits text with no spaces on a character boundary', () => {
    const text = '日'.repeat(120); // 360 bytes, no break points
    const { parts, truncated } = splitUtf8Message(text, { maxBytes: 150, maxParts: 3 });
    expect(parts).toHaveLength(3);
    expect(truncated).toBe(false);
    parts.forEach((p) => {
      expect(bytes(p)).toBeLessThanOrEqual(150);
      expect(isWellFormed(p)).toBe(true);
    });
    // 144-byte budget holds 48 CJK characters.
    expect(parts.map((p) => body(p).length)).toEqual([48, 48, 24]);
    expect(parts.map(body).join('')).toBe(text);
  });

  it('never halves an emoji at a hard split', () => {
    // 143 ASCII bytes, then an emoji straddling the 144-byte body budget.
    const text = 'a'.repeat(143) + '😀' + 'b'.repeat(50);
    const { parts } = splitUtf8Message(text, { maxBytes: 150, maxParts: 3 });
    expect(parts).toHaveLength(2);
    expect(body(parts[0])).toBe('a'.repeat(143));
    expect(body(parts[1])).toBe('😀' + 'b'.repeat(50));
    parts.forEach((p) => expect(isWellFormed(p)).toBe(true));
  });

  it('keeps a flag and a ZWJ emoji whole across a split', () => {
    const text = '🇩🇪'.repeat(30) + '👨‍👩‍👧'.repeat(8); // 240 + 144 bytes
    const { parts } = splitUtf8Message(text, { maxBytes: 150, maxParts: 3 });
    parts.forEach((p) => {
      expect(bytes(p)).toBeLessThanOrEqual(150);
      expect(isWellFormed(p)).toBe(true);
      // An odd count of regional indicators would mean a split flag.
      expect((p.match(/[\u{1F1E6}-\u{1F1FF}]/gu) ?? []).length % 2).toBe(0);
      // A part never starts or ends on a joiner.
      expect(body(p).startsWith('‍')).toBe(false);
      expect(p.endsWith('‍')).toBe(false);
    });
    expect(parts.map(body).join('')).toBe(text);
  });

  it('truncates the last part on a character boundary', () => {
    const text = '😀'.repeat(200); // 800 bytes
    const { parts, truncated } = splitUtf8Message(text, { maxBytes: 150, maxParts: 3 });
    expect(truncated).toBe(true);
    parts.forEach((p) => {
      expect(isWellFormed(p)).toBe(true);
      expect(bytes(body(p)) % 4).toBe(0);
      expect(bytes(p)).toBeLessThanOrEqual(150);
    });
  });

  describe('break points', () => {
    const split = (text: string) => splitUtf8Message(text, { maxBytes: 60, maxParts: 3 }).parts.map(body);

    it('prefers a line break', () => {
      const text = `${'a'.repeat(40)}\n${'b'.repeat(40)}`;
      expect(split(text)).toEqual(['a'.repeat(40), 'b'.repeat(40)]);
    });

    it('prefers a sentence end over a later space', () => {
      const text = `${'a'.repeat(35)}. ${'b'.repeat(8)} ${'c'.repeat(30)}`;
      expect(split(text)[0]).toBe(`${'a'.repeat(35)}.`);
    });

    it('falls back to a comma, then a space', () => {
      expect(split(`${'a'.repeat(35)}, ${'b'.repeat(8)} ${'c'.repeat(30)}`)[0]).toBe(`${'a'.repeat(35)},`);
      expect(split(`${'a'.repeat(35)} ${'b'.repeat(40)}`)[0]).toBe('a'.repeat(35));
    });

    it('breaks after a hyphen when there is no space', () => {
      expect(split(`${'a'.repeat(35)}-${'b'.repeat(40)}`)[0]).toBe(`${'a'.repeat(35)}-`);
    });

    it('ignores a break point that would leave the part nearly empty', () => {
      // The only space is at 5 of 54 budget bytes: hard-split instead.
      const parts = split(`aaaa ${'b'.repeat(80)}`);
      expect(parts[0]).toBe(`aaaa ${'b'.repeat(49)}`);
    });

    it('uses the full window when it ends on a word boundary', () => {
      const text = `${'a'.repeat(20)} ${'b'.repeat(33)} ${'c'.repeat(20)}`;
      expect(split(text)).toEqual([`${'a'.repeat(20)} ${'b'.repeat(33)}`, 'c'.repeat(20)]);
    });

    it('does not start a part with whitespace', () => {
      const parts = split(`${'a'.repeat(40)}   ${'b'.repeat(40)}`);
      expect(parts).toEqual(['a'.repeat(40), 'b'.repeat(40)]);
    });
  });

  it('sends one bare part when only trailing whitespace overflowed', () => {
    const text = 'short reply' + ' '.repeat(200);
    expect(splitUtf8Message(text, { maxBytes: 150, maxParts: 3 })).toEqual({ parts: ['short reply'], truncated: false });
  });

  it('truncates rather than loops when the cap is too small for a marker', () => {
    const { parts, truncated } = splitUtf8Message('abcdefghijkl', { maxBytes: 8, maxParts: 3 });
    expect(parts).toEqual(['abcdefgh']);
    expect(truncated).toBe(true);
  });

  it('reserves a wider marker when maxParts has two digits', () => {
    const text = 'a'.repeat(500);
    const { parts } = splitUtf8Message(text, { maxBytes: 50, maxParts: 12 });
    expect(bytes(partMarker(12, 12))).toBe(8);
    expect(parts).toHaveLength(12);
    parts.forEach((p) => expect(bytes(p)).toBeLessThanOrEqual(50));
    expect(parts[0].startsWith('(1/12) ')).toBe(true);
    expect(parts[11].startsWith('(12/12) ')).toBe(true);
  });

  it('treats a non-positive or fractional maxParts as 1', () => {
    expect(splitUtf8Message('a'.repeat(20), { maxBytes: 10, maxParts: 0 }).parts).toEqual(['a'.repeat(10)]);
    expect(splitUtf8Message('a'.repeat(20), { maxBytes: 10, maxParts: 1.9 }).parts).toEqual(['a'.repeat(10)]);
  });
});
