import { describe, it, expect } from 'vitest';
import {
  NODE_STATUS_MAX_BYTES,
  truncateToUtf8Bytes,
  utf8ByteLength,
  validateStatusMessageConfigPayload,
} from './statusMessage';

// Built from code points so this file holds no literal emoji.
const GREEN_CIRCLE = '\u{1F7E2}'; // 4 bytes
const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}'; // man ZWJ woman ZWJ girl: 18 bytes
const FLAG = '\u{1F1FA}\u{1F1F8}'; // two regional indicators: 8 bytes
const THUMBS_TONE = '\u{1F44D}\u{1F3FD}'; // emoji + skin-tone modifier: 8 bytes

describe('NODE_STATUS_MAX_BYTES', () => {
  it('is one below the nanopb buffer size (max_size:80 holds the NUL)', () => {
    expect(NODE_STATUS_MAX_BYTES).toBe(79);
  });
});

describe('utf8ByteLength', () => {
  it('counts ASCII as one byte each', () => {
    expect(utf8ByteLength('')).toBe(0);
    expect(utf8ByteLength('Available')).toBe(9);
  });

  it('counts multi-byte characters', () => {
    expect(utf8ByteLength('é')).toBe(2);
    expect(utf8ByteLength('中')).toBe(3);
    expect(utf8ByteLength('héllo')).toBe(6);
  });

  it('counts an emoji as 4 bytes, not 2 UTF-16 units', () => {
    expect(GREEN_CIRCLE.length).toBe(2);
    expect(utf8ByteLength(GREEN_CIRCLE)).toBe(4);
  });

  it('counts every part of a ZWJ sequence', () => {
    expect(utf8ByteLength(FAMILY)).toBe(18);
    expect(utf8ByteLength(FLAG)).toBe(8);
    expect(utf8ByteLength(THUMBS_TONE)).toBe(8);
  });
});

describe('truncateToUtf8Bytes', () => {
  it('leaves text at or under the limit alone', () => {
    expect(truncateToUtf8Bytes('Available')).toBe('Available');
    const exact = 'a'.repeat(79);
    expect(truncateToUtf8Bytes(exact)).toBe(exact);
  });

  it('cuts ASCII at the limit', () => {
    expect(truncateToUtf8Bytes('a'.repeat(80))).toBe('a'.repeat(79));
    expect(truncateToUtf8Bytes('a'.repeat(81))).toBe('a'.repeat(79));
  });

  it('never cuts a multi-byte character in half', () => {
    // 78 bytes of ASCII leave 1 byte: a 2-byte é does not fit.
    expect(truncateToUtf8Bytes('a'.repeat(78) + 'é')).toBe('a'.repeat(78));
    // 26 * 3 = 78 bytes fit; the 27th would make 81.
    expect(truncateToUtf8Bytes('中'.repeat(27))).toBe('中'.repeat(26));
  });

  it('never cuts an emoji in half', () => {
    // 19 emoji = 76 bytes; the 20th would make 80.
    const result = truncateToUtf8Bytes(GREEN_CIRCLE.repeat(20));
    expect(result).toBe(GREEN_CIRCLE.repeat(19));
    expect(utf8ByteLength(result)).toBe(76);
    // 77 bytes of ASCII leave 2 bytes: a 4-byte emoji is dropped whole.
    expect(truncateToUtf8Bytes('a'.repeat(77) + GREEN_CIRCLE)).toBe('a'.repeat(77));
  });

  it('keeps or drops a ZWJ sequence, flag or skin-tone emoji as one unit', () => {
    // 70 + 18 = 88 bytes: the family does not fit, so none of it stays.
    expect(truncateToUtf8Bytes('a'.repeat(70) + FAMILY)).toBe('a'.repeat(70));
    // 61 + 18 = 79 bytes: it fits whole.
    expect(truncateToUtf8Bytes('a'.repeat(61) + FAMILY)).toBe('a'.repeat(61) + FAMILY);
    // 75 + 8 = 83: a flag is not left as half a flag.
    expect(truncateToUtf8Bytes('a'.repeat(75) + FLAG)).toBe('a'.repeat(75));
    // 75 + 8 = 83: the thumb does not lose its skin tone.
    expect(truncateToUtf8Bytes('a'.repeat(75) + THUMBS_TONE)).toBe('a'.repeat(75));
  });

  it('always returns valid text within the limit', () => {
    for (const sample of [FAMILY.repeat(10), FLAG.repeat(20), `${GREEN_CIRCLE} `.repeat(30)]) {
      const result = truncateToUtf8Bytes(sample);
      expect(utf8ByteLength(result)).toBeLessThanOrEqual(79);
      expect(result).not.toContain('�');
      expect(sample.startsWith(result)).toBe(true);
    }
  });

  it('honours a caller-supplied limit', () => {
    expect(truncateToUtf8Bytes('hello', 3)).toBe('hel');
    expect(truncateToUtf8Bytes(GREEN_CIRCLE, 3)).toBe('');
  });
});

describe('validateStatusMessageConfigPayload', () => {
  it('accepts a status of exactly 79 bytes', () => {
    expect(validateStatusMessageConfigPayload({ nodeStatus: 'a'.repeat(79) })).toBeNull();
  });

  it('rejects 80 bytes and 81 bytes', () => {
    expect(validateStatusMessageConfigPayload({ nodeStatus: 'a'.repeat(80) })).toMatch(/79 bytes/);
    expect(validateStatusMessageConfigPayload({ nodeStatus: 'a'.repeat(81) })).toMatch(/79 bytes/);
  });

  it('counts bytes, so 20 emoji (80 bytes, 20 characters) are rejected', () => {
    expect(validateStatusMessageConfigPayload({ nodeStatus: GREEN_CIRCLE.repeat(20) })).not.toBeNull();
    expect(validateStatusMessageConfigPayload({ nodeStatus: GREEN_CIRCLE.repeat(19) })).toBeNull();
  });

  it('accepts an empty or absent status', () => {
    expect(validateStatusMessageConfigPayload({ nodeStatus: '' })).toBeNull();
    expect(validateStatusMessageConfigPayload({})).toBeNull();
    expect(validateStatusMessageConfigPayload(null)).toBeNull();
  });

  it('rejects a status that is not a string', () => {
    expect(validateStatusMessageConfigPayload({ nodeStatus: 42 })).toMatch(/string/);
    expect(validateStatusMessageConfigPayload({ nodeStatus: ['a'] })).toMatch(/string/);
  });
});
