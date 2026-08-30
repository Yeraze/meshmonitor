/**
 * Tests for `resolveThresholds` (#4964, Phase 3 WP1).
 *
 * Covers: defaults from an empty map, clamp-up/clamp-down at every numeric
 * bound, unparseable input falling back to the DEFAULT (not the bound),
 * boolean default-ON semantics (only the exact string 'false' disables), and
 * that the resolved object is a fresh copy each call.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveThresholds,
  DEFAULT_MESH_ISSUE_THRESHOLDS,
  MESH_ISSUE_THRESHOLD_SETTINGS_KEYS,
  AIR_UTIL_TX_PCT_THRESHOLD,
  CHANNEL_UTIL_PCT_THRESHOLD,
  MOBILE_SPAN_METERS,
  ASYMMETRY_DELTA_DB,
  OVER_BROADCAST_INTERVAL_SECONDS,
  AUTO_CLOSE_CLEAN_RUNS,
  ROUTER_CLUSTER_MAX_LINK_KM,
} from './thresholds.js';

describe('resolveThresholds — defaults', () => {
  it('returns every default when given an empty map', () => {
    const resolved = resolveThresholds({});
    expect(resolved).toEqual(DEFAULT_MESH_ISSUE_THRESHOLDS);
  });

  it('DEFAULT_MESH_ISSUE_THRESHOLDS mirrors the code-constant thresholds it replaces', () => {
    expect(DEFAULT_MESH_ISSUE_THRESHOLDS.airUtilTxPct).toBe(AIR_UTIL_TX_PCT_THRESHOLD);
    expect(DEFAULT_MESH_ISSUE_THRESHOLDS.channelUtilPct).toBe(CHANNEL_UTIL_PCT_THRESHOLD);
    expect(DEFAULT_MESH_ISSUE_THRESHOLDS.mobileSpanMeters).toBe(MOBILE_SPAN_METERS);
    expect(DEFAULT_MESH_ISSUE_THRESHOLDS.snrAsymmetryDb).toBe(ASYMMETRY_DELTA_DB);
    expect(DEFAULT_MESH_ISSUE_THRESHOLDS.overBroadcastSeconds).toBe(OVER_BROADCAST_INTERVAL_SECONDS);
    expect(DEFAULT_MESH_ISSUE_THRESHOLDS.autoCloseCleanRuns).toBe(AUTO_CLOSE_CLEAN_RUNS);
    expect(DEFAULT_MESH_ISSUE_THRESHOLDS.routerClusterMaxLinkKm).toBe(ROUTER_CLUSTER_MAX_LINK_KM);
  });

  it('returns a fresh object each call — mutating the result never affects the shared default', () => {
    const resolved = resolveThresholds({});
    (resolved as { airUtilTxPct: number }).airUtilTxPct = 999;
    expect(DEFAULT_MESH_ISSUE_THRESHOLDS.airUtilTxPct).toBe(AIR_UTIL_TX_PCT_THRESHOLD);

    const resolvedAgain = resolveThresholds({});
    expect(resolvedAgain.airUtilTxPct).toBe(AIR_UTIL_TX_PCT_THRESHOLD);
    expect(resolvedAgain).not.toBe(resolved);
  });
});

describe('resolveThresholds — numeric clamps', () => {
  const cases: Array<{
    key: (typeof MESH_ISSUE_THRESHOLD_SETTINGS_KEYS)[number];
    field: keyof typeof DEFAULT_MESH_ISSUE_THRESHOLDS;
    min: number;
    max: number;
  }> = [
    { key: 'mesh_issues_air_util_tx_pct', field: 'airUtilTxPct', min: 1, max: 50 },
    { key: 'mesh_issues_channel_util_pct', field: 'channelUtilPct', min: 5, max: 100 },
    { key: 'mesh_issues_mobile_span_meters', field: 'mobileSpanMeters', min: 50, max: 50_000 },
    { key: 'mesh_issues_snr_asymmetry_db', field: 'snrAsymmetryDb', min: 1, max: 30 },
    { key: 'mesh_issues_over_broadcast_seconds', field: 'overBroadcastSeconds', min: 30, max: 3600 },
    { key: 'mesh_issues_auto_close_runs', field: 'autoCloseCleanRuns', min: 1, max: 20 },
    { key: 'mesh_issues_router_cluster_max_link_km', field: 'routerClusterMaxLinkKm', min: 1, max: 500 },
  ];

  for (const { key, field, min, max } of cases) {
    describe(key, () => {
      it(`clamps a too-small value UP to the minimum (${min})`, () => {
        const resolved = resolveThresholds({ [key]: String(min - 1000) });
        expect(resolved[field]).toBe(min);
      });

      it(`clamps a too-large value DOWN to the maximum (${max})`, () => {
        const resolved = resolveThresholds({ [key]: String(max + 1_000_000) });
        expect(resolved[field]).toBe(max);
      });

      it('falls back to the DEFAULT (not a bound) for unparseable input', () => {
        const resolved = resolveThresholds({ [key]: 'not-a-number' });
        expect(resolved[field]).toBe(DEFAULT_MESH_ISSUE_THRESHOLDS[field]);
      });

      it('falls back to the DEFAULT when the key is absent', () => {
        const resolved = resolveThresholds({});
        expect(resolved[field]).toBe(DEFAULT_MESH_ISSUE_THRESHOLDS[field]);
      });

      it('passes a valid in-range value through unchanged', () => {
        const mid = Math.round((min + max) / 2);
        const resolved = resolveThresholds({ [key]: String(mid) });
        expect(resolved[field]).toBe(mid);
      });

      it('accepts a raw number as well as a string', () => {
        const mid = Math.round((min + max) / 2);
        const resolved = resolveThresholds({ [key]: mid });
        expect(resolved[field]).toBe(mid);
      });
    });
  }
});

describe('resolveThresholds — boolean default-ON toggles', () => {
  const booleanCases: Array<{
    key: (typeof MESH_ISSUE_THRESHOLD_SETTINGS_KEYS)[number];
    field: 'tierAEnabled' | 'tierBEnabled' | 'tierCEnabled' | 'b7Enabled';
  }> = [
    { key: 'mesh_issues_tier_a_enabled', field: 'tierAEnabled' },
    { key: 'mesh_issues_tier_b_enabled', field: 'tierBEnabled' },
    { key: 'mesh_issues_tier_c_enabled', field: 'tierCEnabled' },
    { key: 'mesh_issues_b7_enabled', field: 'b7Enabled' },
  ];

  for (const { key, field } of booleanCases) {
    describe(key, () => {
      it('defaults to true (enabled) when absent', () => {
        expect(resolveThresholds({})[field]).toBe(true);
      });

      it("disables ONLY on the exact string 'false'", () => {
        expect(resolveThresholds({ [key]: 'false' })[field]).toBe(false);
      });

      it.each([
        ['empty string', ''],
        ['the string zero', '0'],
        ['the string true', 'true'],
        ['undefined', undefined],
        ['null', null],
        ['a random string', 'nope'],
        ['a real boolean false (non-string)', false],
        ['the number 0', 0],
      ])('stays enabled for %s', (_label, value) => {
        expect(resolveThresholds({ [key]: value })[field]).toBe(true);
      });
    });
  }
});

describe('MESH_ISSUE_THRESHOLD_SETTINGS_KEYS', () => {
  it('has exactly eleven entries — one per user-tunable field', () => {
    expect(MESH_ISSUE_THRESHOLD_SETTINGS_KEYS).toHaveLength(11);
  });

  it('every key round-trips through resolveThresholds without throwing', () => {
    const raw: Record<string, unknown> = {};
    for (const key of MESH_ISSUE_THRESHOLD_SETTINGS_KEYS) raw[key] = null;
    expect(() => resolveThresholds(raw)).not.toThrow();
  });
});
