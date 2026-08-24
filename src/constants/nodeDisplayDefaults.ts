/**
 * Node Display settings — the ten per-source keys and their hardcoded
 * defaults (epic #4412 Phase 2 WP1).
 *
 * Isomorphic, zero imports. Lives in `src/constants/` (not
 * `src/server/constants/settings.ts`) because that file is server-only and
 * holds *key allowlists*, not values — Phase 3 needs these defaults in
 * client code, and today the frontend imports only `type` from
 * `src/server/**`. See `src/utils/hopEmoji.ts` for the same "shared rather
 * than server-only" precedent.
 *
 * The interview's "no runtime global fallback" decision (epic doc) means a
 * source with no stored per-source value falls straight through to the
 * hardcoded default here — never to a neighbouring source's value, and
 * never to the legacy un-namespaced global row. This module is the single
 * place those ten literals live; do not hardcode any of them elsewhere.
 */

export const NODE_DISPLAY_SETTING_KEYS = [
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
] as const;
export type NodeDisplaySettingKey = typeof NODE_DISPLAY_SETTING_KEYS[number];

/**
 * Canonical STORED string form of each default. MUST stay byte-identical to
 * `NODE_DISPLAY_SEED` in migration 131 (booleans are '0'/'1', never
 * 'false'/'true' — see the Phase 1 deviations log). Enforced by
 * nodeDisplayDefaults.test.ts; migration 131 must NOT import this (a
 * migration is a statement about a point in time — see 131's file-level
 * comment).
 */
export const NODE_DISPLAY_DEFAULT_STRINGS: Readonly<Record<NodeDisplaySettingKey, string>> = {
  maxNodeAgeHours: '24',
  inactiveNodeThresholdHours: '24',
  inactiveNodeCheckIntervalMinutes: '60',
  inactiveNodeCooldownHours: '24',
  localStatsIntervalMinutes: '15',
  nodeHopsCalculation: 'nodeinfo',
  hideIncompleteNodes: '0',
  nodeDimmingEnabled: '0',
  nodeDimmingStartHours: '1',
  nodeDimmingMinOpacity: '0.3',
};

export const NODE_DISPLAY_NUMERIC_DEFAULTS = {
  maxNodeAgeHours: 24,
  inactiveNodeThresholdHours: 24,
  inactiveNodeCheckIntervalMinutes: 60,
  inactiveNodeCooldownHours: 24,
  localStatsIntervalMinutes: 15,
  nodeDimmingStartHours: 1,
  nodeDimmingMinOpacity: 0.3,
} as const;
export type NodeDisplayNumericKey = keyof typeof NODE_DISPLAY_NUMERIC_DEFAULTS;

export const NODE_DISPLAY_BOOLEAN_DEFAULTS = {
  hideIncompleteNodes: false,
  nodeDimmingEnabled: false,
} as const;
export type NodeDisplayBooleanKey = keyof typeof NODE_DISPLAY_BOOLEAN_DEFAULTS;

export const NODE_DISPLAY_STRING_DEFAULTS = { nodeHopsCalculation: 'nodeinfo' } as const;

/**
 * Accepted ranges. Lifted verbatim from the existing server-side write
 * validation so the read-side clamp and the write-side 400 can never disagree:
 *   maxNodeAgeHours                   settingsRoutes.ts (reads this range)  1..720
 *   inactiveNodeThresholdHours        settingsRoutes.ts:363-368   1..720
 *   inactiveNodeCheckIntervalMinutes  settingsRoutes.ts:370-377   1..1440
 *   inactiveNodeCooldownHours         settingsRoutes.ts:379-384   1..720
 *   localStatsIntervalMinutes         meshtasticManager.setLocalStatsInterval  0..60 (0 = disabled)
 *
 * `nodeDimmingStartHours` and `nodeDimmingMinOpacity` deliberately have NO
 * entry: no backend reads them and no authoritative server-side range exists
 * today. Phase 3 adds theirs from the SettingsTab inputs.
 */
export const NODE_DISPLAY_RANGES: Readonly<Partial<Record<
  NodeDisplayNumericKey, { min: number; max: number; integer: boolean }
>>> = {
  maxNodeAgeHours:                  { min: 1, max: 720,  integer: true },
  inactiveNodeThresholdHours:       { min: 1, max: 720,  integer: true },
  inactiveNodeCheckIntervalMinutes: { min: 1, max: 1440, integer: true },
  inactiveNodeCooldownHours:        { min: 1, max: 720,  integer: true },
  localStatsIntervalMinutes:        { min: 0, max: 60,   integer: true },
};

/**
 * Parse a stored value into a usable number. null/empty/NaN/out-of-range all
 * resolve to the hardcoded default — never to a neighbouring source's value and
 * never to the legacy global row (the interview's "no runtime global fallback"
 * decision). Keys with no range entry are parsed but not bounds-checked.
 *
 * Intentional behaviour change vs. the pre-Phase-2 `parseInt(raw) || 24`
 * pattern: today a stored `'0'` becomes 24 (via `||`) but a stored `'-5'`
 * stays `-5` and inverts every `Date.now() - h*3600e3` window. This clamps
 * out-of-range to the default, matching Phase 1's write validation.
 */
export function parseNodeDisplayNumber(
  key: NodeDisplayNumericKey,
  raw: string | null | undefined,
): number {
  const fallback = NODE_DISPLAY_NUMERIC_DEFAULTS[key];
  if (raw === null || raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const range = NODE_DISPLAY_RANGES[key];
  if (range && (n < range.min || n > range.max)) return fallback;
  return n;
}

/**
 * Infrastructure age cutoff (#4899). A SECOND per-source age window, applied
 * only to MeshCore repeaters and room servers (advType 2/3). Kept deliberately
 * OUTSIDE the frozen ten-key Node Display seed (NODE_DISPLAY_SETTING_KEYS +
 * migration 131) so those remain byte-identical — this is a later, standalone
 * per-source setting that falls through to the default below when unstored
 * (no seed migration needed; parity with the "no runtime global fallback"
 * rule above).
 *
 * Default 720h = 30 days: repeaters re-flood-advertise on a long, often
 * multi-day interval and never send DMs, so a stale `lastHeard` doesn't mean
 * the node left the mesh. `0` = never expire (the escape hatch). Range allows
 * up to a year so operators can pick anything between "same as companions"
 * and "effectively forever".
 */
export const MAX_INFRA_NODE_AGE_HOURS_DEFAULT = 720;
export const MAX_INFRA_NODE_AGE_HOURS_RANGE = { min: 0, max: 8760, integer: true } as const;

/**
 * Parse a stored `maxInfraNodeAgeHours` into a usable number. null/empty/NaN/
 * out-of-range → the default. `0` is a valid stored value meaning "never
 * expire" and is preserved (it is inside the [0, 8760] range).
 */
export function parseMaxInfraNodeAgeHours(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw === '') return MAX_INFRA_NODE_AGE_HOURS_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return MAX_INFRA_NODE_AGE_HOURS_DEFAULT;
  if (n < MAX_INFRA_NODE_AGE_HOURS_RANGE.min || n > MAX_INFRA_NODE_AGE_HOURS_RANGE.max) {
    return MAX_INFRA_NODE_AGE_HOURS_DEFAULT;
  }
  return Math.trunc(n);
}

/** '1' | 'true' → true; '0' | 'false' → false; anything else → the default. */
export function parseNodeDisplayBoolean(
  key: NodeDisplayBooleanKey,
  raw: string | null | undefined,
): boolean {
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return NODE_DISPLAY_BOOLEAN_DEFAULTS[key];
}
