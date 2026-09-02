/**
 * @vitest-environment node
 *
 * Coverage guarantee: every key in `TELEMETRY_LABELS` must land in a
 * real category (not the `'other'` fallback), unless it is explicitly
 * enumerated in `EXPECTED_OTHER`. A new telemetry type that ships
 * without a category assignment therefore fails this test loudly.
 */
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import {
  getTelemetryCategory,
  TELEMETRY_CATEGORY_LABELS,
  TELEMETRY_CATEGORY_ORDER,
} from './telemetryCategory';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Extract the key set of the `TELEMETRY_LABELS` object literal in
 * `TelemetryChart.tsx` at test time. Reading the file rather than
 * importing it dodges the JSX/react transform for this pure-node test
 * and stays in lockstep with the label source of truth.
 */
function loadTelemetryLabelKeys(): string[] {
  const path = resolve(__dirname, '../components/TelemetryChart.tsx');
  const src = readFileSync(path, 'utf8');
  const start = src.indexOf('const TELEMETRY_LABELS: Record<string, string> = {');
  if (start < 0) throw new Error('TELEMETRY_LABELS declaration not found');
  const openBrace = src.indexOf('{', start);
  // Walk to the matching close brace.
  let depth = 0;
  let end = -1;
  for (let i = openBrace; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) throw new Error('unterminated TELEMETRY_LABELS block');
  const body = src.slice(openBrace + 1, end);
  const keys = new Set<string>();
  const re = /(?:^|\n)\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) keys.add(m[1]);
  return [...keys];
}

/**
 * Types that belong in the 'other' catch-all by design. Keep this small
 * and explicit. Adding an entry here is a review checkpoint: it means
 * we could not find a natural home for this type in one of the named
 * categories. Prefer to place a new type in a real category instead.
 */
const EXPECTED_OTHER: ReadonlySet<string> = new Set([
  'mc_analog_input',
  'mc_analog_output',
  'mc_frequency',
  'mc_load',
  'mc_concentration',
  'mc_distance',
]);

describe('getTelemetryCategory', () => {
  it('classifies every TELEMETRY_LABELS key into a named category (or explicit other)', () => {
    const keys = loadTelemetryLabelKeys();
    expect(keys.length).toBeGreaterThan(50); // sanity: label map has tens of entries
    const misplaced: string[] = [];
    for (const key of keys) {
      const cat = getTelemetryCategory(key);
      if (cat === 'other' && !EXPECTED_OTHER.has(key)) {
        misplaced.push(key);
      }
    }
    expect(misplaced).toEqual([]);
  });

  it('strips mc_*_ch<N> suffix and classifies by base name', () => {
    expect(getTelemetryCategory('mc_battery_volts_ch2')).toBe('power');
    expect(getTelemetryCategory('mc_temperature_ch1')).toBe('environment');
    expect(getTelemetryCategory('mc_humidity_ch0')).toBe('environment');
    expect(getTelemetryCategory('mc_altitude_ch3')).toBe('location');
    expect(getTelemetryCategory('mc_barometer_ch5')).toBe('environment');
  });

  it('handles mc_*_ch<N>_<axis> multi-axis suffix (strips both)', () => {
    // mc_gps is not in the label map, so this falls through to 'other'.
    // Doubles as a check that the suffix logic never accidentally
    // classifies a bare unknown base name.
    expect(getTelemetryCategory('mc_gps_ch0_lat')).toBe('other');
    // A known base with axis suffix should still classify.
    expect(getTelemetryCategory('mc_temperature_ch1_a')).toBe('environment');
  });

  it('falls through to other for an unknown type', () => {
    expect(getTelemetryCategory('unknown_type')).toBe('other');
    expect(getTelemetryCategory('')).toBe('other');
    expect(getTelemetryCategory('mc_')).toBe('other');
  });

  it('has a stable display order with favorites first and other last', () => {
    expect(TELEMETRY_CATEGORY_ORDER[0]).toBe('favorites');
    expect(TELEMETRY_CATEGORY_ORDER[TELEMETRY_CATEGORY_ORDER.length - 1]).toBe('other');
  });

  it('has a label for every category in the display order', () => {
    for (const cat of TELEMETRY_CATEGORY_ORDER) {
      expect(TELEMETRY_CATEGORY_LABELS[cat]).toBeTruthy();
    }
  });
});
