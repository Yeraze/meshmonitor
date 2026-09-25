/**
 * Coverage Report "likely gap" detection (#5277 Phase 4a WP1).
 *
 * Pure, dependency-light (only `./distance.js` and `./coverage.js`), so it
 * can run client-side over whatever fixes the report currently shows. See
 * `docs/internal/dev-notes/COVERAGE_P4_SPEC.md` §2a.2 and Decision U1 for the
 * full rule and rationale. Every threshold used here lives in
 * `src/utils/coverage.ts` — do not hardcode a number in this file.
 *
 * `src/utils/**` is in `tsconfig.server.json`'s include set, so relative
 * imports need an explicit `.js` extension (#4596).
 */
import type { CoverageProtocol } from '../types/coverage.js';
import type {
  CoverageGap,
  CoverageGapResult,
  GapFixInput,
  IntervalSource,
} from '../types/coverageAnalysis.js';
import { calculateDistance } from './distance.js';
import {
  COVERAGE_DEFAULT_INTERVAL_SEC,
  COVERAGE_GAP_FACTOR,
  COVERAGE_GAP_MAX_SEC,
  COVERAGE_GAP_MIN_DISTANCE_M,
  COVERAGE_GAP_MIN_SEC,
  COVERAGE_INTERVAL_CLAMP_SEC,
  COVERAGE_INTERVAL_MIN_SAMPLES,
} from './coverage.js';

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Linear-interpolation percentile (Excel `PERCENTILE.INC` method) over an
 * ASCENDING-sorted array. `p` is 0-100. Deterministic, no randomness.
 */
function percentile(sortedAscending: number[], p: number): number {
  if (sortedAscending.length === 0) return 0;
  if (sortedAscending.length === 1) return sortedAscending[0];
  const idx = (p / 100) * (sortedAscending.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sortedAscending[lower];
  const frac = idx - lower;
  return sortedAscending[lower] + (sortedAscending[upper] - sortedAscending[lower]) * frac;
}

/**
 * Estimate the expected spacing between fixes for one sender.
 *
 * - A configured interval (P4b survey `intervalSec`) always wins, source
 *   `'configured'`.
 * - Otherwise, with at least `COVERAGE_INTERVAL_MIN_SAMPLES` usable deltas
 *   (>= 1s, sub-second noise ignored), the 25th percentile of the deltas,
 *   clamped to `COVERAGE_INTERVAL_CLAMP_SEC`, source `'observed'`. P25 (not
 *   the median) because gaps inflate the upper half of the delta
 *   distribution — the fastest quarter of spacings is where the node was
 *   heard every time.
 * - Otherwise the protocol default (Meshtastic 30s, MeshCore 60s), source
 *   `'default'`.
 */
export function estimateIntervalSec(
  deltasSec: number[],
  protocol: CoverageProtocol,
  configuredSec?: number | null,
): { intervalSec: number; source: IntervalSource } {
  if (configuredSec != null && Number.isFinite(configuredSec) && configuredSec > 0) {
    return { intervalSec: configuredSec, source: 'configured' };
  }

  const usable = deltasSec.filter((d) => Number.isFinite(d) && d >= 1);
  if (usable.length >= COVERAGE_INTERVAL_MIN_SAMPLES) {
    const sorted = [...usable].sort((a, b) => a - b);
    const p25 = percentile(sorted, 25);
    const intervalSec = clamp(p25, COVERAGE_INTERVAL_CLAMP_SEC.min, COVERAGE_INTERVAL_CLAMP_SEC.max);
    return { intervalSec, source: 'observed' };
  }

  return { intervalSec: COVERAGE_DEFAULT_INTERVAL_SEC[protocol], source: 'default' };
}

function toGapFixInput(fix: GapFixInput): GapFixInput {
  return {
    packetKey: fix.packetKey,
    firstReceivedAt: fix.firstReceivedAt,
    latitude: fix.latitude,
    longitude: fix.longitude,
  };
}

/**
 * Detect "likely gaps" (dead zones) across a single sender's fixes. The
 * caller passes exactly the fixes the report currently shows (already
 * filtered by receiver selection and time window) — "any receiver in scope"
 * comes for free: untick a receiver and its contribution just isn't in
 * `fixes` any more.
 *
 * Rule (Decision U1, `COVERAGE_P4_SPEC.md` §2a.2):
 * 1. Sort by `firstReceivedAt`; drop exact duplicate `packetKey`s.
 * 2. `delta_i = (t[i+1] - t[i]) / 1000` seconds.
 * 3. Estimate the interval via {@link estimateIntervalSec}.
 * 4. A spacing is a gap when: `delta > max(GAP_FACTOR * interval, GAP_MIN_SEC)`,
 *    `delta <= GAP_MAX_SEC` (longer counts as a `breaks`, not drawn), and the
 *    sender moved `>= GAP_MIN_DISTANCE_M` between the two fixes (a stationary
 *    pause is not a dead zone — Meshtastic's smart-position logic sends
 *    nothing while still).
 * 5. `missedEstimate = max(1, round(delta / interval) - 1)`;
 *    `expected = heard + sum(missedEstimate)`.
 */
export function detectCoverageGaps(
  fixes: GapFixInput[],
  opts: { protocol: CoverageProtocol; configuredIntervalSec?: number | null },
): CoverageGapResult {
  const seenPacketKeys = new Set<string>();
  const deduped: GapFixInput[] = [];
  for (const fix of fixes) {
    if (seenPacketKeys.has(fix.packetKey)) continue;
    seenPacketKeys.add(fix.packetKey);
    deduped.push(fix);
  }

  const sorted = [...deduped].sort((a, b) => a.firstReceivedAt - b.firstReceivedAt);
  const heard = sorted.length;

  const deltas: number[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    deltas.push((sorted[i + 1].firstReceivedAt - sorted[i].firstReceivedAt) / 1000);
  }

  const { intervalSec, source } = estimateIntervalSec(deltas, opts.protocol, opts.configuredIntervalSec);
  const gapThresholdSec = Math.max(COVERAGE_GAP_FACTOR * intervalSec, COVERAGE_GAP_MIN_SEC);

  const gaps: CoverageGap[] = [];
  let breaks = 0;
  let missedTotal = 0;

  for (let i = 0; i < sorted.length - 1; i++) {
    const from = sorted[i];
    const to = sorted[i + 1];
    const delta = deltas[i];

    if (delta > COVERAGE_GAP_MAX_SEC) {
      // Longer than a dead zone plausibly explains: a session break (drive
      // paused, node powered off). Counted, not drawn.
      breaks += 1;
      continue;
    }

    if (delta <= gapThresholdSec) continue;

    const distanceM = calculateDistance(from.latitude, from.longitude, to.latitude, to.longitude) * 1000;
    if (distanceM < COVERAGE_GAP_MIN_DISTANCE_M) continue;

    const missedEstimate = Math.max(1, Math.round(delta / intervalSec) - 1);
    missedTotal += missedEstimate;
    gaps.push({
      from: toGapFixInput(from),
      to: toGapFixInput(to),
      durationSec: delta,
      distanceM,
      missedEstimate,
    });
  }

  return {
    intervalSec,
    intervalSource: source,
    gaps,
    breaks,
    heard,
    expected: heard + missedTotal,
  };
}
