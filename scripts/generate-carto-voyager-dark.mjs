#!/usr/bin/env node
/**
 * Generate public/map-styles/carto-voyager-dark.json — the "CARTO Voyager
 * Dark" basemap preset (#5448).
 *
 * CARTO publishes Voyager, Positron and Dark Matter GL styles, but no dark
 * Voyager. Dark Matter is dark but has no land-use colour; Voyager has the
 * land-use colour but is light. This script takes CARTO's Voyager GL style and
 * recolours its paint properties into a dark palette that keeps what makes
 * Voyager readable: muted-green parks and woodland, teal-blue water, amber
 * major roads and light labels on dark halos.
 *
 * Only `*-color` paint properties change. Layers, filters, layout, sources,
 * sprite and glyphs are copied through untouched, so the result still reads
 * CARTO's vector tiles (and still needs a CARTO API key — the app appends it
 * through MapLibre's transformRequest, see src/components/VectorTileLayer.tsx).
 *
 * The recolour is a pure function of the input style, so re-running it on the
 * same Voyager style.json produces a byte-identical file. To pick up upstream
 * Voyager changes, just re-run it:
 *
 *   node scripts/generate-carto-voyager-dark.mjs            # fetch upstream
 *   node scripts/generate-carto-voyager-dark.mjs --input voyager.json
 *
 * License: CARTO's style definitions are BSD-3-Clause
 * (https://github.com/CartoDB/basemap-styles/blob/master/LICENSE.md,
 * "Copyright (c) 2018, CartoDB Inc."); the notice is carried in the output's
 * `metadata`. Map data is © OpenStreetMap contributors (ODbL).
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VOYAGER_STYLE_URL = 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json';

const HERE = dirname(fileURLToPath(import.meta.url));
export const OUTPUT_PATH = resolve(HERE, '..', 'public', 'map-styles', 'carto-voyager-dark.json');

// ---------------------------------------------------------------------------
// Colour parsing / formatting
// ---------------------------------------------------------------------------

/** Parse `#rgb`, `#rrggbb`, `rgb(...)` or `rgba(...)`. Returns null otherwise. */
export function parseColor(str) {
  if (typeof str !== 'string') return null;
  const s = str.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) {
    const [r, g, b] = m[1].split('').map((c) => parseInt(c + c, 16));
    return { r, g, b, a: 1 };
  }
  m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) {
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
  if (m) {
    return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  }
  return null;
}

export function rgbToHsl({ r, g, b }) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return { h: h * 60, s, l };
}

export function hslToRgb({ h, s, l }) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const sectors = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]];
  const [r, g, b] = sectors[Math.min(5, Math.floor(hp))];
  const m = l - c / 2;
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const hex2 = (n) => n.toString(16).padStart(2, '0');

/** Opaque colours become `#rrggbb`; translucent ones `rgba(r, g, b, a)`. */
export function formatColor({ r, g, b, a }) {
  if (a >= 1) return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  return `rgba(${r}, ${g}, ${b}, ${Math.round(a * 1000) / 1000})`;
}

// ---------------------------------------------------------------------------
// Recolour rules
// ---------------------------------------------------------------------------

/**
 * Pick the lightness/saturation rule for one colour property of one layer.
 * Each rule maps the ORIGINAL (light-theme) HSL to a dark-theme HSL. Hue is
 * always kept, so parks stay green, water stays teal and major roads stay
 * amber — only the brightness is flipped and the saturation damped.
 */
