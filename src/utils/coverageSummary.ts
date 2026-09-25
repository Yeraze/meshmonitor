/**
 * Coverage Report summary stats (#5277 Phase 4a WP1).
 *
 * Pure aggregation over already-loaded, already-privacy-filtered
 * `CoverageReceptionDto` rows (`useCoverageReceptions`'s `items`). No new
 * fetch, no server round trip. See `COVERAGE_P4_SPEC.md` §2a.3.
 *
 * `src/utils/**` is in `tsconfig.server.json`'s include set, so relative
 * imports need an explicit `.js` extension (#4596).
 */
import type { CoverageReceiverKind, CoverageReceptionDto } from '../types/coverage.js';
import type {
  CoverageDistancePoint,
  CoverageReceiverStat,
  CoverageSummary,
} from '../types/coverageAnalysis.js';
import { calculateDistance } from './distance.js';
import { receiverKey } from './coverageReceiverFilter.js';

/**
 * The median of the finite values in `values`, or `null` for an empty (or
 * all-non-finite) input. Even-length arrays average the two middle values.
 */
export function median(values: number[]): number | null {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;
  const sorted = [...finite].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

interface ReceiverAggregate {
  sourceId: string;
  receiverId: string;
  receiverKind: CoverageReceiverKind;
  fixKeys: Set<string>;
  snrValues: number[];
  furthestDirectM: number | null;
}

/**
 * Summarise a set of coverage receptions: overall fix/reception counts,
 * best/worst SNR & RSSI, a per-receiver breakdown, and the direct-reception
 * distance/SNR points used by the distance chart.
 *
 * - `receivers` is sorted by `fixesHeard` descending.
 * - `furthestDirectM` and `distancePoints` use the row's receiver POSITION
 *   SNAPSHOT (`receiverLatitude`/`receiverLongitude`), not the receiver's
 *   current position — correct even for a moving receiver, and already
 *   nulled server-side for a receiver that fails the visibility gate.
 * - Heard-vs-expected and gap count are NOT computed here — they come from
 *   `detectCoverageGaps` (`coverageGaps.ts`), which needs a single-sender,
 *   sorted-by-time view this function does not assume.
 */
export function summarizeCoverage(items: CoverageReceptionDto[]): CoverageSummary {
  const fixKeys = new Set<string>();
  let bestSnr: number | null = null;
  let worstSnr: number | null = null;
  let bestRssi: number | null = null;
  let worstRssi: number | null = null;

  const receiverAggregates = new Map<string, ReceiverAggregate>();
  const distancePoints: CoverageDistancePoint[] = [];

  for (const item of items) {
    fixKeys.add(item.packetKey);

    if (item.snr != null) {
      bestSnr = bestSnr === null ? item.snr : Math.max(bestSnr, item.snr);
      worstSnr = worstSnr === null ? item.snr : Math.min(worstSnr, item.snr);
    }
    if (item.rssi != null) {
      bestRssi = bestRssi === null ? item.rssi : Math.max(bestRssi, item.rssi);
      worstRssi = worstRssi === null ? item.rssi : Math.min(worstRssi, item.rssi);
    }

    const key = receiverKey(item.sourceId, item.receiverId);
    let agg = receiverAggregates.get(key);
    if (!agg) {
      agg = {
        sourceId: item.sourceId,
        receiverId: item.receiverId,
        receiverKind: item.receiverKind,
        fixKeys: new Set<string>(),
        snrValues: [],
        furthestDirectM: null,
      };
      receiverAggregates.set(key, agg);
    }
    agg.fixKeys.add(item.packetKey);
    if (item.snr != null) agg.snrValues.push(item.snr);

    const isDirect = item.hopsAway === 0;
    const hasReceiverPosition = item.receiverLatitude != null && item.receiverLongitude != null;

    if (isDirect && hasReceiverPosition) {
      const distanceM =
        calculateDistance(item.receiverLatitude as number, item.receiverLongitude as number, item.latitude, item.longitude) *
        1000;
      if (agg.furthestDirectM === null || distanceM > agg.furthestDirectM) {
        agg.furthestDirectM = distanceM;
      }
      if (item.snr != null) {
        distancePoints.push({ distanceM, snr: item.snr, receiverKey: key });
      }
    }
  }

  const receivers: CoverageReceiverStat[] = Array.from(receiverAggregates.entries())
    .map(([key, agg]) => ({
      key,
      sourceId: agg.sourceId,
      receiverId: agg.receiverId,
      receiverKind: agg.receiverKind,
      fixesHeard: agg.fixKeys.size,
      medianSnr: median(agg.snrValues),
      furthestDirectM: agg.furthestDirectM,
    }))
    .sort((a, b) => b.fixesHeard - a.fixesHeard);

  return {
    fixesHeard: fixKeys.size,
    receptions: items.length,
    bestSnr,
    worstSnr,
    bestRssi,
    worstRssi,
    receivers,
    distancePoints,
  };
}
