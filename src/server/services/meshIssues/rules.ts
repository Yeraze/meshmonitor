/**
 * Tier A mesh-issue rules for Mesh Issues Analysis (#4964, Phase 1 WP2).
 *
 * Pure — no `databaseService` import, no I/O. Every rule takes a `RuleContext`
 * already built by `nodeSnapshot.ts` (pooled physical nodes + telemetry
 * series) and the service's position-span lookup, and returns findings; the
 * service (WP3) is responsible for turning findings into persisted rows.
 *
 * Every numeric threshold lives in `thresholds.ts` — this file must not
 * contain a numeric literal threshold. Role sets (`INFRA_ROLES`,
 * `DEPRECATED_ROLES`, `DEDICATED_ROUTER_ROLES`) are built from `DeviceRole`,
 * never literal ints.
 *
 * No recommendation in this file may contain the word "promote" or suggest
 * the ROUTER role — every recommendation steers a misconfigured node toward
 * CLIENT/CLIENT_BASE/ROUTER_LATE, never toward taking on more routing
 * responsibility. See `rules.test.ts`'s cross-rule assertion.
 */
import { DeviceRole, ROLE_NAMES } from '../../../constants/index.js';
import { isUptimeReboot } from '../../utils/rebootDetection.js';
import { isPowered } from '../../utils/poweredState.js';
import { isBogusPosition } from '../../../utils/nullIsland.js';
import { compareVersions } from '../../utils/systemInfo.js';
import {
  MESH_ISSUE_TYPES,
  nodeSubjectKey,
  areaSubjectKey,
  type MeshIssueFinding,
} from './types.js';
import { runRulesIsolated } from './ruleRunner.js';
import type { PooledNode, NodeTelemetrySeries } from './nodeSnapshot.js';
import {
  AIR_UTIL_TX_MIN_SAMPLES,
  UTILIZATION_WINDOW_HOURS,
  CONGESTED_AREA_MIN_NODES,
  AREA_GRID_BIN_DEG,
  BATTERY_LOW_PCT,
  BATTERY_MIN_SAMPLES,
  UPTIME_RESET_MIN_COUNT,
  POWER_WINDOW_HOURS,
  MOBILE_MIN_PRECISION_BITS,
  UNMESSAGABLE_MIN_FIRMWARE,
  INFRA_ROLES,
  DEPRECATED_ROLES,
  DEDICATED_ROUTER_ROLES,
  type ResolvedMeshIssueThresholds,
} from './thresholds.js';

export interface RuleContext {
  nodes: Map<number, PooledNode>;
  telemetry: Map<number, NodeTelemetrySeries>;
  /** nodeNum -> bounding-box span in meters, present only for infra-role nodes (A4). */
  positionSpanMeters: Map<number, number>;
  nowMs: number;
  /** User-tunable, clamp-on-read thresholds resolved once per run (#4964 Phase 3 WP1). */
  thresholds: ResolvedMeshIssueThresholds;
}

function roleName(role: number | null): string {
  if (role == null) return 'Unknown';
  return ROLE_NAMES[role] ?? `Role ${role}`;
}

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

// ---------------------------------------------------------------------------
// A1 — Deprecated role in use (REPEATER=4, ROUTER_CLIENT=3)
// ---------------------------------------------------------------------------

