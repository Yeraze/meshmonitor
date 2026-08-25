import { describe, it, expect } from 'vitest';
import {
  meshtasticNodeColor,
  relativeLuminance,
  readableTextColor,
  importanceTier,
  nodeColorStyle,
} from './nodeColor';

describe('meshtasticNodeColor', () => {
  it('takes the low 24 bits of the node number as RGB (last 6 hex digits)', () => {
    // !433a1b2c -> 0x433a1b2c, low 24 bits = 0x3a1b2c
    expect(meshtasticNodeColor(0x433a1b2c)).toBe('#3a1b2c');
  });

  it('zero-pads short colors to six hex digits', () => {
    expect(meshtasticNodeColor(0x11000102)).toBe('#000102');
    expect(meshtasticNodeColor(0)).toBe('#000000');
  });

  it('handles a full-white low-24 value', () => {
    expect(meshtasticNodeColor(0xffffff)).toBe('#ffffff');
  });

  it('coerces negative signed-32-bit node numbers to unsigned', () => {
    // -1 as uint32 = 0xffffffff, low 24 bits = 0xffffff
    expect(meshtasticNodeColor(-1)).toBe('#ffffff');
  });
});

describe('relativeLuminance', () => {
  it('is 0 for black and 1 for white', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
  });

  it('returns 0 (dark) for malformed input', () => {
    expect(relativeLuminance('nope')).toBe(0);
    expect(relativeLuminance('#fff')).toBe(0);
  });
});

describe('readableTextColor', () => {
  it('picks black text on light backgrounds', () => {
    expect(readableTextColor('#ffffff')).toBe('#000000');
    expect(readableTextColor('#f5a623')).toBe('#000000'); // amber
  });

  it('picks white text on dark backgrounds', () => {
    expect(readableTextColor('#000000')).toBe('#ffffff');
    expect(readableTextColor('#3a1b2c')).toBe('#ffffff'); // dark maroon
  });
});

describe('importanceTier', () => {
  it('favorites outrank distance', () => {
    expect(importanceTier(5, true)).toBe('favorite');
    expect(importanceTier(0, true)).toBe('favorite');
  });

  it('buckets by hop distance when not a favorite', () => {
    expect(importanceTier(0, false)).toBe('direct');
    expect(importanceTier(1, false)).toBe('near');
    expect(importanceTier(2, false)).toBe('near');
    expect(importanceTier(3, false)).toBe('far');
    expect(importanceTier(6, false)).toBe('far');
  });

  it('treats missing / 999 hop data as unknown', () => {
    expect(importanceTier(undefined, false)).toBe('unknown');
    expect(importanceTier(999, false)).toBe('unknown');
  });
});

describe('nodeColorStyle', () => {
  it('monochrome yields no overrides', () => {
    expect(nodeColorStyle('monochrome', { nodeNum: 0x433a1b2c })).toEqual({});
  });

  it('meshtastic yields no overrides when the node number is not finite (e.g. MeshCore)', () => {
    expect(nodeColorStyle('meshtastic', { nodeNum: NaN })).toEqual({});
  });

  it('meshtastic yields the node color with a luminance-picked text color', () => {
    expect(nodeColorStyle('meshtastic', { nodeNum: 0x433a1b2c })).toEqual({
      background: '#3a1b2c',
      text: '#ffffff',
    });
  });

  it('importance yields a tier background with readable text', () => {
    const fav = nodeColorStyle('importance', { nodeNum: 1, isFavorite: true });
    expect(fav.background).toBe('#f5a623');
    expect(fav.text).toBe('#000000');

    const direct = nodeColorStyle('importance', { nodeNum: 1, hopsAway: 0 });
    expect(direct.background).toBe('#22c55e');

    const far = nodeColorStyle('importance', { nodeNum: 1, hopsAway: 4 });
    expect(far.background).toBe('#64748b');
    expect(far.text).toBe('#ffffff');
  });
});