export function ruleFor(layer, prop) {
  const id = layer.id ?? '';
  const src = layer['source-layer'] ?? '';

  if (prop === 'background-color') {
    return ({ s }) => ({ s: s * 0.15, l: 0.13 });
  }
  if (prop === 'text-halo-color') {
    return ({ s }) => ({ s: s * 0.3, l: 0.1 });
  }
  if (prop === 'text-color' || prop === 'icon-color') {
    return ({ s, l }) => ({ s: Math.min(s, 0.45), l: Math.max(0.62, 1 - 0.5 * l) });
  }

  if (src === 'water') {
    // Teal-blue, not black: flip lightness and boost saturation.
    return ({ s, l }) => ({ s: Math.min(1, s * 1.5), l: clamp01(1.02 - l) });
  }
  if (src === 'waterway') {
    return ({ s }) => ({ s: Math.min(1, s * 1.4), l: 0.3 });
  }
  if (src === 'landcover' || src === 'park' || src === 'landuse') {
    // Muted green parks/woodland; residential beige sinks into the background.
    return ({ s, l }) => ({ s: s * 0.8, l: Math.min(0.4, Math.max(0.1, 1.1 - l)) });
  }
  if (src === 'building') {
    return ({ s, l }) => ({ s: s * 0.3, l: 0.1 + 0.12 * l });
  }
  if (src === 'boundary') {
    if (id.includes('outline')) return ({ s }) => ({ s: s * 0.3, l: 0.16 });
    return ({ s, l }) => ({ s: s * 0.5, l: 0.25 + 0.2 * (1 - l) });
  }
  if (src === 'aeroway') {
    return ({ s }) => ({ s: s * 0.3, l: 0.3 });
  }
  if (src === 'transportation') {
    const tunnel = id.startsWith('tunnel') ? 0.04 : 0;
    if (id.includes('rail_dash')) return ({ s }) => ({ s: s * 0.3, l: 0.14 });
    if (id.includes('_case')) return ({ s, l }) => ({ s: s * 0.5, l: 0.1 + 0.12 * l - tunnel });
    // Road/rail fills: keep lighter than their casing and the background.
    return ({ s, l }) => ({ s: s * 0.45, l: 0.14 + 0.28 * l - tunnel });
  }
  // Anything unclassified: a plain lightness flip.
  return ({ s, l }) => ({ s, l: 1 - l });
}

/** Recolour one CSS colour string with a rule. Non-colours pass through. */
export function recolor(str, rule) {
  const c = parseColor(str);
  if (!c) return str;
  const hsl = rgbToHsl(c);
  const out = rule(hsl);
  const rgb = hslToRgb({ h: hsl.h, s: clamp01(out.s), l: clamp01(out.l) });
  return formatColor({ ...rgb, a: c.a });
}

/** Walk a paint value (plain colour, `{stops}` function, or expression). */
function mapColors(value, rule) {
  if (typeof value === 'string') return recolor(value, rule);
  if (Array.isArray(value)) return value.map((v) => mapColors(v, rule));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = mapColors(v, rule);
    return out;
  }
  return value;
}

export const VOYAGER_DARK_LICENSE =
  'Style derived from CARTO Voyager (https://github.com/CartoDB/basemap-styles), ' +
  'BSD-3-Clause, Copyright (c) 2018, CartoDB Inc. ' +
  'Map data (c) OpenStreetMap contributors, ODbL. ' +
  'Tiles served by CARTO and require a CARTO basemap API key.';

/** Pure transform: CARTO Voyager style.json → Voyager Dark style.json. */
export function recolorVoyagerStyle(voyager) {
  const style = JSON.parse(JSON.stringify(voyager));
  style.name = 'Voyager Dark (MeshMonitor)';
  style.id = 'meshmonitor-voyager-dark';
  style.metadata = {
    ...(style.metadata ?? {}),
    'meshmonitor:generator': 'scripts/generate-carto-voyager-dark.mjs',
    'meshmonitor:source': VOYAGER_STYLE_URL,
    'meshmonitor:license': VOYAGER_DARK_LICENSE,
  };
  for (const layer of style.layers ?? []) {
    if (!layer.paint) continue;
    for (const prop of Object.keys(layer.paint)) {
      if (!prop.endsWith('-color')) continue;
      layer.paint[prop] = mapColors(layer.paint[prop], ruleFor(layer, prop));
    }
  }
  return style;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(argv) {
  const inputIdx = argv.indexOf('--input');
  let voyager;
  if (inputIdx >= 0 && argv[inputIdx + 1]) {
    voyager = JSON.parse(await readFile(argv[inputIdx + 1], 'utf8'));
  } else {
    const res = await fetch(VOYAGER_STYLE_URL);
    if (!res.ok) throw new Error(`Fetching ${VOYAGER_STYLE_URL} failed: HTTP ${res.status}`);
    voyager = await res.json();
  }
  const dark = recolorVoyagerStyle(voyager);
  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(dark, null, 2) + '\n');
  console.log(`Wrote ${OUTPUT_PATH} (${dark.layers.length} layers)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
