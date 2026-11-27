import { describe, it, expect } from 'vitest';
import { layoutV4Text, lineBoxCells } from './textLayout.js';

const measure = (s: string) => [...s].length * 0.6 * 10; // 6 per char

describe('lineBoxCells', () => {
  it('is a cap height plus two descenders, rounded up', () => {
    expect(lineBoxCells(3)).toBe(4);
    expect(lineBoxCells(8)).toBe(10);
  });
});

describe('layoutV4Text', () => {
  it('returns one empty line for empty text', () => {
    expect(layoutV4Text('', 60, 'left', measure)).toEqual([{ text: '', width: 0, x: 0 }]);
  });

  it('keeps text that fits on one line', () => {
    const [line, ...rest] = layoutV4Text('hello', 60, 'left', measure);
    expect(rest).toEqual([]);
    expect(line).toEqual({ text: 'hello', width: 30, x: 0 });
  });

  it('wraps greedily at spaces', () => {
    const lines = layoutV4Text('aaa bbb ccc', 40, 'left', measure); // 6 chars max
    expect(lines.map((l) => l.text)).toEqual(['aaa', 'bbb', 'ccc']);
    const wide = layoutV4Text('aa bb cc dd', 60, 'left', measure); // 10 chars max
    expect(wide.map((l) => l.text)).toEqual(['aa bb cc', 'dd']);
  });

  it('splits paragraphs on an explicit newline', () => {
    expect(layoutV4Text('a\n\nb', 60, 'left', measure).map((l) => l.text)).toEqual(['a', '', 'b']);
  });

  it('breaks a word wider than the area by code point', () => {
    const lines = layoutV4Text('abcdefghij', 24, 'left', measure); // 4 chars max
    expect(lines.map((l) => l.text)).toEqual(['abcd', 'efgh', 'ij']);
    const emoji = layoutV4Text('😀😀😀', 12, 'left', measure); // 2 code points max
    expect(emoji.map((l) => l.text)).toEqual(['😀😀', '😀']);
  });

  it('puts a long word on its own lines after a short one', () => {
    const lines = layoutV4Text('hi abcdefghij', 24, 'left', measure);
    expect(lines.map((l) => l.text)).toEqual(['hi', 'abcd', 'efgh', 'ij']);
  });

  it('ignores trailing spaces', () => {
    const [line] = layoutV4Text('abc   ', 60, 'left', measure);
    expect(line).toEqual({ text: 'abc', width: 18, x: 0 });
  });

  it('offsets center and right lines', () => {
    expect(layoutV4Text('abc', 60, 'center', measure)[0].x).toBe(21);
    expect(layoutV4Text('abc', 60, 'right', measure)[0].x).toBe(42);
  });
});
