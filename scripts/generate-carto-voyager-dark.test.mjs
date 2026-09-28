/**
 * Tests for the CARTO Voyager Dark generator (#5448) and the style it wrote to
 * public/map-styles/carto-voyager-dark.json.
 *
 * The generator only rewrites `*-color` paint values, so these tests pin both
 * halves: the colour maths (dark background, hues kept) and the parts of the
 * style that must pass through untouched (CARTO sources, sprite, glyphs, layer
 * list) so the app's transformRequest can still key every CARTO request.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  OUTPUT_PATH,
  parseColor,
  rgbToHsl,
  recolor,
  ruleFor,
  recolorVoyagerStyle,
  VOYAGER_DARK_LICENSE,
} from './generate-carto-voyager-dark.mjs';

const hsl = (c) => rgbToHsl(parseColor(c));

/** First colour string found in a paint value (plain value or `{stops}`). */
function firstColor(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const v of value) {
      const c = firstColor(v);
      if (c) return c;
    }
    return null;
  }
  if (value && typeof value === 'object') return firstColor(Object.values(value));
  return null;
}

describe('colour helpers', () => {
  it('parses hex and rgba colours, rejects everything else', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('#FFE9A5')).toEqual({ r: 255, g: 233, b: 165, a: 1 });
    expect(parseColor('rgba(197, 225, 178, 0.2)')).toEqual({ r: 197, g: 225, b: 178, a: 0.2 });
    expect(parseColor('rgb(1,2,3)')).toEqual({ r: 1, g: 2, b: 3, a: 1 });
    expect(parseColor('map')).toBeNull();
  });

  it('keeps hue and alpha, changes lightness', () => {
    const out = recolor('rgba(197, 225, 178, 0.35)', ({ s }) => ({ s, l: 0.2 }));
    expect(parseColor(out).a).toBe(0.35);
    expect(Math.abs(hsl(out).h - hsl('rgba(197, 225, 178, 1)').h)).toBeLessThan(3);
    expect(hsl(out).l).toBeCloseTo(0.2, 1);
  });

  it('passes non-colour strings through', () => {
    expect(recolor('map', () => ({ s: 0, l: 0 }))).toBe('map');
  });
});

describe('recolorVoyagerStyle', () => {
  const fixture = {
    version: 8,
    name: 'Voyager',
    metadata: {},
    sources: { carto: { type: 'vector', url: 'https://tiles.basemaps.cartocdn.com/vector/carto.streets/v1/tiles.json' } },
    sprite: 'https://tiles.basemaps.cartocdn.com/gl/voyager-gl-style/sprite',
    glyphs: 'https://tiles.basemaps.cartocdn.com/fonts/{fontstack}/{range}.pbf',
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#fbf8f3' } },
      { id: 'water', type: 'fill', 'source-layer': 'water', paint: { 'fill-color': '#b0d0d6', 'fill-translate-anchor': 'map' } },
      { id: 'road_minor_fill', type: 'line', 'source-layer': 'transportation', paint: { 'line-color': '#ffffff', 'line-width': 2 } },
      { id: 'road_minor_case', type: 'line', 'source-layer': 'transportation', paint: { 'line-color': '#e6dfcb' } },
    ],
  };

  it('is pure and deterministic', () => {
    const copy = JSON.parse(JSON.stringify(fixture));
    const a = recolorVoyagerStyle(fixture);
    const b = recolorVoyagerStyle(fixture);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(fixture).toEqual(copy); // input not mutated
  });

  it('touches only *-color paint values', () => {
    const out = recolorVoyagerStyle(fixture);
    expect(out.sources).toEqual(fixture.sources);
    expect(out.sprite).toBe(fixture.sprite);
    expect(out.glyphs).toBe(fixture.glyphs);
    expect(out.layers[1].paint['fill-translate-anchor']).toBe('map');
    expect(out.layers[2].paint['line-width']).toBe(2);
    expect(out.metadata['meshmonitor:license']).toBe(VOYAGER_DARK_LICENSE);
  });

  it('keeps road fills lighter than their casing and the background', () => {
    const out = recolorVoyagerStyle(fixture);
    const bg = hsl(out.layers[0].paint['background-color']).l;
    const fill = hsl(out.layers[2].paint['line-color']).l;
    const casing = hsl(out.layers[3].paint['line-color']).l;
    expect(fill).toBeGreaterThan(casing);
    expect(fill).toBeGreaterThan(bg);
  });

  it('routes unknown layers through a plain lightness flip', () => {
    const rule = ruleFor({ id: 'x', type: 'fill', 'source-layer': 'mystery' }, 'fill-color');
    expect(rule({ h: 0, s: 0, l: 0.9 }).l).toBeCloseTo(0.1);
  });
});

describe('committed public/map-styles/carto-voyager-dark.json', () => {
  const style = JSON.parse(readFileSync(OUTPUT_PATH, 'utf8'));
  const layer = (id) => style.layers.find((l) => l.id === id);

  it('still reads CARTO tiles, sprite and glyphs (keyed by transformRequest)', () => {
    expect(style.version).toBe(8);
    expect(style.sources.carto.url).toMatch(/^https:\/\/tiles\.basemaps\.cartocdn\.com\//);
    expect(style.sprite).toMatch(/^https:\/\/tiles\.basemaps\.cartocdn\.com\/gl\/voyager-gl-style\/sprite$/);
    expect(style.glyphs).toMatch(/^https:\/\/tiles\.basemaps\.cartocdn\.com\/fonts\//);
    expect(style.layers.length).toBeGreaterThan(80);
  });

  it('carries the CARTO BSD-3-Clause notice and OSM credit', () => {
    expect(style.metadata['meshmonitor:license']).toContain('BSD-3-Clause');
    expect(style.metadata['meshmonitor:license']).toContain('CartoDB Inc.');
    expect(style.metadata['meshmonitor:license']).toContain('OpenStreetMap');
  });

  it('is dark', () => {
    expect(hsl(layer('background').paint['background-color']).l).toBeLessThan(0.2);
  });

  it('keeps teal-blue water, not black', () => {
    const water = hsl(layer('water').paint['fill-color']);
    expect(water.h).toBeGreaterThan(170);
    expect(water.h).toBeLessThan(210);
    expect(water.s).toBeGreaterThan(0.3);
    expect(water.l).toBeGreaterThan(0.15);
    expect(water.l).toBeLessThan(0.4);
  });

  it('keeps green land use', () => {
    for (const id of ['landcover', 'park_national_park', 'landuse']) {
      const c = hsl(firstColor(layer(id).paint['fill-color']));
      expect(c.h).toBeGreaterThan(70);
      expect(c.h).toBeLessThan(150);
      expect(c.l).toBeLessThan(0.45);
    }
  });

  it('uses light labels on dark halos', () => {
    for (const l of style.layers.filter((x) => x.type === 'symbol')) {
      const text = firstColor(l.paint?.['text-color']);
      const halo = firstColor(l.paint?.['text-halo-color']);
      if (text) expect(hsl(text).l).toBeGreaterThan(0.55);
      if (halo) expect(hsl(halo).l).toBeLessThan(0.2);
    }
  });
});
