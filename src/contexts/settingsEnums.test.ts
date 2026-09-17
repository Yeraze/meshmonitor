/**
 * Enum-shaped settings: one list per setting, checked on both entry points.
 *
 * The bug this closes was not a missing check in one place. Each setting had
 * TWO entry points — a `localStorage` seed and the server settings response —
 * each carrying its own hand-written copy of the valid values, so they drifted
 * apart. Most seeds allowlisted; most server handlers did
 * `settings.x as SomeUnion`, which is a promise to the compiler rather than a
 * check. A stored `"foo"` reached component state as a value matching neither
 * branch of whatever consumed it.
 *
 * Found reviewing #5018, where the same gap was about to be added for one more
 * setting.
 *
 * Compile-time exhaustiveness (a union member missing from its list) is
 * enforced by `_exhaustive` in the module itself — `npx tsc` fails and names
 * the missing value. These tests cover the runtime half.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  pickSetting,
  TEMPERATURE_UNITS,
  DISTANCE_UNITS,
  POSITION_HISTORY_LINE_STYLES,
  TIME_FORMATS,
  DATE_FORMATS,
  MAP_PIN_STYLES,
  MAP_PIN_COLOR_MODES,
  NODE_LIST_STYLES,
  ICON_STYLES,
  SORT_FIELDS,
  SORT_DIRECTIONS,
  NODE_HOPS_CALCULATIONS,
  DASHBOARD_SORT_OPTIONS,
} from './settingsEnums';

const ALL_LISTS: Array<[string, readonly string[]]> = [
  ['TEMPERATURE_UNITS', TEMPERATURE_UNITS],
  ['DISTANCE_UNITS', DISTANCE_UNITS],
  ['POSITION_HISTORY_LINE_STYLES', POSITION_HISTORY_LINE_STYLES],
  ['TIME_FORMATS', TIME_FORMATS],
  ['DATE_FORMATS', DATE_FORMATS],
  ['MAP_PIN_STYLES', MAP_PIN_STYLES],
  ['MAP_PIN_COLOR_MODES', MAP_PIN_COLOR_MODES],
  ['NODE_LIST_STYLES', NODE_LIST_STYLES],
  ['ICON_STYLES', ICON_STYLES],
  ['SORT_FIELDS', SORT_FIELDS],
  ['SORT_DIRECTIONS', SORT_DIRECTIONS],
  ['NODE_HOPS_CALCULATIONS', NODE_HOPS_CALCULATIONS],
  ['DASHBOARD_SORT_OPTIONS', DASHBOARD_SORT_OPTIONS],
];

describe('pickSetting', () => {
  it.each(ALL_LISTS)('%s: accepts every value it lists', (_name, list) => {
    for (const v of list) expect(pickSetting(v, list)).toBe(v);
  });

  it.each(ALL_LISTS)('%s: rejects a value it does not list', (_name, list) => {
    expect(pickSetting('definitely-not-a-setting-value', list)).toBeNull();
  });

  it('rejects the non-strings a JSON settings payload can actually contain', () => {
    // The server hands back parsed JSON, so these are all reachable — and each
    // would have sailed through the old `as SomeUnion` cast.
    for (const bad of [null, undefined, 42, true, {}, [], ['C']]) {
      expect(pickSetting(bad, TEMPERATURE_UNITS)).toBeNull();
    }
  });

  it('rejects a near-miss rather than coercing it', () => {
    // Case and whitespace are the realistic ways a hand-edited settings row
    // goes wrong.
    expect(pickSetting('c', TEMPERATURE_UNITS)).toBeNull();
    expect(pickSetting(' C', TEMPERATURE_UNITS)).toBeNull();
    expect(pickSetting('C ', TEMPERATURE_UNITS)).toBeNull();
  });

  it('rejects the empty string', () => {
    // A cleared settings row is empty, not absent.
    expect(pickSetting('', DATE_FORMATS)).toBeNull();
  });

  it.each(ALL_LISTS)('%s: has no duplicates and is non-empty', (_name, list) => {
    expect(list.length).toBeGreaterThan(0);
    expect(new Set(list).size).toBe(list.length);
  });
});

describe('SettingsContext uses the shared lists on both entry points', () => {
  const ctx = fs.readFileSync(
    path.resolve(process.cwd(), 'src/contexts/SettingsContext.tsx'),
    'utf8',
  );

  /**
   * Every enum setting, with the localStorage key it seeds from. The guard is
   * source-level because the failure being prevented is an omission at the
   * call site, which is exactly what a rendering test would not notice.
   */
  const ENUM_SETTINGS = [
    'temperatureUnit',
    'distanceUnit',
    'positionHistoryLineStyle',
    'preferredSortField',
    'preferredSortDirection',
    'timeFormat',
    'dateFormat',
    'mapPinStyle',
    'mapPinColorMode',
    'nodeListStyle',
    'iconStyle',
    'preferredDashboardSortOption',
  ];

  it('no longer casts a server value straight to its union type', () => {
    // `settings.x as SomeUnion` is the exact shape this change removes.
    const casts = [...ctx.matchAll(/settings\.(\w+) as [A-Z]\w+/g)].map((m) => m[1]);
    const offenders = casts.filter((k) => ENUM_SETTINGS.includes(k) || k === 'nodeHopsCalculation');
    expect(offenders).toEqual([]);
  });

  it.each(ENUM_SETTINGS)('%s: the server-load path goes through pickSetting', (key) => {
    expect(ctx).toContain('pickSetting(settings.' + key);
  });

  it.each(ENUM_SETTINGS)('%s: the localStorage seed goes through pickSetting', (key) => {
    // Seeds read the key then resolve it a line or two later. Take the window
    // after the getItem and require the helper inside it, so a seed that
    // reverted to a hand-written comparison fails here.
    const lines = ctx.split('\n');
    const at = lines.findIndex((l) => l.includes("localStorage.getItem('" + key + "')"));
    expect(at, 'no localStorage seed found for ' + key).toBeGreaterThan(-1);
    const window = lines.slice(at, at + 6).join('\n');
    expect(window, key + ' seed does not use pickSetting').toContain('pickSetting(');
  });

  /**
   * Node-display settings seed from `readNodeDisplayLocal`, not
   * `localStorage.getItem`, so the loop above cannot see them — which is
   * exactly how nodeHopsCalculation kept an inline comparison that omitted
   * 'nodeinfo' through the first pass of this change. Reviewed and caught on
   * PR #5261; pinned here so the blind spot does not reopen.
   */
  const NODE_DISPLAY_ENUM_SETTINGS = ['nodeHopsCalculation'];

  it.each(NODE_DISPLAY_ENUM_SETTINGS)('%s: every read goes through pickSetting', (key) => {
    const lines = ctx.split('\n');
    const reads = lines
      .map((l, n) => ({ l, n }))
      .filter(({ l }) => l.includes(`readNodeDisplayLocal(sourceId, '${key}')`));
    expect(reads.length, `no readNodeDisplayLocal seed found for ${key}`).toBeGreaterThan(0);
    for (const { n } of reads) {
      const window = lines.slice(n, n + 6).join('\n');
      expect(window, `${key} read at line ${n + 1} does not use pickSetting`).toContain('pickSetting(');
    }
  });

  it('keeps no second copy of the nodeHopsCalculation values outside settingsEnums', () => {
    // Three hand-written lists existed for this one setting and they
    // disagreed. The shared list is the only place the values belong.
    const hook = fs.readFileSync(
      path.resolve(process.cwd(), 'src/hooks/useNodeDisplaySettings.ts'),
      'utf8',
    );
    expect(hook).not.toContain('VALID_NODE_HOPS_CALCULATIONS');
    expect(hook).toContain('NODE_HOPS_CALCULATIONS');
  });
});
