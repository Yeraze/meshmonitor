/**
 * MeshCore adapter for Mesh Issues Analysis (#6263 S5, maintainer decision 6).
 *
 * Pools `meshcore_nodes` rows across every enabled MeshCore source by
 * lowercased public key into the same `PooledNode` shape the Meshtastic rules
 * read, so one rule implementation serves both protocols. MeshCore runs only
 * three checks: A4 (mobile infra), A3's uptime-reset clause, and C2's advert
 * cadence. Every other rule declares `protocols: ['meshtastic']`.
 *
 * Identity is the public key (`mc:<pk>`). The `nodeNum` on a pooled MeshCore
 * node is a run-local NEGATIVE handle that keys the rule maps (telemetry,
 * position span, advert cadence); it cannot collide with a real Meshtastic
 * nodeNum, is never persisted, and findings carry `nodeNum: null`.
 *
 * Pure — no `databaseService` import, no I/O.
 */
import { getEffectiveDbNodePosition } from '../../utils/nodeEnhancer.js';
import {
  MESHCORE_ROUTE_DIRECT,
  MESHCORE_ROUTE_TRANSPORT_DIRECT,
  MESHCORE_ROUTE_FLOOD,
  MESHCORE_ROUTE_TRANSPORT_FLOOD,
} from '../../../utils/coverage.js';
import {
  buildTelemetrySeries,
  type NodeTelemetrySeries,
  type PooledNode,
  type TelemetryRowInput,
} from './nodeSnapshot.js';
import { cadenceStatsFromTimestamps, type CadenceStats } from './rulesTierC.js';

/** MeshCore `advType` values that count as infrastructure: repeater, room server. */
export const MESHCORE_ADV_TYPE_REPEATER = 2;
export const MESHCORE_ADV_TYPE_ROOM_SERVER = 3;
export const MESHCORE_INFRA_ADV_TYPES: ReadonlySet<number> = new Set([
  MESHCORE_ADV_TYPE_REPEATER,
  MESHCORE_ADV_TYPE_ROOM_SERVER,
]);

/** Telemetry type MeshCore status polls write for node uptime (seconds). */
export const MESHCORE_UPTIME_TELEMETRY_TYPE = 'mc_status_uptime_secs';

/** C2 advert cadence (decision 6): a repeater whose median FLOOD advert gap is under 6 h … */
export const MESHCORE_ADVERT_FLOOD_MEDIAN_SECONDS = 6 * 3600;
/** … or whose median ZERO-HOP advert gap is under 60 min is flagged. */
export const MESHCORE_ADVERT_ZEROHOP_MEDIAN_SECONDS = 60 * 60;
/** Min distinct adverts in the window before a median means anything. */
export const MESHCORE_ADVERT_MIN_SAMPLES = 4;
/** Copies of one advert (several observers, several paths) land within this
 *  window and collapse to one. Far below both thresholds above. */
export const MESHCORE_ADVERT_DEDUPE_WINDOW_MS = 60_000;

export interface MeshCoreNodeInput {
  publicKey: string;
  sourceId: string;
  name?: string | null;
  advType?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  positionOverrideEnabled?: boolean | number | null;
  latitudeOverride?: number | null;
  longitudeOverride?: number | null;
  lastHeard?: number | null;
  updatedAt?: number | null;
}

export interface MeshCoreSnapshot {
  /** Keyed by the run-local negative handle. */
  nodes: Map<number, PooledNode>;
  /** lowercased public key -> handle. */
  handleByKey: Map<string, number>;
}

/** MeshCore `lastHeard` is already ms; a seconds-sized value is scaled up. */
function lastHeardMs(row: MeshCoreNodeInput): number | null {
  if (row.lastHeard != null) {
    const v = Number(row.lastHeard);
    return v < 1e12 ? v * 1000 : v;
  }
  if (row.updatedAt != null) return Number(row.updatedAt);
  return null;
}

/**
 * Pool MeshCore node rows by lowercased public key. Newest-heard row wins for
 * name, advType and position (taken as an override-aware pair from one row);
 * `sourceIds` is the sorted union.
 */
export function buildMeshCoreSnapshot(rows: MeshCoreNodeInput[]): MeshCoreSnapshot {
  const groups = new Map<string, MeshCoreNodeInput[]>();
  for (const row of rows) {
    if (!row.publicKey) continue;
    const key = row.publicKey.toLowerCase();
    const g = groups.get(key);
    if (g) g.push(row);
    else groups.set(key, [row]);
  }

  const nodes = new Map<number, PooledNode>();
  const handleByKey = new Map<string, number>();
  let i = 0;
  for (const key of [...groups.keys()].sort()) {
    const groupRows = groups.get(key)!;
    const sorted = [...groupRows].sort((a, b) => {
      const d = (lastHeardMs(b) ?? 0) - (lastHeardMs(a) ?? 0);
      return d !== 0 ? d : String(a.sourceId).localeCompare(String(b.sourceId));
    });
    const handle = -(++i);

    let latitude: number | null = null;
    let longitude: number | null = null;
    for (const r of sorted) {
      const eff = getEffectiveDbNodePosition(r);
      if (eff.latitude != null && eff.longitude != null) {
        latitude = eff.latitude;
        longitude = eff.longitude;
        break;
      }
    }
    const advType = sorted.find((r) => r.advType != null)?.advType ?? null;
    const heard = groupRows.map(lastHeardMs).filter((v): v is number => v != null);

    nodes.set(handle, {
      nodeNum: handle,
      nodeId: `mc:${key}`,
      protocol: 'meshcore',
      nodeKey: key,
      infra: advType != null && MESHCORE_INFRA_ADV_TYPES.has(advType),
      advType,
      longName: sorted.find((r) => r.name)?.name ?? null,
      shortName: null,
      hwModel: null,
      role: null,
      isUnmessagable: false,
      firmwareVersion: null,
      batteryLevel: null,
      voltage: null,
      channelUtilization: null,
      airUtilTx: null,
      latitude,
      longitude,
      positionPrecisionBits: null,
      mobile: false,
      lastHeardMs: heard.length > 0 ? Math.max(...heard) : null,
      sourceIds: Array.from(new Set(groupRows.map((r) => r.sourceId))).sort(),
      isExcessivePackets: false,
      packetRatePerHour: null,
      keyIsLowEntropy: false,
      duplicateKeyDetected: false,
      keyMismatchDetected: false,
      keySecurityIssueDetails: null,
      isTimeOffsetIssue: false,
      timeOffsetSeconds: null,
    });
    handleByKey.set(key, handle);
  }
  return { nodes, handleByKey };
}

