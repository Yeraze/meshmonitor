/**
 * Per-source settings key allowlist invariants (#4412 Phase 1 WP1).
 *
 * `PER_SOURCE_SETTINGS_KEYS` documents which keys the server reads via
 * `getSettingForSource(...)`. Not every one of those keys is POST-able through
 * `POST /api/settings` — some are written exclusively by a dedicated route or
 * by the server itself. A naive `PER_SOURCE_SETTINGS_KEYS ⊆ VALID_SETTINGS_KEYS`
 * assertion FAILS today for exactly that reason (see spec §4.1) — weakening it
 * to a vacuous subset check would hide real regressions, so this file asserts
 * EXACT equality between the computed gap and a documented, named exemption
 * set (`PER_SOURCE_KEYS_NOT_POSTABLE`).
 *
 * See docs/internal/dev-notes/PER_SOURCE_NODE_DISPLAY_PHASE1_SPEC.md §2, §4.
 */
import { describe, it, expect } from 'vitest';
import {
  VALID_SETTINGS_KEYS,
  PER_SOURCE_SETTINGS_KEYS,
  GLOBAL_ONLY_SETTINGS_KEYS,
  PER_SOURCE_KEYS_NOT_POSTABLE,
} from './settings.js';

describe('per-source settings key allowlist invariants', () => {
  it('every per-source key is either POST-able or a documented exemption', () => {
    const valid = new Set<string>(VALID_SETTINGS_KEYS as readonly string[]);
    const missing = PER_SOURCE_SETTINGS_KEYS.filter((k) => !valid.has(k)).sort();
    expect(missing).toEqual([...PER_SOURCE_KEYS_NOT_POSTABLE].sort());
  });

  // §4.2 companion assertion 1: a deny-list entry outside the allowlist is
  // dead weight — it can never match a key in a POST body.
  it('GLOBAL_ONLY_SETTINGS_KEYS is a subset of VALID_SETTINGS_KEYS', () => {
    const valid = new Set<string>(VALID_SETTINGS_KEYS as readonly string[]);
    for (const key of GLOBAL_ONLY_SETTINGS_KEYS) {
      expect(valid.has(key)).toBe(true);
    }
  });

  // §4.2 companion assertion 2: a key in both sets is a direct contradiction
  // — the server reads it per-source AND the deny-list refuses to let it be
  // written per-source. This is the assertion that would catch an over-eager
  // deny-list entry, the one failure mode of the default-allow design.
  it('GLOBAL_ONLY_SETTINGS_KEYS and PER_SOURCE_SETTINGS_KEYS are disjoint', () => {
    const perSource = new Set<string>(PER_SOURCE_SETTINGS_KEYS as readonly string[]);
    const intersection = [...GLOBAL_ONLY_SETTINGS_KEYS].filter((k) => perSource.has(k));
    expect(intersection).toEqual([]);
  });

  // §4.2 companion assertion 3: THE REGRESSION PIN for the §2.1 audit. These
  // ten keys are written by the frontend into a source namespace and read
  // back from the source-scoped GET, but are never read per-source by server
  // code. Under the deny-list design they must stay POST-able per-source —
  // this pins that a future contributor cannot "tidy up" one of them into
  // GLOBAL_ONLY_SETTINGS_KEYS and silently reintroduce the data-loss bug
  // class §2.1 documents.
  it('GLOBAL_ONLY_SETTINGS_KEYS contains none of the client-only per-source keys from §2.1', () => {
    const clientOnlyPerSourceKeys = [
      'telemetryFavorites',
      'telemetryCustomOrder',
      'dashboardWidgets',
      'dashboardSolarVisibility',
      'autoKeyManagementIntervalMinutes',
      'autoKeyManagementMaxExchanges',
      'autoKeyManagementAutoPurge',
      'autoKeyManagementImmediatePurge',
      'remoteAdminScannerExpirationHours',
      'autoAckTestMessages',
    ];
    for (const key of clientOnlyPerSourceKeys) {
      expect(GLOBAL_ONLY_SETTINGS_KEYS.has(key)).toBe(false);
    }
  });

  // §4.2 companion assertion 4: guards the localStatsIntervalMinutes
  // double-add hazard called out in §3.1(a).
  it('has no duplicate entries within PER_SOURCE_SETTINGS_KEYS or VALID_SETTINGS_KEYS', () => {
    const assertNoDuplicates = (keys: readonly string[]) => {
      const seen = new Set<string>();
      const duplicates: string[] = [];
      for (const key of keys) {
        if (seen.has(key)) duplicates.push(key);
        seen.add(key);
      }
      expect(duplicates).toEqual([]);
    };
    assertNoDuplicates(VALID_SETTINGS_KEYS);
    assertNoDuplicates(PER_SOURCE_SETTINGS_KEYS);
  });

  // §4.2 companion assertion 5: pins the whole point of WP1 by literal name
  // so a future refactor cannot quietly un-scope the Node Display group.
  it('all ten Node Display keys are per-source-postable (in both sets, in neither deny-list)', () => {
    const nodeDisplayKeys = [
      'maxNodeAgeHours',
      'inactiveNodeThresholdHours',
      'inactiveNodeCheckIntervalMinutes',
      'inactiveNodeCooldownHours',
      'localStatsIntervalMinutes',
      'nodeHopsCalculation',
      'hideIncompleteNodes',
      'nodeDimmingEnabled',
      'nodeDimmingStartHours',
      'nodeDimmingMinOpacity',
    ];
    const valid = new Set<string>(VALID_SETTINGS_KEYS as readonly string[]);
    const perSource = new Set<string>(PER_SOURCE_SETTINGS_KEYS as readonly string[]);
    for (const key of nodeDisplayKeys) {
      expect(perSource.has(key)).toBe(true);
      expect(valid.has(key)).toBe(true);
      expect(GLOBAL_ONLY_SETTINGS_KEYS.has(key)).toBe(false);
      expect(PER_SOURCE_KEYS_NOT_POSTABLE.has(key)).toBe(false);
    }
  });

  // `localStatsIntervalMinutes` predates this work item (already read
  // per-source); the other nine are new as of #4412 WP1. Pin the exact count
  // so a future edit can't silently add/remove one.
  it('localStatsIntervalMinutes appears exactly once in PER_SOURCE_SETTINGS_KEYS', () => {
    const count = PER_SOURCE_SETTINGS_KEYS.filter((k) => k === 'localStatsIntervalMinutes').length;
    expect(count).toBe(1);
  });

  // Documentation-only guard: PER_SOURCE_KEYS_NOT_POSTABLE was computed, not
  // guessed — spec §3.1(c) predicted 18 keys. Pin the size so a silent drift
  // (e.g. a future PER_SOURCE_SETTINGS_KEYS addition without VALID_SETTINGS_KEYS
  // coverage) surfaces here rather than only in the exact-equality test above.
  it('PER_SOURCE_KEYS_NOT_POSTABLE has the expected size', () => {
    expect(PER_SOURCE_KEYS_NOT_POSTABLE.size).toBe(18);
  });
});