export function evaluateA1(ctx: RuleContext): MeshIssueFinding[] {
  const findings: MeshIssueFinding[] = [];
  for (const node of ctx.nodes.values()) {
    if (node.role == null || !DEPRECATED_ROLES.has(node.role)) continue;

    const lastHeardAgeMs = node.lastHeardMs == null ? null : ctx.nowMs - node.lastHeardMs;
    const recommendation =
      node.role === DeviceRole.REPEATER
        ? 'Consider CLIENT_BASE (fixed, powered) or ROUTER_LATE.'
        : 'Consider CLIENT, or CLIENT_BASE if the node is fixed and powered.';

    findings.push({
      issueType: MESH_ISSUE_TYPES.A1_DEPRECATED_ROLE,
      subjectKey: nodeSubjectKey(node.nodeNum),
      nodeNum: node.nodeNum,
      severity: 'warning',
      confidence: 'high',
      evidence: {
        role: node.role,
        roleName: roleName(node.role),
        // Recorded only, per the guard — age never changes severity.
        lastHeardAgeMs,
        sources: node.sourceIds,
      },
      sourceIds: node.sourceIds,
      recommendation,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// A2a — Chatty node: mean airUtilTx > 8% over 24h, >=6 samples
// ---------------------------------------------------------------------------

export function evaluateA2a(ctx: RuleContext): MeshIssueFinding[] {
  const findings: MeshIssueFinding[] = [];
  const windowStart = ctx.nowMs - UTILIZATION_WINDOW_HOURS * 3600_000;

  for (const node of ctx.nodes.values()) {
    const series = ctx.telemetry.get(node.nodeNum);
    if (!series) continue;

    const samples = series.airUtilTx.filter((s) => s.timestamp >= windowStart);
    if (samples.length < AIR_UTIL_TX_MIN_SAMPLES) continue;

    const meanAirUtilTx = samples.reduce((sum, s) => sum + s.value, 0) / samples.length;
    if (!(meanAirUtilTx > ctx.thresholds.airUtilTxPct)) continue;

    const maxAirUtilTx = Math.max(...samples.map((s) => s.value));
    const sources = sortedUnique(samples.map((s) => s.sourceId));

    findings.push({
      issueType: MESH_ISSUE_TYPES.A2A_CHATTY_NODE,
      subjectKey: nodeSubjectKey(node.nodeNum),
      nodeNum: node.nodeNum,
      severity: 'warning',
      confidence: 'medium',
      evidence: {
        meanAirUtilTx,
        maxAirUtilTx,
        sampleCount: samples.length,
        windowHours: UTILIZATION_WINDOW_HOURS,
        thresholdUsed: ctx.thresholds.airUtilTxPct,
        sources,
      },
      sourceIds: sources,
      recommendation:
        "This node is transmitting a large share of the channel's airtime. Review its position/telemetry broadcast intervals and any auto-responder.",
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// A2b — Congested area: >=3 nodes in a geographic cluster, mean channelUtilization > 25%
// ---------------------------------------------------------------------------

interface BinNodeInfo {
  nodeNum: number;
  longName: string | null;
  meanChannelUtilization: number;
  sampleCount: number;
  sources: string[];
}

interface Bin {
  latBin: number;
  lonBin: number;
  nodes: BinNodeInfo[];
}

export function evaluateA2b(ctx: RuleContext): MeshIssueFinding[] {
  const findings: MeshIssueFinding[] = [];
  const windowStart = ctx.nowMs - UTILIZATION_WINDOW_HOURS * 3600_000;
  const bins = new Map<string, Bin>();

  for (const node of ctx.nodes.values()) {
    // A node with no position is excluded from A2b entirely — it cannot be clustered.
    if (node.latitude == null || node.longitude == null) continue;
    if (isBogusPosition(node.latitude, node.longitude, node.positionPrecisionBits)) continue;

    const series = ctx.telemetry.get(node.nodeNum);
    const samples = series ? series.channelUtilization.filter((s) => s.timestamp >= windowStart) : [];
    if (samples.length === 0) continue; // only nodes with >=1 in-window sample qualify

    const meanChannelUtilization = samples.reduce((sum, s) => sum + s.value, 0) / samples.length;
    const latBin = Math.floor(node.latitude / AREA_GRID_BIN_DEG);
    const lonBin = Math.floor(node.longitude / AREA_GRID_BIN_DEG);
    const key = `${latBin}:${lonBin}`;

    const nodeInfo: BinNodeInfo = {
      nodeNum: node.nodeNum,
      longName: node.longName,
      meanChannelUtilization,
      sampleCount: samples.length,
      sources: sortedUnique(samples.map((s) => s.sourceId)),
    };

    const existing = bins.get(key);
    if (existing) existing.nodes.push(nodeInfo);
    else bins.set(key, { latBin, lonBin, nodes: [nodeInfo] });
  }

  for (const bin of bins.values()) {
    const { latBin, lonBin, nodes } = bin;
    const binMean = nodes.reduce((sum, n) => sum + n.meanChannelUtilization, 0) / nodes.length;

    if (nodes.length >= CONGESTED_AREA_MIN_NODES && binMean > ctx.thresholds.channelUtilPct) {
      const allSources = sortedUnique(nodes.flatMap((n) => n.sources));
      const centerLat = (latBin + 0.5) * AREA_GRID_BIN_DEG;
      const centerLon = (lonBin + 0.5) * AREA_GRID_BIN_DEG;

      findings.push({
        issueType: MESH_ISSUE_TYPES.A2B_CONGESTED_AREA,
        subjectKey: areaSubjectKey(latBin, lonBin),
        nodeNum: null,
        severity: 'warning',
        confidence: 'medium',
        evidence: {
          latBin,
          lonBin,
          centerLat,
          centerLon,
          binSizeDeg: AREA_GRID_BIN_DEG,
          nodeCount: nodes.length,
          meanChannelUtilization: binMean,
          nodes: nodes.map((n) => ({
            nodeNum: n.nodeNum,
            longName: n.longName,
            meanChannelUtilization: n.meanChannelUtilization,
          })),
          windowHours: UTILIZATION_WINDOW_HOURS,
          thresholdUsed: ctx.thresholds.channelUtilPct,
          sources: allSources,
        },
        sourceIds: allSources,
        recommendation:
          "This area's channel utilization is above the healthy 25% ceiling. Look for over-broadcasting nodes and redundant routers here rather than adding more infrastructure.",
      });
    } else {
      // Fallback — the guard's "single node = info". Deliberately broader
      // than spec §2.9's literal wording ("for a bin with fewer than
      // CONGESTED_AREA_MIN_NODES qualifying nodes"): this branch is the
      // `else` of the COMBINED area condition (node count AND binMean), so
      // it also fires for a bin with >=3 qualifying nodes whose *binMean*
      // sits at/under the 25% ceiling but which contains one node
      // individually over it. Kept intentionally (review finding, #4964): a
      // single hot node in an otherwise-quiet area is still real signal, and
      // info severity (not the area finding's warning) correctly reflects
      // that it isn't (yet) an area-wide problem. See spec §5 for the
      // recorded refinement.
      for (const n of nodes) {
        if (!(n.meanChannelUtilization > ctx.thresholds.channelUtilPct)) continue;
        findings.push({
          issueType: MESH_ISSUE_TYPES.A2B_CONGESTED_NODE,
          subjectKey: nodeSubjectKey(n.nodeNum),
          nodeNum: n.nodeNum,
          severity: 'info',
          confidence: 'low',
          evidence: {
            meanChannelUtilization: n.meanChannelUtilization,
            sampleCount: n.sampleCount,
            windowHours: UTILIZATION_WINDOW_HOURS,
            binNodeCount: nodes.length,
            thresholdUsed: ctx.thresholds.channelUtilPct,
            sources: n.sources,
          },
          sourceIds: n.sources,
          recommendation:
            'One node reports high channel utilization; not enough neighbors in this area to confirm area-wide congestion.',
        });
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// A3 — Infra role on failing power
// ---------------------------------------------------------------------------

export function evaluateA3(ctx: RuleContext): MeshIssueFinding[] {
  const findings: MeshIssueFinding[] = [];
  const windowStart = ctx.nowMs - POWER_WINDOW_HOURS * 3600_000;

  for (const node of ctx.nodes.values()) {
    if (node.role == null || !INFRA_ROLES.has(node.role)) continue;
    if (isPowered(node.batteryLevel)) continue; // "battery ≠ 101" clause

    const series = ctx.telemetry.get(node.nodeNum);
    const uptimeSamples = series
      ? series.uptimeSeconds.filter((s) => s.timestamp >= windowStart).sort((a, b) => a.timestamp - b.timestamp)
      : [];
    let uptimeResets = 0;
    for (let i = 1; i < uptimeSamples.length; i++) {
      if (isUptimeReboot(uptimeSamples[i - 1].value, uptimeSamples[i].value)) uptimeResets++;
    }

    const batterySamples = series
      ? series.batteryLevel.filter((s) => s.timestamp >= windowStart)
      : [];
    const batterySampleCount = batterySamples.length;
    const minBatteryLevel = batterySampleCount > 0 ? Math.min(...batterySamples.map((s) => s.value)) : null;

    const resetsClauseMet = uptimeResets >= UPTIME_RESET_MIN_COUNT;
    const batteryClauseMet =
      batterySampleCount >= BATTERY_MIN_SAMPLES && minBatteryLevel != null && minBatteryLevel < BATTERY_LOW_PCT;

    if (!resetsClauseMet && !batteryClauseMet) continue;

    const clause: 'resets' | 'battery' = resetsClauseMet ? 'resets' : 'battery';
    const sources = sortedUnique([
      ...uptimeSamples.map((s) => s.sourceId),
      ...batterySamples.map((s) => s.sourceId),
    ]);

    findings.push({
      issueType: MESH_ISSUE_TYPES.A3_INFRA_POWER,
      subjectKey: nodeSubjectKey(node.nodeNum),
      nodeNum: node.nodeNum,
      // Severity per the guard: resets clause = warning; battery-only clean-uptime = info.
      severity: resetsClauseMet ? 'warning' : 'info',
      confidence: resetsClauseMet ? 'medium' : 'low',
      evidence: {
        role: node.role,
        roleName: roleName(node.role),
        uptimeResets,
        uptimeSampleCount: uptimeSamples.length,
        minBatteryLevel,
        latestBatteryLevel: node.batteryLevel,
        batterySampleCount,
        windowHours: POWER_WINDOW_HOURS,
        clause,
        sources,
      },
      sourceIds: sources.length > 0 ? sources : node.sourceIds,
      recommendation:
        'An infrastructure node on battery power is resetting or deep-discharging. Verify the power budget, or move the role to CLIENT until power is reliable.',
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// A4 — Mobile node with infra role (500m)
// ---------------------------------------------------------------------------

export function evaluateA4(ctx: RuleContext): MeshIssueFinding[] {
  const findings: MeshIssueFinding[] = [];

  for (const node of ctx.nodes.values()) {
    if (node.role == null || !INFRA_ROLES.has(node.role)) continue;
    // Precision guard: a truncated position can fabricate a 500m span — see
    // MOBILE_MIN_PRECISION_BITS's JSDoc for the arithmetic.
    if (node.positionPrecisionBits != null && node.positionPrecisionBits < MOBILE_MIN_PRECISION_BITS) continue;

    const spanMeters = ctx.positionSpanMeters.get(node.nodeNum);
    if (spanMeters == null) continue;
    if (!(spanMeters > ctx.thresholds.mobileSpanMeters)) continue;

    findings.push({
      issueType: MESH_ISSUE_TYPES.A4_MOBILE_INFRA,
      subjectKey: nodeSubjectKey(node.nodeNum),
      nodeNum: node.nodeNum,
      severity: 'warning',
      confidence: 'medium',
      evidence: {
        role: node.role,
        roleName: roleName(node.role),
        spanMeters,
        // Sample count for the span measurement is computed by the service
        // (positionSpanKm's caller), not available at this pure rule layer —
        // RuleContext.positionSpanMeters carries only the span. Left null so
        // the wire shape is stable for WP3/WP5 without fabricating a count.
        positionSampleCount: null,
        // Persisted 100m classification, carried for corroboration only —
        // NOT a gate (see thresholds.ts / spec §5.8).
        mobileFlag: node.mobile,
        positionPrecisionBits: node.positionPrecisionBits,
        thresholdUsed: ctx.thresholds.mobileSpanMeters,
        sources: node.sourceIds,
      },
      sourceIds: node.sourceIds,
      recommendation: 'A node that moves should be CLIENT. Routing roles assume a fixed, well-sited antenna.',
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// A5 — Cosplay router (Phase 1: isUnmessagable clause only)
// ---------------------------------------------------------------------------

export function evaluateA5(ctx: RuleContext): MeshIssueFinding[] {
  const findings: MeshIssueFinding[] = [];

  for (const node of ctx.nodes.values()) {
    // ROUTER_CLIENT is *meant* to be messagable; REPEATER doesn't run the
    // client stack. Neither belongs in this rule (spec §5.4).
    if (node.role == null || !DEDICATED_ROUTER_ROLES.has(node.role)) continue;

    // is_unmessagable didn't exist before firmware 2.5 (defaults false there,
    // meaning "unknown" not "messagable") — without this guard the rule fires
    // on every pre-2.5 node.
    if (node.firmwareVersion == null) continue;
    if (compareVersions(node.firmwareVersion, UNMESSAGABLE_MIN_FIRMWARE) < 0) continue;

    if (node.isUnmessagable !== false) continue;

    const lastHeardAgeMs = node.lastHeardMs == null ? null : ctx.nowMs - node.lastHeardMs;

    findings.push({
      issueType: MESH_ISSUE_TYPES.A5_COSPLAY_ROUTER,
      subjectKey: nodeSubjectKey(node.nodeNum),
      nodeNum: node.nodeNum,
      severity: 'info',
      confidence: 'low',
      evidence: {
        role: node.role,
        roleName: roleName(node.role),
        isUnmessagable: false,
        firmwareVersion: node.firmwareVersion,
        lastHeardAgeMs,
        // The telemetry-cadence clause is deferred to Phase 3 — see spec §5.1:
        // the only durable solicited/unsolicited discriminator requires
        // packet_log, which is opt-in/off-by-default/pruned, so a cadence
        // heuristic here would be a false-positive generator.
        telemetryCadenceClause: 'deferred',
        sources: node.sourceIds,
      },
      sourceIds: node.sourceIds,
      recommendation:
        "A dedicated router normally advertises itself as unmessagable. If this is someone's handheld running a routing role, CLIENT is the right role.",
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Combined evaluation
// ---------------------------------------------------------------------------

const ALL_RULES: Array<[string, (ctx: RuleContext) => MeshIssueFinding[]]> = [
  ['A1', evaluateA1],
  ['A2a', evaluateA2a],
  ['A2b', evaluateA2b],
  ['A3', evaluateA3],
  ['A4', evaluateA4],
  ['A5', evaluateA5],
];

/** A1..A5 in order. Never throws — a rule that cannot evaluate returns []. */
export function evaluateAllTierA(ctx: RuleContext): MeshIssueFinding[] {
  return runRulesIsolated('Tier A', ALL_RULES, ctx);
}