export interface MeshCoreUptimeRow {
  /** Node public key (the MeshCore `telemetry.nodeId`). */
  nodeId: string;
  timestamp: number | string;
  value: number;
  sourceId?: string | null;
}

/**
 * Uptime series per MeshCore node for A3's reset clause. Reuses the shared
 * cross-source dedup in `buildTelemetrySeries`; rows for keys not in the
 * snapshot are dropped.
 */
export function buildMeshCoreUptimeSeries(
  rows: MeshCoreUptimeRow[],
  handleByKey: Map<string, number>,
): Map<number, NodeTelemetrySeries> {
  const inputs: TelemetryRowInput[] = [];
  for (const r of rows) {
    const handle = handleByKey.get(String(r.nodeId).toLowerCase());
    if (handle == null) continue;
    inputs.push({
      nodeNum: handle,
      telemetryType: 'uptimeSeconds',
      timestamp: r.timestamp,
      value: r.value,
      sourceId: r.sourceId ?? null,
    });
  }
  return buildTelemetrySeries(inputs);
}

export interface MeshCoreAdvertPacketInput {
  sourceId: string;
  timestamp: number;
  routeType?: number | null;
  hopCount?: number | null;
  senderPubKey?: string | null;
}

export interface MeshCoreAdvertCadence {
  /** Flood-routed adverts (TRANSPORT_FLOOD / FLOOD). */
  flood: CadenceStats | null;
  /** Zero-hop adverts (DIRECT / TRANSPORT_DIRECT with no relay hops). */
  zeroHop: CadenceStats | null;
}

/** Collapse arrivals closer than the dedupe window into one advert. */
function collapseArrivals(timestamps: number[]): number[] {
  const sorted = [...timestamps].sort((a, b) => a - b);
  const out: number[] = [];
  for (const t of sorted) {
    if (out.length === 0 || t - out[out.length - 1] >= MESHCORE_ADVERT_DEDUPE_WINDOW_MS) out.push(t);
  }
  return out;
}

/**
 * Per-repeater advert cadence from ADVERT packet-log rows. Only repeaters
 * (the handles in `repeaterHandles`) are considered. The caller passes ADVERT
 * rows only.
 */
export function buildMeshCoreAdvertCadence(
  packets: MeshCoreAdvertPacketInput[],
  handleByKey: Map<string, number>,
  repeaterHandles: ReadonlySet<number>,
): Map<number, MeshCoreAdvertCadence> {
  const flood = new Map<number, { ts: number[]; sources: string[] }>();
  const zero = new Map<number, { ts: number[]; sources: string[] }>();
  const push = (m: Map<number, { ts: number[]; sources: string[] }>, h: number, p: MeshCoreAdvertPacketInput) => {
    const e = m.get(h);
    if (e) {
      e.ts.push(Number(p.timestamp));
      e.sources.push(p.sourceId);
    } else m.set(h, { ts: [Number(p.timestamp)], sources: [p.sourceId] });
  };

  for (const p of packets) {
    if (!p.senderPubKey) continue;
    const h = handleByKey.get(p.senderPubKey.toLowerCase());
    if (h == null || !repeaterHandles.has(h)) continue;
    const rt = p.routeType;
    if (rt === MESHCORE_ROUTE_FLOOD || rt === MESHCORE_ROUTE_TRANSPORT_FLOOD) {
      push(flood, h, p);
    } else if (
      (rt === MESHCORE_ROUTE_DIRECT || rt === MESHCORE_ROUTE_TRANSPORT_DIRECT) &&
      (p.hopCount == null || p.hopCount === 0)
    ) {
      push(zero, h, p);
    }
  }

  const stats = (e: { ts: number[]; sources: string[] } | undefined): CadenceStats | null =>
    e ? cadenceStatsFromTimestamps(collapseArrivals(e.ts), e.sources) : null;

  const out = new Map<number, MeshCoreAdvertCadence>();
  for (const h of new Set([...flood.keys(), ...zero.keys()])) {
    const f = stats(flood.get(h));
    const z = stats(zero.get(h));
    if (f || z) out.set(h, { flood: f, zeroHop: z });
  }
  return out;
}
