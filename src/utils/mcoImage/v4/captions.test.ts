import { describe, it, expect } from 'vitest';
import { collectV4Captions } from './captions.js';
import type { McoImageV4Document, V4Figure, V4Style } from './model.js';

const style: V4Style = { fill: null, stroke: 0, strokeWidth: 1 };
const text = (t: string): V4Figure => ({
  kind: 'text',
  origin: { x: 0, y: 0 },
  width: null,
  fontSize: 3,
  align: 'left',
  text: t,
  style,
});
const doc = (figures: V4Figure[]): McoImageV4Document => ({
  mode: 'vector',
  width: 16,
  height: 16,
  paletteProfile: 1,
  palette: [0],
  background: null,
  initialStyle: style,
  figures,
});

describe('collectV4Captions', () => {
  it('collects text in paint order and recurses into groups', () => {
    const d = doc([
      text('one'),
      { kind: 'dot', point: { x: 1, y: 1 }, style },
      { kind: 'group', figures: [text('two'), { kind: 'group', figures: [text('three')], style }], style },
      text('four'),
    ]);
    expect(collectV4Captions(d)).toEqual(['one', 'two', 'three', 'four']);
  });

  it('turns newlines into spaces, trims, and drops empties and consecutive repeats', () => {
    const d = doc([text(' a\nb '), text('  '), text('a b'), text('c'), text('a b')]);
    expect(collectV4Captions(d)).toEqual(['a b', 'c', 'a b']);
  });

  it('returns nothing for a document without text', () => {
    expect(collectV4Captions(doc([{ kind: 'dot', point: { x: 0, y: 0 }, style }]))).toEqual([]);
  });
});
