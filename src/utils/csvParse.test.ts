import { describe, it, expect } from 'vitest';
import { parseCsv } from './csvParse.js';

describe('parseCsv', () => {
  it('strips a BOM', () => {
    expect(parseCsv('\uFEFFa,b\r\n1,2').records).toEqual([['a', 'b'], ['1', '2']]);
  });
  it('accepts mixed CRLF and LF and skips a trailing blank line', () => {
    const r = parseCsv('a,b\r\n1,2\n3,4\r\n');
    expect(r.records).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
    expect(r.lines).toEqual([1, 2, 3]);
  });
  it('handles quoted commas, quotes and newlines, tracking start lines', () => {
    const r = parseCsv('a,b\n"x, ""y""\nz",2\n3,4');
    expect(r.records).toEqual([['a', 'b'], ['x, "y"\nz', '2'], ['3', '4']]);
    expect(r.lines).toEqual([1, 2, 4]);
  });
  it('keeps empty cells and reports ragged rows by length', () => {
    const r = parseCsv('a,b,c\n1,,3\n4,5');
    expect(r.records[1]).toEqual(['1', '', '3']);
    expect(r.records[2]).toHaveLength(2);
    expect(r.lines[2]).toBe(3);
  });
  it('returns nothing for empty input', () => {
    expect(parseCsv('').records).toEqual([]);
  });
  it('stops at maxRecords with bounded work', () => {
    const text = 'a\n'.repeat(100_000);
    const r = parseCsv(text, { maxRecords: 100 });
    expect(r.truncated).toBe(true);
    expect(r.records.length).toBe(101);
    expect(parseCsv('a\nb\n', { maxRecords: 5 }).truncated).toBe(false);
  });
});
