import { describe, it, expect } from 'vitest';
import { parseSpip, SPIP_PALETTE } from './spip';

describe('parseSpip', () => {
  it('decodes the spec checkerboard', () => {
    const img = parseSpip('3:yzyzyzyzy');
    expect(img).toEqual({
      cols: 3,
      rows: 3,
      pixels: ['#000000', '#ffffff', '#000000', '#ffffff', '#000000', '#ffffff', '#000000', '#ffffff', '#000000'],
    });
  });

  it('decodes the spec heart', () => {
    const img = parseSpip('8:zyyzzyyzyaayyaayyaaaaaayzyaaaayzzzyaayzzzzzyyzzz');
    expect(img?.cols).toBe(8);
    expect(img?.rows).toBe(6);
    expect(img?.pixels[9]).toBe(SPIP_PALETTE.a);
  });

  it('ignores case and surrounding whitespace', () => {
    expect(parseSpip('  2:AbY9 \n')?.pixels).toEqual(['#ff0000', '#ff8080', '#000000', '#e5e5e5']);
  });

  it.each([
    ['plain chat', 'hello world'],
    ['a time', '12:30'],
    ['a verse reference', 'John 3:16'],
    ['a one-row grid', '4:abcd'],
    ['a one-column grid', '1:abcd'],
    ['a partial last row', '3:abcde'],
    ['the reserved 0', '2:a0bc'],
    ['an unknown character', '2:ab!c'],
    ['text around the code', 'look 2:abcd'],
    ['too many columns', `33:${'a'.repeat(66)}`],
    ['too many pixels', `32:${'a'.repeat(32 * 33)}`],
    ['empty', ''],
  ])('rejects %s', (_label, text) => {
    expect(parseSpip(text)).toBeNull();
  });

  it('rejects null and undefined', () => {
    expect(parseSpip(null)).toBeNull();
    expect(parseSpip(undefined)).toBeNull();
  });
});
