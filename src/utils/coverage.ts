/**
 * Shared, pure helpers for the Coverage Report epic (#5277, Phase 1 WP1).
 *
 * Used by both the server-side recording hook (WP2,
 * `src/server/meshtasticManager.ts` `maybeRecordCoverageReception`) and the
 * frontend report (WP4, `src/components/Analysis/CoverageReport.tsx` /
 * `CoverageMap.tsx`). Deliberately dependency-free (no `src/server` or
 * `src/components` imports) so either side can pull it in without pulling in
 * the other. `src/utils/**` is included in `tsconfig.server.json`, so any
 * relative import ADDED to this file needs an explicit `.js` extension.
 *
 * See `docs/internal/dev-notes/COVERAGE_P1_SPEC.md` §2.4 and §5 (Decisions
 * D1-D5) for the full rationale.
 */

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

export const COVERAGE_RETENTION_DEFAULT_DAYS = 7;
export const COVERAGE_RETENTION_MIN_DAYS = 1;
export const COVERAGE_RETENTION_MAX_DAYS = 90;

/**
 * Per-source setting that turns on MQTT gateway reception recording (#5277 P2).
 * Off by default. Read it with `getSettingForSource`, never the bare key (#5080).
 */
export const COVERAGE_MQTT_ENABLED_SETTING = 'coverage_mqtt_enabled';

/** True when a stored `coverage_mqtt_enabled` value means "on" ('1' or 'true'). */
export function isCoverageMqttFlagOn(raw: string | null | undefined): boolean {
  return raw === '1' || raw === 'true';
}

/**
 * Clamp a raw (possibly string/undefined/garbage) settings value to a valid
 * retention window in days. Non-finite input (undefined, NaN, an unparsable
 * string) falls back to the default; everything else is clamped to
 * `[COVERAGE_RETENTION_MIN_DAYS, COVERAGE_RETENTION_MAX_DAYS]`.
 *
 * `null` is handled explicitly (WP3 fix, #5277): `databaseService.getSettingAsync`
 * returns `null` — not `undefined` — for a key that has never been saved, and
 * `Number(null)` coerces to `0` (finite), which would otherwise clamp the
 * unset-setting case down to the 1-day minimum instead of the intended 7-day
 * default.
 */
export function clampCoverageRetentionDays(raw: unknown): number {
  if (raw === null || raw === undefined) return COVERAGE_RETENTION_DEFAULT_DAYS;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return COVERAGE_RETENTION_DEFAULT_DAYS;
  return Math.max(
    COVERAGE_RETENTION_MIN_DAYS,
    Math.min(Math.trunc(n), COVERAGE_RETENTION_MAX_DAYS),
  );
}

// ---------------------------------------------------------------------------
// Replay-freshness guard (Decision D1)
// ---------------------------------------------------------------------------

/**
 * How far in the past a reception's plausible `rx_time` can be before it is
 * dropped as a stale replay (e.g. an FW 2.8 PhoneAPI NodeDB replay whose
 * original was never stored — the unique key already collapses replays of
 * rows we DID store).
 */
export const COVERAGE_MAX_RX_AGE_SEC = 600;

/**
 * Smallest `rx_time` treated as a real absolute unix timestamp
 * (~2020-09-13). Mirrors `src/server/utils/replayGuard.ts`'s
 * `MIN_PLAUSIBLE_UNIX_SEC` — duplicated here (rather than imported) so this
 * file stays free of any `src/server` dependency and remains safe to import
 * from the frontend.
 */
const MIN_PLAUSIBLE_UNIX_SEC = 1_600_000_000;

/**
 * True only when `rxTimeSec` is a PLAUSIBLE absolute unix timestamp
 * (`>= MIN_PLAUSIBLE_UNIX_SEC`) that is more than `COVERAGE_MAX_RX_AGE_SEC`
 * older than `nowMs`. An absent, non-finite, or implausible (boot-relative)
 * `rxTime` is never treated as stale — those packets fall through to normal
 * recording, deliberately conservative to avoid false positives.
 */
export function isStaleCoverageRxTime(
  rxTimeSec: number | null | undefined,
  nowMs: number,
): boolean {
  if (rxTimeSec == null || !Number.isFinite(rxTimeSec)) return false;
  if (rxTimeSec < MIN_PLAUSIBLE_UNIX_SEC) return false;
  const nowSec = nowMs / 1000;
  return nowSec - rxTimeSec > COVERAGE_MAX_RX_AGE_SEC;
}

// ---------------------------------------------------------------------------
// Hop semantics (Decision D2)
// ---------------------------------------------------------------------------

export interface ComputeMeshtasticHopsAwayArgs {
  hopStart: number | null | undefined;
  hopLimit: number | null | undefined;
  /**
   * Whether `Data.bitfield` (protobuf field 9, `optional uint32`) is
   * WIRE-PRESENT on this packet — presence, not truthiness. Test with
   * `typeof meshPacket.decoded?.bitfield === 'number'` (a present 0 counts).
   */
  hasBitfield: boolean;
}

