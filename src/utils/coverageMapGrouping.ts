/**
 * Pure cross-source grouping helpers for `CoverageMap` (#5277 Phase 2 WP4,
 * spec §2.9 / Decision D7). A physical gateway can appear once per MQTT
 * source that uplinks its packets, so both the marker layer and the fix
 * popup must collapse those duplicates by `receiverKind|receiverId` —
 * NOT by the `(sourceId, receiverId)` composite key the filter/query layer
 * uses (carry-over a) — since here the goal is "one physical station", not
 * "one row per source".
 */
import type { CoverageReceiverDto, CoverageReceptionDto } from '../types/coverage.js';
import { receiverKey } from './coverageReceiverFilter.js';

/** Groups a physical receiver regardless of which source(s) reported it. */
export function physicalReceiverKey(receiverKind: string, receiverId: string): string {
  return `${receiverKind}|${receiverId}`;
}

export interface DedupedReceiverMarker {
  key: string; // physicalReceiverKey
  receiverKind: CoverageReceiverDto['receiverKind'];
  receiverId: string;
  latitude: number;
  longitude: number;
  label: string;
  lastReceivedAt: number;
  /** Every source this physical gateway was seen through, for reference. */
  sourceIds: string[];
}

/**
 * One marker per physical gateway: among the source-scoped rows for a given
 * `receiverKind|receiverId`, keep the position/name from whichever has a
 * position and the newest `lastReceivedAt` (spec §2.9). A physical receiver
 * with no positioned row anywhere is dropped — nothing to plot.
 */
export function dedupeReceiverMarkers(receivers: CoverageReceiverDto[]): DedupedReceiverMarker[] {
  const groups = new Map<string, { best: CoverageReceiverDto | null; sourceIds: string[] }>();

  for (const r of receivers) {
    const key = physicalReceiverKey(r.receiverKind, r.receiverId);
    let group = groups.get(key);
    if (!group) {
      group = { best: null, sourceIds: [] };
      groups.set(key, group);
    }
    group.sourceIds.push(r.sourceId);
    if (r.latitude == null || r.longitude == null) continue;
    if (group.best == null || r.lastReceivedAt > group.best.lastReceivedAt) {
      group.best = r;
    }
  }

  const markers: DedupedReceiverMarker[] = [];
  for (const [key, group] of groups) {
    if (!group.best) continue;
    const r = group.best;
    markers.push({
      key,
      receiverKind: r.receiverKind,
      receiverId: r.receiverId,
      latitude: r.latitude as number,
      longitude: r.longitude as number,
      label: r.longName || r.shortName || r.receiverId,
      lastReceivedAt: r.lastReceivedAt,
      sourceIds: group.sourceIds,
    });
  }
  return markers;
}

/** Cheap lookup: physical receiver key -> its best-known marker info (name/position). */
export function buildDedupedReceiverIndex(
  markers: DedupedReceiverMarker[],
): Map<string, DedupedReceiverMarker> {
  return new Map(markers.map((m) => [m.key, m] as const));
}

export interface CollapsedPopupReception {
  key: string; // `${receiverKind}|${receiverId}|${pathKey}`
  receiverKind: CoverageReceiverDto['receiverKind'];
  receiverId: string;
  pathKey: string;
  /** Source names this collapsed line was heard through, in a stable order. */
  sourceLabels: string[];
  /** The representative row shown for SNR/RSSI/hop/distance/time — the one
   *  with the best (highest) SNR among the collapsed rows, tie-broken by
   *  `sourceId` ascending for determinism when SNR is equal or null. */
  best: CoverageReceptionDto;
}

/**
 * Collapses one fix's receptions that share `receiverKind|receiverId|pathKey`
 * across sources into a single popup line (spec §2.9) — the same physical
 * reception recorded once per MQTT source that uplinked it.
 * `sourceNameByReceiverKey` is keyed by `receiverKey(sourceId, receiverId)`
 * (the composite key), built by the caller from the `/receivers` list, which
 * is the only place a reception's `sourceId` resolves to a display name.
 */
export function collapseFixReceptionsBySource(
  receptions: CoverageReceptionDto[],
  sourceNameByReceiverKey: Map<string, string>,
): CollapsedPopupReception[] {
  const groups = new Map<string, { rows: CoverageReceptionDto[] }>();
  const order: string[] = [];

  for (const r of receptions) {
    const key = `${r.receiverKind}|${r.receiverId}|${r.pathKey}`;
    let group = groups.get(key);
    if (!group) {
      group = { rows: [] };
      groups.set(key, group);
      order.push(key);
    }
    group.rows.push(r);
  }

  return order.map((key) => {
    const { rows } = groups.get(key) as { rows: CoverageReceptionDto[] };
    const sorted = [...rows].sort((a, b) => {
      const av = a.snr;
      const bv = b.snr;
      if (av == null && bv == null) return a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (bv !== av) return bv - av;
      return a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0;
    });
    const best = sorted[0];

    const seenSources = new Set<string>();
    const sourceLabels: string[] = [];
    for (const row of rows) {
      if (seenSources.has(row.sourceId)) continue;
      seenSources.add(row.sourceId);
      sourceLabels.push(sourceNameByReceiverKey.get(receiverKey(row.sourceId, row.receiverId)) ?? row.sourceId);
    }

    return {
      key,
      receiverKind: best.receiverKind,
      receiverId: best.receiverId,
      pathKey: best.pathKey,
      sourceLabels,
      best,
    };
  });
}
