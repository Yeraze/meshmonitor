/**
 * Pooled physical-node snapshot + telemetry series builder for Mesh Issues
 * Analysis (#4964, Phase 1 WP2).
 *
 * `nodes` is one row per `(nodeNum, sourceId)` — a physical node heard on N
 * Meshtastic-family sources shows up as N rows. `buildPooledNodeSnapshot`
 * merges those into one `PooledNode` per physical `nodeNum` so the Tier A
 * rules never have to reason about source fan-out themselves.
 *
 * FRESHNESS PROXY (read before touching A1's evidence). There is no
 * NodeInfo-receipt-time column on `nodes` — the closest durable signal is
 * `lastHeard` (unix **seconds**, normalized to ms below `1e12`), falling back
 * to `updatedAt` (already ms) when `lastHeard` is absent. This proxy decides
 * which source's fields win the newest-wins merge below, and is exported as
 * `PooledNode.lastHeardMs`. Callers (A1's `lastHeardAgeMs` evidence field) must
 * label it "last heard" in the UI, never "NodeInfo age" — the data doesn't
 * support that precision.
 *
 * Pure — no `databaseService` import. `getEffectiveDbNodePosition` is a
 * dependency-free helper re-exported from `nodeEnhancer.ts`; importing it here
 * does not import `databaseService` directly (this module's own import list is
 * what the WP2 zero-`databaseService`-import gate checks).
 */
import { getEffectiveDbNodePosition } from '../../utils/nodeEnhancer.js';

export interface PooledNodeInput {
  nodeNum: number | string;
  nodeId: string;
  sourceId: string;
  longName?: string | null;
  shortName?: string | null;
  hwModel?: number | null;
  role?: number | null;
  isUnmessagable?: boolean | number | null;
  firmwareVersion?: string | null;
  batteryLevel?: number | null;
  voltage?: number | null;
  channelUtilization?: number | null;
  airUtilTx?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  positionOverrideEnabled?: boolean | number | null;
  latitudeOverride?: number | null;
  longitudeOverride?: number | null;
  positionPrecisionBits?: number | null;
  mobile?: number | null;
  lastHeard?: number | null;
  updatedAt?: number | null;
  // Tier C fold-in flags (#4964 Phase 3 WP2) — see PooledNode's JSDoc for the
  // per-field merge rule; all eight map 1:1 off `DbNode` (`src/db/types.ts`).
  isExcessivePackets?: boolean | number | null;
  packetRatePerHour?: number | null;
  keyIsLowEntropy?: boolean | number | null;
  duplicateKeyDetected?: boolean | number | null;
  keyMismatchDetected?: boolean | number | null;
  keySecurityIssueDetails?: string | null;
  isTimeOffsetIssue?: boolean | number | null;
  timeOffsetSeconds?: number | null;
}

export interface PooledNode {
  nodeNum: number;
  nodeId: string;
  longName: string | null;
  shortName: string | null;
  hwModel: number | null;
  role: number | null;
  isUnmessagable: boolean;
  firmwareVersion: string | null;
  batteryLevel: number | null;
  voltage: number | null;
  channelUtilization: number | null;
  airUtilTx: number | null;
  latitude: number | null;
  longitude: number | null;
  positionPrecisionBits: number | null;
  mobile: boolean;
  /** max across rows — the freshness proxy; see module header. */
  lastHeardMs: number | null;
  sourceIds: string[]; // sorted, deduped
  // Tier C fold-in flags (#4964 Phase 3 WP2). See buildPooledNodeSnapshot's
  // JSDoc for the merge rule table; the short version:
  //  - isExcessivePackets / keyIsLowEntropy / duplicateKeyDetected /
  //    keyMismatchDetected / isTimeOffsetIssue: logical OR across rows
  //    (flagged on any vantage means flagged).
  //  - packetRatePerHour: MAX across non-null rows — NEVER SUM. The same
  //    packet lands on TCP plus N MQTT gateways; summing per-source rates
  //    would multiply one node's traffic by its vantage count.
  //  - keySecurityIssueDetails: newest-wins (firstNonNull over freshness-sorted rows).
  //  - timeOffsetSeconds: the non-null value with the greatest ABSOLUTE
  //    magnitude — worst-case wins for a gating field, same spirit as
  //    positionPrecisionBits' MIN and mobile's OR.
  isExcessivePackets: boolean;
  packetRatePerHour: number | null;
  keyIsLowEntropy: boolean;
  duplicateKeyDetected: boolean;
  keyMismatchDetected: boolean;
  keySecurityIssueDetails: string | null;
  isTimeOffsetIssue: boolean;
  timeOffsetSeconds: number | null;
}

/** `lastHeard` is unix seconds in this schema; below 1e12 it must be *1000. */
function normalizeLastHeardMs(raw: number): number {
  return raw < 1e12 ? raw * 1000 : raw;
}

/** A row's own freshness reading, or null when it carries neither signal. */
function rowFreshnessOrNull(row: PooledNodeInput): number | null {
  if (row.lastHeard != null) return normalizeLastHeardMs(Number(row.lastHeard));
  if (row.updatedAt != null) return Number(row.updatedAt);
  return null;
}

