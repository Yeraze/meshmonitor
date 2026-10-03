/**
 * Coverage Report: cross-source summary (#5560). Pure, client-side, over
 * the already-loaded and already-privacy-filtered reception rows (same rule
 * as `coverageSummary.ts`, COVERAGE_P4_SPEC.md A2): no new fetch, no new
 * privacy surface.
 *
 * A row counts when the server flagged `senderIsOwnSource` — the sender is
 * the local node of another source the viewer can read. Each summary row is
 * one "N fixes from source A heard by receiver R (on source B)".
 */
import type { CoverageReceptionDto, CoverageReceiverKind } from '../types/coverage.js';

export type CoverageCrossSourceTransport = 'rf' | 'mqtt_gateway' | 'mqtt' | 'udp';

export interface CoverageCrossSourceRow {
  /** `${senderSourceId}|${sourceId}|${receiverId}` */
  key: string;
  /** Source A: whose own node sent the fixes. */
  senderSourceId: string;
  senderId: string;
  /** Source B: the source that recorded the receptions. */
  sourceId: string;
  receiverId: string;
  receiverKind: CoverageReceiverKind;
  transport: CoverageCrossSourceTransport;
  /** Distinct packets (fixes) heard. */
  fixes: number;
  receptions: number;
  medianSnr: number | null;
  bestSnr: number | null;
  lastReceivedAt: number;
}

/** Local median: this module stays import-free so report tests that stub `coverageSummary` still work. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

interface Agg {
  row: CoverageCrossSourceRow;
  packetKeys: Set<string>;
  snrs: number[];
}

/** Group cross-source receptions by (sender source, receiving source, receiver). Sorted by fixes, descending. */
export function summarizeCrossSourceCoverage(items: CoverageReceptionDto[]): CoverageCrossSourceRow[] {
  const groups = new Map<string, Agg>();
  for (const item of items) {
    if (!item.senderIsOwnSource || !item.senderSourceId) continue;
    const key = `${item.senderSourceId}|${item.sourceId}|${item.receiverId}`;
    let agg = groups.get(key);
    if (!agg) {
      agg = {
        row: {
          key,
          senderSourceId: item.senderSourceId,
          senderId: item.senderId,
          sourceId: item.sourceId,
          receiverId: item.receiverId,
          receiverKind: item.receiverKind,
          // First reception wins: one receiver on one source always has the same transport.
          transport: item.crossSourceTransport ?? (item.receiverKind === 'mqtt_gateway' ? 'mqtt_gateway' : 'rf'),
          fixes: 0,
          receptions: 0,
          medianSnr: null,
          bestSnr: null,
          lastReceivedAt: 0,
        },
        packetKeys: new Set(),
        snrs: [],
      };
      groups.set(key, agg);
    }
    agg.row.receptions += 1;
    agg.packetKeys.add(item.packetKey);
    if (item.snr != null) agg.snrs.push(item.snr);
    if (item.receivedAt > agg.row.lastReceivedAt) agg.row.lastReceivedAt = item.receivedAt;
  }
  return Array.from(groups.values())
    .map(({ row, packetKeys, snrs }) => ({
      ...row,
      fixes: packetKeys.size,
      medianSnr: median(snrs),
      bestSnr: snrs.length ? Math.max(...snrs) : null,
    }))
    .sort((a, b) => b.fixes - a.fixes || a.key.localeCompare(b.key));
}
