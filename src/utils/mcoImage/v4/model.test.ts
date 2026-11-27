import { describe, expect, it } from 'vitest';
import { figureWeight, sameStyle, textDefaultFontSize, textDefaultWidth, translated, withStyle } from './model.js';
import type { V4Figure, V4Style } from './model.js';

const black: V4Style = { fill: null, stroke: 0, strokeWidth: 1 };
const red: V4Style = { fill: 1, stroke: 1, strokeWidth: 2 };
const dot = (x: number, y: number, style = black): V4Figure => ({ kind: 'dot', point: { x, y }, style });

describe('model', () => {
  it('translates every figure kind and keeps style', () => {
    const line: V4Figure = { kind: 'line', start: { x: 0, y: 0 }, end: { x: 2, y: 1 }, style: black };
    expect(translated(line, 3, 4)).toEqual({ kind: 'line', start: { x: 3, y: 4 }, end: { x: 5, y: 5 }, style: black });
    const group: V4Figure = { kind: 'group', figures: [dot(1, 1), dot(2, 2)], style: black };
    expect(translated(group, 1, 0)).toEqual({ kind: 'group', figures: [dot(2, 1), dot(3, 2)], style: black });
  });

  it('restyles a group only when the style differs', () => {
    const group: V4Figure = { kind: 'group', figures: [dot(1, 1)], style: black };
    expect((withStyle(group, black) as typeof group).figures).toBe(group.figures);
    expect(withStyle(group, red)).toEqual({ kind: 'group', figures: [dot(1, 1, red)], style: red });
  });

  it('ignores a restyle on a raster layer', () => {
    const raster: V4Figure = {
      kind: 'raster', x: 0, y: 0, width: 1, height: 1, pixels: [0], transparentColor: null, rgba: new Uint8ClampedArray(4),
    };
    expect(withStyle(raster, red)).toBe(raster);
  });

  it('weighs groups by their leaves and caches the result', () => {
    const inner: V4Figure = { kind: 'group', figures: [dot(0, 0), dot(1, 1)], style: black };
    const outer: V4Figure = { kind: 'group', figures: [inner, dot(2, 2)], style: black };
    expect(figureWeight(outer)).toEqual({ figures: 5, points: 3, textCodePoints: 0 });
    expect(figureWeight(outer)).toBe(figureWeight(outer));
    const text: V4Figure = {
      kind: 'text', origin: { x: 0, y: 0 }, width: null, fontSize: 3, align: 'left', text: 'a😀b', style: black,
    };
    expect(figureWeight(text).textCodePoints).toBe(3);
  });

  it('compares styles and derives text defaults', () => {
    expect(sameStyle(black, { ...black })).toBe(true);
    expect(sameStyle(black, red)).toBe(false);
    expect(textDefaultWidth(48, 10)).toBe(38);
    expect(textDefaultWidth(48, -3)).toBe(48);
    expect(textDefaultWidth(48, 60)).toBe(1);
    expect(textDefaultFontSize(48)).toBe(5);
    expect(textDefaultFontSize(4)).toBe(1);
  });
});