/**
 * Ranking freshness — always a number (0 fallback) so rows with neither
 * timestamp still sort deterministically (last), without polluting the
 * exported `lastHeardMs` aggregate (which stays null when no row has data).
 */
function rowFreshnessForRanking(row: PooledNodeInput): number {
  return rowFreshnessOrNull(row) ?? 0;
}

/** First non-null value from `sorted` (already ranked newest-first). */
function firstNonNull<V>(
  sorted: PooledNodeInput[],
  selector: (row: PooledNodeInput) => V | null | undefined,
): V | null {
  for (const row of sorted) {
    const value = selector(row);
    if (value != null) return value;
  }
  return null;
}

/**
 * A row's effective (override-aware) lat/lon as a single pair, or null when
 * either axis is missing. Taken as a pair so newest-wins never mixes lat from
 * one source with lon from another.
 */
function effectivePositionPair(row: PooledNodeInput): { latitude: number; longitude: number } | null {
  const eff = getEffectiveDbNodePosition(row);
  if (eff.latitude == null || eff.longitude == null) return null;
  return { latitude: eff.latitude, longitude: eff.longitude };
}

/** The non-null value with the greatest ABSOLUTE magnitude, or null when
 *  `values` is empty. Used for `timeOffsetSeconds` (#4964 Phase 3 WP2) — a
 *  worst-case-wins merge for a gating field, ties broken by iteration order
 *  (first encountered wins a tie, matching this module's other deterministic
 *  merges). */
function maxAbsValue(values: number[]): number | null {
  if (values.length === 0) return null;
  let best = values[0];
  for (let i = 1; i < values.length; i++) {
    if (Math.abs(values[i]) > Math.abs(best)) best = values[i];
  }
  return best;
}

/**
 * Merge N per-source `nodes` rows for the same physical node into one
 * `PooledNode`. Grouping key is `Number(row.nodeNum)` — PostgreSQL/MySQL hand
 * back BIGINT `nodeNum` as a string, so the coercion is mandatory (CLAUDE.md
 * multi-database rule).
 *
 * Merge rules (see module header for the freshness proxy):
 *  - Newest-NodeInfo-wins, independently per field: for each scalar field,
 *    take the value from the highest-freshness row that has a non-null value
 *    for THAT field — a source with a name but no role must not blank the role.
 *  - Position is taken as an override-resolved (lat, lon) PAIR from a single
 *    row, never mixed across sources.
 *  - `positionPrecisionBits`: MIN across non-null values (worst precision
 *    wins — it gates A4, so be conservative).
 *  - `mobile`: logical OR across rows (mobility is a physical property).
 *  - `sourceIds`: union, sorted ascending.
 */