/**
 * Derive "hops away" for a Meshtastic packet, mirroring firmware
 * `NodeDB.cpp getHopsAway` (verified in firmware `develop`):
 *
 *  - `hopStart > 0 && hopLimit != null && hopStart >= hopLimit` →
 *    `hopStart - hopLimit`.
 *  - **True zero-hop:** `hopStart === 0 && hopLimit === 0 && hasBitfield` → `0`.
 *  - Anything else → `null` (unknown). This includes 0/0 WITHOUT a bitfield,
 *    which is pre-2.3 firmware with `hop_start` unset — not a genuine
 *    zero-hop origination.
 *
 * `relay_node` cannot make this distinction: the receiver zeroes
 * `relay_node` whenever `hop_start == 0` (`RadioLibInterface.cpp:690-692`),
 * so a zero-hop origin and old firmware are wire-identical on that field.
 * Senders on 2.5.0+ always set `Data.bitfield` on their own packets
 * (`Router.cpp:1249-1250`), which is what makes the bitfield presence check
 * work instead.
 */
export function computeMeshtasticHopsAway(
  args: ComputeMeshtasticHopsAwayArgs,
): number | null {
  const { hopStart, hopLimit, hasBitfield } = args;

  if (
    hopStart != null &&
    hopStart > 0 &&
    hopLimit != null &&
    hopStart >= hopLimit
  ) {
    return hopStart - hopLimit;
  }

  if (hopStart === 0 && hopLimit === 0 && hasBitfield) {
    return 0;
  }

  return null;
}

/**
 * Per-path identity used in the `coverage_receptions` unique key
 * (`pathKey`). Never empty — `relayNode`/`hopsAway` of `null`/`undefined`
 * render as `-`. `relayNode` 0 gives `r0` (the normal key for a genuine
 * zero-hop reception, since 0 is `RadioLibInterface`'s `NO_RELAY_NODE`
 * sentinel as well as a real relay byte value — the path is disambiguated
 * by `hopsAway`, not by treating 0 as "absent").
 */
export function meshtasticPathKey(
  relayNode: number | null | undefined,
  hopsAway: number | null | undefined,
): string {
  const relayPart = relayNode ?? '-';
  const hopsPart = hopsAway ?? '-';
  return `r${relayPart}:h${hopsPart}`;
}

/** `!xxxxxxxx` form of a Meshtastic node number. */
export function nodeNumToId(nodeNum: number): string {
  return '!' + (nodeNum >>> 0).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// RSSI colour bands (Decision D3)
// ---------------------------------------------------------------------------

/**
 * RSSI colour-band thresholds, dBm. `>= excellent` is excellent, `>= good`
 * is good, `>= fair` is fair, anything lower is poor. `null` means no data.
 * Consumed by `rssiToColor` (`src/utils/mapHelpers.tsx`, WP4).
 */
export const COVERAGE_RSSI_BANDS = {
  excellent: -90,
  good: -105,
  fair: -115,
} as const;

// ---------------------------------------------------------------------------
// Fix grouping (Decisions D4/D5)
// ---------------------------------------------------------------------------

export type CoverageMetric = 'snr' | 'rssi';

/** The minimal shape `groupReceptionsIntoFixes` needs from a reception row. */
export interface CoverageReceptionLike {
  senderId: string;
  packetKey: string;
  latitude: number;
  longitude: number;
  receivedAt: number;
  snr: number | null;
  rssi: number | null;
}

export interface CoverageFix<T extends CoverageReceptionLike = CoverageReceptionLike> {
  senderId: string;
  packetKey: string;
  /** From the newest reception in the group. */
  latitude: number;
  longitude: number;
  receivedAt: number;
  /** Sorted by the active metric, descending (nulls last). */
  receptions: T[];
  /** Max SNR across every reception in the group (Decision D4). */
  bestSnr: number | null;
  /** Max RSSI across every reception in the group (Decision D4). */
  bestRssi: number | null;
}

/**
 * Group flat reception rows into per-fix groups, keyed on
 * `${senderId}|${packetKey}` (one physical position fix, possibly heard by
 * several receivers over several paths). Fix `latitude`/`longitude`/
 * `receivedAt` come from the newest row in the group; `receptions` are
 * sorted by `metric` descending (nulls sort last); `bestSnr`/`bestRssi` are
 * the max across ALL receptions in the group regardless of `metric`
 * (Decision D4 — the dot's colour is always the best reception, independent
 * of which metric is currently displayed).
 */
export function groupReceptionsIntoFixes<T extends CoverageReceptionLike>(
  rows: T[],
  metric: CoverageMetric = 'snr',
): Array<CoverageFix<T>> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = `${row.senderId}|${row.packetKey}`;
    const existing = groups.get(key);
    if (existing) {
      existing.push(row);
    } else {
      groups.set(key, [row]);
    }
  }

  const fixes: Array<CoverageFix<T>> = [];
  for (const receptions of groups.values()) {
    let newest = receptions[0];
    let bestSnr: number | null = null;
    let bestRssi: number | null = null;
    for (const r of receptions) {
      if (r.receivedAt > newest.receivedAt) newest = r;
      if (r.snr != null && (bestSnr === null || r.snr > bestSnr)) bestSnr = r.snr;
      if (r.rssi != null && (bestRssi === null || r.rssi > bestRssi)) bestRssi = r.rssi;
    }

    const sorted = [...receptions].sort((a, b) => {
      const av = metric === 'snr' ? a.snr : a.rssi;
      const bv = metric === 'snr' ? b.snr : b.rssi;
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return bv - av;
    });

    fixes.push({
      senderId: newest.senderId,
      packetKey: newest.packetKey,
      latitude: newest.latitude,
      longitude: newest.longitude,
      receivedAt: newest.receivedAt,
      receptions: sorted,
      bestSnr,
      bestRssi,
    });
  }
  return fixes;
}
