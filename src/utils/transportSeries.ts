/**
 * Contract between the transport-traffic writer and the charts (#5101 Phase 3).
 *
 * MeshMonitor computes two per-transport time series — "nodes heard" and
 * "packets RX" — from data it already has (node transport stamps, migration
 * 126, and a receive-seam counter), in fixed 5-minute bins. This module is
 * pure (no DB, no React) so both the server writer
 * (`src/server/services/transportTrafficService.ts`) and the client charts
 * (`TransportSeriesGraphs.tsx` / `TransportSeriesChart.tsx`) import the same
 * constants and helpers rather than re-deriving them.
 *
 * See `docs/internal/dev-notes/TRANSPORT_BREAKDOWN_P3_SPEC.md` §3.2 for the
 * design this file implements, and §9 for the binding decisions (D2 bin
 * length, D3 nodes-heard semantics, D5 chart shapes).
 */

import type { NodeTransportClass } from './nodeTransport.js';

/** Bin length for the computed series (#5101 P3, user decision D2). Wall-clock aligned. */
export const TRANSPORT_SERIES_BIN_MS = 5 * 60 * 1000;

/** How often the in-progress bin's packet counts are checkpointed to the DB. */
export const TRANSPORT_CHECKPOINT_INTERVAL_MS = 30 * 1000;

/** Per-source settings key holding the checkpoint (server-managed, not POST-able). */
export const TRANSPORT_CHECKPOINT_SETTING_KEY = 'transportTrafficCheckpoint';

export type TransportSeriesKind = 'nodesHeard' | 'packetsRx';

/** Stored telemetry type name for each (kind, transport class) pair. */
export const TRANSPORT_SERIES_TYPES: Record<TransportSeriesKind, Record<NodeTransportClass, string>> = {
  nodesHeard: { rf: 'systemNodesHeardRf', udp: 'systemNodesHeardUdp', mqtt: 'systemNodesHeardMqtt' },
  packetsRx: { rf: 'systemPacketsRxRf', udp: 'systemPacketsRxUdp', mqtt: 'systemPacketsRxMqtt' },
};

/** Every stored component type, flattened, for RAW_VALUE_TYPES / category maps / filters. */
export const TRANSPORT_SERIES_COMPONENT_TYPES: readonly string[] = [
  TRANSPORT_SERIES_TYPES.nodesHeard.rf,
  TRANSPORT_SERIES_TYPES.nodesHeard.udp,
  TRANSPORT_SERIES_TYPES.nodesHeard.mqtt,
  TRANSPORT_SERIES_TYPES.packetsRx.rf,
  TRANSPORT_SERIES_TYPES.packetsRx.udp,
  TRANSPORT_SERIES_TYPES.packetsRx.mqtt,
];

/** Pseudo favorite type for the combined "nodes heard by transport" chart. */
export const TRANSPORT_NODES_HEARD_TYPE = 'transportNodesHeard';
/** Pseudo favorite type for the combined "packets RX by transport" chart. */
export const TRANSPORT_PACKETS_RX_TYPE = 'transportPacketsRx';

/** Pseudo type -> the series kind it renders (favorites star one of these, not a stored type). */
export const TRANSPORT_SERIES_PSEUDO_TYPES: Record<string, TransportSeriesKind> = {
  [TRANSPORT_NODES_HEARD_TYPE]: 'nodesHeard',
  [TRANSPORT_PACKETS_RX_TYPE]: 'packetsRx',
};

/** True for one of the two pseudo (favoritable, chart-only) types. */
export function isTransportSeriesType(t: string): boolean {
  return Object.prototype.hasOwnProperty.call(TRANSPORT_SERIES_PSEUDO_TYPES, t);
}

/** True for one of the six stored component telemetry types. */
export function isTransportSeriesComponentType(t: string): boolean {
  return (TRANSPORT_SERIES_COMPONENT_TYPES as string[]).includes(t);
}

/** Per-transport-class counts for one bin. */
export interface TransportCounts {
  rf: number;
  udp: number;
  mqtt: number;
}

/** Floor `ms` to the start of its 5-minute bin. */
export function binStartOf(ms: number): number {
  return Math.floor(ms / TRANSPORT_SERIES_BIN_MS) * TRANSPORT_SERIES_BIN_MS;
}

/**
 * Bin index for a bin's END timestamp, used as the row's synthetic
 * `packetId` so a second write of the same bin is a no-op through the
 * migration 032 unique index (sourceId, nodeNum, packetId, telemetryType).
 */
export function transportBinIndex(binEndMs: number): number {
  return Math.floor(binEndMs / TRANSPORT_SERIES_BIN_MS);
}

export interface BuildTransportSeriesRowsArgs {
  nodeId: string;
  nodeNum: number;
  binEndMs: number;
  nowMs: number;
  nodesHeard: TransportCounts;
  packetsRx: TransportCounts;
}

export interface TransportSeriesRow {
  nodeId: string;
  nodeNum: number;
  telemetryType: string;
  timestamp: number;
  value: number;
  createdAt: number;
  packetId: number;
}

const TRANSPORT_CLASSES: readonly NodeTransportClass[] = ['rf', 'udp', 'mqtt'];

/**
 * Build the six telemetry rows for one source and one closed bin. Pure —
 * the caller (the writer service) is responsible for actually inserting
 * them via `insertTelemetryAsync`.
 */