export function buildPooledNodeSnapshot(rows: PooledNodeInput[]): Map<number, PooledNode> {
  const groups = new Map<number, PooledNodeInput[]>();
  for (const row of rows) {
    const nodeNum = Number(row.nodeNum);
    if (!Number.isFinite(nodeNum)) continue;
    const existing = groups.get(nodeNum);
    if (existing) existing.push(row);
    else groups.set(nodeNum, [row]);
  }

  const result = new Map<number, PooledNode>();
  for (const [nodeNum, groupRows] of groups) {
    const sorted = [...groupRows].sort((a, b) => {
      const diff = rowFreshnessForRanking(b) - rowFreshnessForRanking(a);
      if (diff !== 0) return diff;
      return String(a.sourceId).localeCompare(String(b.sourceId));
    });

    const position = firstNonNull(sorted, effectivePositionPair);
    const precisionValues = groupRows
      .map((r) => r.positionPrecisionBits)
      .filter((v): v is number => v != null);
    const freshnessValues = groupRows
      .map(rowFreshnessOrNull)
      .filter((v): v is number => v != null);
    // Tier C (#4964 Phase 3 WP2) — see PooledNode's JSDoc for the merge rules.
    const packetRateValues = groupRows
      .map((r) => r.packetRatePerHour)
      .filter((v): v is number => v != null);
    const timeOffsetValues = groupRows
      .map((r) => r.timeOffsetSeconds)
      .filter((v): v is number => v != null);

    result.set(nodeNum, {
      nodeNum,
      nodeId: firstNonNull(sorted, (r) => r.nodeId) ?? sorted[0].nodeId,
      longName: firstNonNull(sorted, (r) => r.longName),
      shortName: firstNonNull(sorted, (r) => r.shortName),
      hwModel: firstNonNull(sorted, (r) => r.hwModel),
      role: firstNonNull(sorted, (r) => r.role),
      // `!= null` (not falsy) preserves an explicit `false` from the freshest
      // row — A5 depends on being able to tell "reported false" from
      // "unknown"; unknown (no row reports a value) normalizes to false here
      // per the PooledNode contract, and is guarded by A5's firmware check.
      isUnmessagable: !!firstNonNull(sorted, (r) => r.isUnmessagable),
      firmwareVersion: firstNonNull(sorted, (r) => r.firmwareVersion),
      batteryLevel: firstNonNull(sorted, (r) => r.batteryLevel),
      voltage: firstNonNull(sorted, (r) => r.voltage),
      channelUtilization: firstNonNull(sorted, (r) => r.channelUtilization),
      airUtilTx: firstNonNull(sorted, (r) => r.airUtilTx),
      latitude: position?.latitude ?? null,
      longitude: position?.longitude ?? null,
      positionPrecisionBits: precisionValues.length > 0 ? Math.min(...precisionValues) : null,
      mobile: groupRows.some((r) => !!r.mobile),
      lastHeardMs: freshnessValues.length > 0 ? Math.max(...freshnessValues) : null,
      sourceIds: Array.from(new Set(groupRows.map((r) => r.sourceId))).sort(),
      isExcessivePackets: groupRows.some((r) => !!r.isExcessivePackets),
      packetRatePerHour: packetRateValues.length > 0 ? Math.max(...packetRateValues) : null,
      keyIsLowEntropy: groupRows.some((r) => !!r.keyIsLowEntropy),
      duplicateKeyDetected: groupRows.some((r) => !!r.duplicateKeyDetected),
      keyMismatchDetected: groupRows.some((r) => !!r.keyMismatchDetected),
      keySecurityIssueDetails: firstNonNull(sorted, (r) => r.keySecurityIssueDetails),
      isTimeOffsetIssue: groupRows.some((r) => !!r.isTimeOffsetIssue),
      timeOffsetSeconds: maxAbsValue(timeOffsetValues),
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Telemetry series builder
// ---------------------------------------------------------------------------

export interface TelemetrySample {
  timestamp: number;
  value: number;
  sourceId: string;
}

export interface NodeTelemetrySeries {
  airUtilTx: TelemetrySample[];
  channelUtilization: TelemetrySample[];
  batteryLevel: TelemetrySample[];
  uptimeSeconds: TelemetrySample[];
}

export const MESH_ISSUE_TELEMETRY_TYPES = [
  'airUtilTx',
  'channelUtilization',
  'batteryLevel',
  'uptimeSeconds',
] as const;
export type MeshIssueTelemetryType = (typeof MESH_ISSUE_TELEMETRY_TYPES)[number];

function emptySeries(): NodeTelemetrySeries {
  return { airUtilTx: [], channelUtilization: [], batteryLevel: [], uptimeSeconds: [] };
}

export interface TelemetryRowInput {
  nodeNum: number | string;
  telemetryType: string;
  timestamp: number | string;
  value: number;
  sourceId?: string | null;
}

/**
 * Build per-node, per-metric telemetry series from raw telemetry rows.
 *
 * Cross-source dedup (epic: "newest per timestamp"): a self-reported reading
 * commonly arrives once via TCP and again via N MQTT gateways, all carrying
 * the SAME `(nodeNum, telemetryType, timestamp)`. Those collapse to one
 * sample — sort by `(timestamp asc, sourceId asc)` and keep the first
 * encountered per timestamp, a deterministic (not "most correct") choice.
 * Contributing `sourceId`s are recorded at the *finding* level by the rules,
 * not retained per-sample.
 *
 * Each series is sorted ascending by timestamp. Unknown telemetry types are
 * ignored (not every row in `getTelemetryByTypesSince`'s result need matter
 * to this module).
 */
export function buildTelemetrySeries(rows: TelemetryRowInput[]): Map<number, NodeTelemetrySeries> {
  const knownTypes: readonly string[] = MESH_ISSUE_TELEMETRY_TYPES;
  const byNode = new Map<number, TelemetryRowInput[]>();
  for (const row of rows) {
    if (!knownTypes.includes(row.telemetryType)) continue;
    const nodeNum = Number(row.nodeNum);
    if (!Number.isFinite(nodeNum)) continue;
    const existing = byNode.get(nodeNum);
    if (existing) existing.push(row);
    else byNode.set(nodeNum, [row]);
  }

  const result = new Map<number, NodeTelemetrySeries>();
  for (const [nodeNum, nodeRows] of byNode) {
    const series = emptySeries();
    const byType = new Map<MeshIssueTelemetryType, TelemetryRowInput[]>();
    for (const row of nodeRows) {
      const telemetryType = row.telemetryType as MeshIssueTelemetryType;
      const existing = byType.get(telemetryType);
      if (existing) existing.push(row);
      else byType.set(telemetryType, [row]);
    }

    for (const [telemetryType, typeRows] of byType) {
      const sorted = [...typeRows].sort((a, b) => {
        const ta = Number(a.timestamp);
        const tb = Number(b.timestamp);
        if (ta !== tb) return ta - tb;
        return String(a.sourceId ?? '').localeCompare(String(b.sourceId ?? ''));
      });
      const seenTimestamps = new Set<number>();
      const samples: TelemetrySample[] = [];
      for (const row of sorted) {
        const timestamp = Number(row.timestamp);
        if (seenTimestamps.has(timestamp)) continue;
        seenTimestamps.add(timestamp);
        samples.push({ timestamp, value: row.value, sourceId: row.sourceId ?? '' });
      }
      series[telemetryType] = samples;
    }

    result.set(nodeNum, series);
  }
  return result;
}
