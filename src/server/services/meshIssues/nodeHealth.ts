/**
 * Pure helpers for the protocol-neutral node-health rules A6-A9 and the A3
 * battery clause (#6279). One implementation serves Meshtastic and MeshCore;
 * the only protocol branches are the battery unit (percent vs millivolts) and
 * the stale window.
 *
 * Pure: no `databaseService` import, no I/O.
 */
import { ROLE_NAMES } from '../../../constants/index.js';
import { isPowered } from '../../utils/poweredState.js';
import { isInfraNode, isMeshCoreNode, type NodeTelemetrySeries, type PooledNode } from './nodeSnapshot.js';
import { BATTERY_MIN_SAMPLES, type ResolvedMeshIssueThresholds } from './thresholds.js';

export interface BatteryReading {
  unit: 'pct' | 'mv';
  latest: number;
  latestTs: number;
  /** Samples inside the window. */
  samples: number;
  /** Sample values in time order (ascending), for the trailing-sample confirmation. */
  values: number[];
  /** Sorted, deduped sources of the in-window samples. */
  sources: string[];
}

/**
 * Latest in-window battery reading for a node, or null when there is nothing
 * to judge. Meshtastic reads `batteryLevel` (%) and ignores a powered report
 * (>100) and a 0 with no voltage (no battery ADC). MeshCore reads `batteryMv`
 * and ignores a non-positive value.
 */
export function batteryReading(
  node: PooledNode,
  series: NodeTelemetrySeries | undefined,
  windowStart: number,
): BatteryReading | null {
  if (!series) return null;
  const meshcore = isMeshCoreNode(node);
  const raw = meshcore ? series.batteryMv : series.batteryLevel;
  const samples = raw.filter((s) => s.timestamp >= windowStart).sort((a, b) => a.timestamp - b.timestamp);
  if (samples.length === 0) return null;
  const last = samples[samples.length - 1];
  if (meshcore) {
    if (!(last.value > 0)) return null;
  } else {
    if (isPowered(last.value)) return null;
    if (last.value === 0 && (node.voltage == null || node.voltage === 0)) return null;
  }
  return {
    unit: meshcore ? 'mv' : 'pct',
    latest: last.value,
    latestTs: last.timestamp,
    samples: samples.length,
    values: samples.map((s) => s.value),
    sources: Array.from(new Set(samples.map((s) => s.sourceId))).sort(),
  };
}

/** Is this reading under the configured low-battery line for its unit? */
export function isBatteryLow(reading: BatteryReading, t: ResolvedMeshIssueThresholds): boolean {
  return reading.unit === 'pct' ? reading.latest < t.lowBatteryPct : reading.latest < t.lowBatteryMv;
}

/** Stale window for a node's protocol, hours. */
export function staleHoursFor(node: PooledNode, t: ResolvedMeshIssueThresholds): number {
  return isMeshCoreNode(node) ? t.staleHoursMeshcore : t.staleHoursMeshtastic;
}

export interface LivenessRow {
  sourceId: string;
  /** Meshtastic seconds or MeshCore ms; below 1e12 is scaled up. */
  lastHeard?: number | null;
  updatedAt?: number | null;
  isLocal?: boolean | null;
}

/**
 * Newest sign of life per source, taken over the NON-local node rows of both
 * protocols. A local node row is excluded because the source stamps it itself;
 * it says nothing about whether the radio hears the mesh.
 */
export function buildSourceLiveness(
  rows: LivenessRow[],
  isLocalRow: (row: LivenessRow) => boolean = (r) => !!r.isLocal,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) {
    if (isLocalRow(row)) continue;
    let ms: number | null = null;
    if (row.lastHeard != null) {
      const v = Number(row.lastHeard);
      ms = v < 1e12 ? v * 1000 : v;
    } else if (row.updatedAt != null) {
      ms = Number(row.updatedAt);
    }
    if (ms == null || !Number.isFinite(ms)) continue;
    const prev = out.get(row.sourceId);
    if (prev == null || ms > prev) out.set(row.sourceId, ms);
  }
  return out;
}

export interface InfraBatteryDischarge {
  /** The A3 battery clause fires for this node. */
  met: boolean;
  sampleCount: number;
  minBatteryLevel: number | null;
  /** In-window `batteryLevel` samples, for the A3 evidence `sources`. */
  samples: NodeTelemetrySeries['batteryLevel'];
}

/**
 * The A3 battery clause, extracted unchanged: a Meshtastic infra node that is
 * not externally powered, with at least `BATTERY_MIN_SAMPLES` in-window
 * `batteryLevel` samples whose minimum is under `t.lowBatteryPct`. A8 uses
 * this to leave such a node to A3 so it shows once.
 */
export function infraBatteryDischarging(
  node: PooledNode,
  series: NodeTelemetrySeries | undefined,
  windowStart: number,
  t: ResolvedMeshIssueThresholds,
): InfraBatteryDischarge {
  const samples = series ? series.batteryLevel.filter((s) => s.timestamp >= windowStart) : [];
  const sampleCount = samples.length;
  const minBatteryLevel = sampleCount > 0 ? Math.min(...samples.map((s) => s.value)) : null;
  const met =
    isInfraNode(node) &&
    !isMeshCoreNode(node) &&
    !isPowered(node.batteryLevel) &&
    sampleCount >= BATTERY_MIN_SAMPLES &&
    minBatteryLevel != null &&
    minBatteryLevel < t.lowBatteryPct;
  return { met, sampleCount, minBatteryLevel, samples };
}

/** Evidence identity fields for a MeshCore finding (#6263 S5). */
export function meshcoreEvidence(node: PooledNode): Record<string, unknown> {
  return { publicKey: node.nodeKey, nodeName: node.longName, sourceIds: node.sourceIds };
}

const MESHCORE_ROLE_NAMES: Record<number, string> = { 2: 'Repeater', 3: 'Room Server' };

/** Human role label for a pooled infra node, either protocol. */
export function infraRoleName(node: PooledNode): string {
  if (isMeshCoreNode(node)) {
    return node.advType != null ? (MESHCORE_ROLE_NAMES[node.advType] ?? `Type ${node.advType}`) : 'Unknown';
  }
  if (node.role == null) return 'Unknown';
  return ROLE_NAMES[node.role] ?? `Role ${node.role}`;
}