export function buildTransportSeriesRows(args: BuildTransportSeriesRowsArgs): TransportSeriesRow[] {
  const { nodeId, nodeNum, binEndMs, nowMs, nodesHeard, packetsRx } = args;
  const packetId = transportBinIndex(binEndMs);
  const rows: TransportSeriesRow[] = [];
  for (const cls of TRANSPORT_CLASSES) {
    rows.push({
      nodeId,
      nodeNum,
      telemetryType: TRANSPORT_SERIES_TYPES.nodesHeard[cls],
      timestamp: binEndMs,
      value: nodesHeard[cls],
      createdAt: nowMs,
      packetId,
    });
  }
  for (const cls of TRANSPORT_CLASSES) {
    rows.push({
      nodeId,
      nodeNum,
      telemetryType: TRANSPORT_SERIES_TYPES.packetsRx[cls],
      timestamp: binEndMs,
      value: packetsRx[cls],
      createdAt: nowMs,
      packetId,
    });
  }
  return rows;
}

/** Checkpoint codec version. Bump if the shape ever changes incompatibly. */
const CHECKPOINT_VERSION = 1 as const;

/** Checkpoint of the bin currently in progress, persisted every 30s + on graceful stop. */
export interface TransportCheckpoint {
  v: typeof CHECKPOINT_VERSION;
  binStartMs: number;
  nodeId: string;
  nodeNum: number;
  rf: number;
  udp: number;
  mqtt: number;
}

export function encodeTransportCheckpoint(cp: TransportCheckpoint): string {
  return JSON.stringify(cp);
}

function isFiniteNonNegativeInteger(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && Number.isFinite(n) && n >= 0;
}

/**
 * Decode a persisted checkpoint. Never throws — returns null for bad JSON,
 * the wrong `v`, a `binStartMs` not aligned to the bin boundary, or counts
 * that are not finite non-negative integers. Callers (the writer's `start()`)
 * log at `warn` and treat null as "nothing to restore".
 */
export function decodeTransportCheckpoint(raw: string | null | undefined): TransportCheckpoint | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const cp = parsed as Record<string, unknown>;
  if (cp.v !== CHECKPOINT_VERSION) return null;
  if (typeof cp.binStartMs !== 'number' || !Number.isFinite(cp.binStartMs)) return null;
  if (cp.binStartMs !== binStartOf(cp.binStartMs)) return null;
  if (typeof cp.nodeId !== 'string' || cp.nodeId.length === 0) return null;
  if (!isFiniteNonNegativeInteger(cp.nodeNum)) return null;
  if (!isFiniteNonNegativeInteger(cp.rf)) return null;
  if (!isFiniteNonNegativeInteger(cp.udp)) return null;
  if (!isFiniteNonNegativeInteger(cp.mqtt)) return null;
  return {
    v: CHECKPOINT_VERSION,
    binStartMs: cp.binStartMs,
    nodeId: cp.nodeId,
    nodeNum: cp.nodeNum,
    rf: cp.rf,
    udp: cp.udp,
    mqtt: cp.mqtt,
  };
}

/** One reshaped chart point: null for a transport class with no row in this bin. */
export interface TransportChartRow {
  timestamp: number;
  rf: number | null;
  udp: number | null;
  mqtt: number | null;
}

export interface ToTransportChartRowsResult {
  rows: TransportChartRow[];
  averaged: boolean;
}

const DEFAULT_MAX_POINTS = 500;

/**
 * Reshape fetched telemetry rows (one row per (timestamp, class)) into chart
 * rows keyed by timestamp, for the given series kind. Rows of any other
 * telemetryType are ignored (so both `nodesHeard` and `packetsRx` component
 * types can be fetched together and split client-side).
 *
 * When the resulting row count exceeds `maxPoints`, adjacent bins are
 * averaged down to (approximately) that many points so the unit stays
 * "per 5-minute slot", and `averaged: true` is returned.
 */
export function toTransportChartRows(
  rows: Array<{ telemetryType: string; timestamp: number; value: number }>,
  kind: TransportSeriesKind,
  maxPoints: number = DEFAULT_MAX_POINTS,
): ToTransportChartRowsResult {
  const typeToClass = new Map<string, NodeTransportClass>();
  for (const cls of TRANSPORT_CLASSES) {
    typeToClass.set(TRANSPORT_SERIES_TYPES[kind][cls], cls);
  }

  const byTimestamp = new Map<number, { rf: number | null; udp: number | null; mqtt: number | null }>();
  for (const row of rows) {
    const cls = typeToClass.get(row.telemetryType);
    if (!cls) continue;
    let entry = byTimestamp.get(row.timestamp);
    if (!entry) {
      entry = { rf: null, udp: null, mqtt: null };
      byTimestamp.set(row.timestamp, entry);
    }
    entry[cls] = row.value;
  }

  const sortedTimestamps = Array.from(byTimestamp.keys()).sort((a, b) => a - b);
  const rawRows: TransportChartRow[] = sortedTimestamps.map((timestamp) => ({
    timestamp,
    ...byTimestamp.get(timestamp)!,
  }));

  if (rawRows.length <= maxPoints || maxPoints <= 0) {
    return { rows: rawRows, averaged: false };
  }

  // Average adjacent bins down to ~maxPoints groups, preserving order.
  const groupSize = Math.ceil(rawRows.length / maxPoints);
  const averagedRows: TransportChartRow[] = [];
  for (let i = 0; i < rawRows.length; i += groupSize) {
    const group = rawRows.slice(i, i + groupSize);
    const avg = (values: Array<number | null>): number | null => {
      const present = values.filter((v): v is number => v !== null);
      if (present.length === 0) return null;
      return present.reduce((a, b) => a + b, 0) / present.length;
    };
    averagedRows.push({
      // Use the last bin's timestamp in the group so the X axis reflects
      // "as of" this point in time, matching the raw series' bin-end convention.
      timestamp: group[group.length - 1].timestamp,
      rf: avg(group.map((g) => g.rf)),
      udp: avg(group.map((g) => g.udp)),
      mqtt: avg(group.map((g) => g.mqtt)),
    });
  }

  return { rows: averagedRows, averaged: true };
}
