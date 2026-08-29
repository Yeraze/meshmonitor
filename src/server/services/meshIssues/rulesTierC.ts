/**
 * Tier C mesh-issue rules for Mesh Issues Analysis (#4964, Phase 3 WP2).
 *
 * Pure — no `databaseService` import, no I/O. Every rule takes a
 * `TierCRuleContext` built by the service from the pooled node snapshot
 * (`nodeSnapshot.ts`, C1's eight fold-in flags) and a cadence map the
 * service computes from a two-stage mean-gate-then-exact-median position
 * query plus an in-memory telemetry-timestamp union (spec §2.5) —
 * `cadenceStatsFromTimestamps` below is the shared pure aggregator both
 * paths reduce to.
 *
 * Every numeric threshold lives in `thresholds.ts` — this file must not
 * contain a numeric literal threshold.
 *
 * No recommendation in this file may contain the word "promote" or suggest
 * the ROUTER role — see `rulesTierC.test.ts`'s cross-rule assertion (mirrors
 * `rules.test.ts` / `rulesTierB.test.ts`).
 *
 * C1 adds NO threshold of its own (P3-D9): all three conditions read flags
 * `duplicateKeySchedulerService` already computes against its own
 * thresholds. A second threshold here could disagree with the flag.
 */
import { ROLE_NAMES } from '../../../constants/index.js';
import { isPowered } from '../../utils/poweredState.js';
import {
  MESH_ISSUE_TYPES,
  nodeSubjectKey,
  type MeshIssueFinding,
  type MeshIssueSeverity,
  type MeshIssueConfidence,
} from './types.js';
import { runRulesIsolated } from './ruleRunner.js';
import type { RuleSkip } from './rulesTierB.js';
import type { PooledNode } from './nodeSnapshot.js';
import {
  OVER_BROADCAST_MIN_SAMPLES,
  OVER_BROADCAST_EXEMPT_ROLES,
  OVER_BROADCAST_WARNING_SEVERITY_FACTOR,
  type ResolvedMeshIssueThresholds,
} from './thresholds.js';

// ---------------------------------------------------------------------------
// Context + shared small types
// ---------------------------------------------------------------------------

/** Per-stream (position or telemetry) broadcast-cadence summary for one node. */
export interface CadenceStats {
  /** Deduped broadcast count in-window (the count the epic's "deduped ... median" asks for). */
  sampleCount: number;
  /** (last - first) / (sampleCount - 1) — cheap, always present when sampleCount >= 2. */
  meanIntervalSeconds: number;
  /** True median of the deduped inter-arrival gaps. Null when stage 2 did not
   *  run for this node (not a stage-1 candidate) — see the service's
   *  buildCadenceMap. */
  medianIntervalSeconds: number | null;
  sourceIds: string[];
}

export interface NodeCadence {
  position: CadenceStats | null;
  telemetry: CadenceStats | null;
}

export interface TierCRuleContext {
  nodes: Map<number, PooledNode>;
  /** nodeNum -> per-stream cadence, built by the service (spec §2.5). */
  cadence: Map<number, NodeCadence>;
  /** User-tunable, clamp-on-read thresholds resolved once per run (#4964 Phase 3 WP1). */
  thresholds: ResolvedMeshIssueThresholds;
  nowMs: number;
  /** Lookback window the cadence samples were drawn from, hours — carried
   *  through for C2's `windowHours` evidence field (the analysis run's
   *  `lookbackHours`, not a code constant, so it cannot live in
   *  `thresholds.ts`). */
  windowHours: number;
}

function roleName(role: number | null): string {
  if (role == null) return 'Unknown';
  return ROLE_NAMES[role] ?? `Role ${role}`;
}

// ---------------------------------------------------------------------------
// Cadence aggregation (pure — shared by the service's cadence paths)
// ---------------------------------------------------------------------------

/**
 * Deduped-timestamp inter-arrival stats from a raw (possibly duplicated,
 * unsorted) list of millisecond timestamps. Returns null when fewer than two
 * DISTINCT timestamps remain — no interval is computable from one point.
 *
 * Used by the service for THREE cadence paths:
 *  - telemetry (C2, spec §2.5): called once with the union of the four
 *    device-telemetry series' timestamps (already in memory, no query);
 *  - position stage 2 (C2, spec §2.5): called once per stage-1 candidate
 *    with the exact timestamps `getTelemetryTimestampsAsync` returns;
 *  - A5's telemetry-cadence clause (#4964 post-epic follow-up): called once
 *    per dedicated-router node with the deduped broadcast-TELEMETRY_APP
 *    timestamps `getBroadcastTelemetryTimestampsAsync` returns (see
 *    `meshIssuesAnalysisService.buildRouterTelemetryCadenceMap`).
 */
export function cadenceStatsFromTimestamps(
  timestampsMs: number[],
  sourceIds: string[] = [],
): CadenceStats | null {
  const sorted = Array.from(new Set(timestampsMs)).sort((a, b) => a - b);
  if (sorted.length < 2) return null;

  const intervalsMs: number[] = [];
  for (let i = 1; i < sorted.length; i++) intervalsMs.push(sorted[i] - sorted[i - 1]);

  const meanMs = intervalsMs.reduce((sum, v) => sum + v, 0) / intervalsMs.length;

  const sortedIntervals = [...intervalsMs].sort((a, b) => a - b);
  const mid = Math.floor(sortedIntervals.length / 2);
  const medianMs =
    sortedIntervals.length % 2 === 0
      ? (sortedIntervals[mid - 1] + sortedIntervals[mid]) / 2
      : sortedIntervals[mid];

  return {
    sampleCount: sorted.length,
    meanIntervalSeconds: meanMs / 1000,
    medianIntervalSeconds: medianMs / 1000,
    sourceIds: Array.from(new Set(sourceIds)).sort(),
  };
}

// ---------------------------------------------------------------------------
// C1 — existing flags folded in (P3-D8/D9: one C1_key_security per node,
// no new threshold)
// ---------------------------------------------------------------------------

export function evaluateC1ExcessivePackets(ctx: TierCRuleContext): MeshIssueFinding[] {
  const findings: MeshIssueFinding[] = [];
  for (const node of ctx.nodes.values()) {
    if (!node.isExcessivePackets) continue;

    findings.push({
      issueType: MESH_ISSUE_TYPES.C1_EXCESSIVE_PACKETS,
      subjectKey: nodeSubjectKey(node.nodeNum),
      nodeNum: node.nodeNum,
      severity: 'warning',
      confidence: 'medium',
      evidence: {
        packetRatePerHour: node.packetRatePerHour,
        role: node.role,
        roleName: roleName(node.role),
        sources: node.sourceIds,
      },
      sourceIds: node.sourceIds,
      recommendation:
        'This node is putting a lot of packets on the channel. Check its position and telemetry broadcast intervals, and any auto-responder or integration attached to it.',
    });
  }
  return findings;
}

export function evaluateC1KeySecurity(ctx: TierCRuleContext): MeshIssueFinding[] {
  const findings: MeshIssueFinding[] = [];
  for (const node of ctx.nodes.values()) {
    const clauses: string[] = [];
    if (node.keyIsLowEntropy) clauses.push('keyIsLowEntropy');
    if (node.duplicateKeyDetected) clauses.push('duplicateKeyDetected');
    if (node.keyMismatchDetected) clauses.push('keyMismatchDetected');
    if (clauses.length === 0) continue;

    // High confidence only when keyIsLowEntropy is among the clauses — a
    // deterministic property of the key itself. A duplicate or mismatched
    // key has benign causes (notably a re-flashed node), so medium otherwise.
    const confidence: MeshIssueConfidence = clauses.includes('keyIsLowEntropy') ? 'high' : 'medium';

    findings.push({
      issueType: MESH_ISSUE_TYPES.C1_KEY_SECURITY,
      subjectKey: nodeSubjectKey(node.nodeNum),
      nodeNum: node.nodeNum,
      severity: 'warning',
      confidence,
      evidence: {
        clauses,
        details: node.keySecurityIssueDetails,
        sources: node.sourceIds,
      },
      sourceIds: node.sourceIds,
      // Deliberately "channel", not DM: a PKI-encrypted DM uses the stored
      // key, which is the thing in question (CLAUDE.md key-repair routing).
      recommendation:
        "Regenerate this node's key from the device (factory reset of the key material), then re-exchange NodeInfo on the node's channel.",
    });
  }
  return findings;
}

export function evaluateC1TimeOffset(ctx: TierCRuleContext): MeshIssueFinding[] {
  const findings: MeshIssueFinding[] = [];
  for (const node of ctx.nodes.values()) {
    if (!node.isTimeOffsetIssue) continue;

    findings.push({
      issueType: MESH_ISSUE_TYPES.C1_TIME_OFFSET,
      subjectKey: nodeSubjectKey(node.nodeNum),
      nodeNum: node.nodeNum,
      severity: 'info',
      confidence: 'high',
      evidence: {
        timeOffsetSeconds: node.timeOffsetSeconds,
        sources: node.sourceIds,
      },
      sourceIds: node.sourceIds,
      recommendation:
        "This node's reported clock is offset from the mesh. Check its GPS/NTP time source, or the device clock if it has neither.",
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// C2 — Over-broadcasting
// ---------------------------------------------------------------------------

function cadenceQualifies(stats: CadenceStats | null, thresholdSeconds: number): boolean {
  if (!stats) return false;
  if (stats.sampleCount < OVER_BROADCAST_MIN_SAMPLES) return false;
  if (stats.medianIntervalSeconds == null) return false;
  return stats.medianIntervalSeconds < thresholdSeconds;
}

export function evaluateC2(ctx: TierCRuleContext): MeshIssueFinding[] {
  const findings: MeshIssueFinding[] = [];

  for (const node of ctx.nodes.values()) {
    // A node with an unknown role is skipped, conservatively.
    if (node.role == null) continue;
    if (OVER_BROADCAST_EXEMPT_ROLES.has(node.role)) continue;

    const cadence = ctx.cadence.get(node.nodeNum);
    if (!cadence) continue;

    const positionQualifies = cadenceQualifies(cadence.position, ctx.thresholds.overBroadcastSeconds);
    const telemetryQualifies = cadenceQualifies(cadence.telemetry, ctx.thresholds.overBroadcastSeconds);
    if (!positionQualifies && !telemetryQualifies) continue;

    // When both streams qualify, emit ONE finding for the faster (lower
    // median) stream and carry the other in otherStreamMedianSeconds — a
    // node never produces two C2 rows under one subject key.
    let stream: 'position' | 'telemetry';
    let chosen: CadenceStats;
    let other: CadenceStats | null;
    if (positionQualifies && telemetryQualifies) {
      const posMedian = cadence.position!.medianIntervalSeconds!;
      const telMedian = cadence.telemetry!.medianIntervalSeconds!;
      if (posMedian <= telMedian) {
        stream = 'position';
        chosen = cadence.position!;
        other = cadence.telemetry!;
      } else {
        stream = 'telemetry';
        chosen = cadence.telemetry!;
        other = cadence.position!;
      }
    } else if (positionQualifies) {
      stream = 'position';
      chosen = cadence.position!;
      other = cadence.telemetry;
    } else {
      stream = 'telemetry';
      chosen = cadence.telemetry!;
      other = cadence.position;
    }

    const medianSeconds = chosen.medianIntervalSeconds!;
    const powered = isPowered(node.batteryLevel);
    // warning when the node is NOT powered (a battery node over-broadcasting
    // is also burning itself down) or the median is under half the
    // threshold; otherwise info.
    const severity: MeshIssueSeverity =
      !powered || medianSeconds < ctx.thresholds.overBroadcastSeconds * OVER_BROADCAST_WARNING_SEVERITY_FACTOR
        ? 'warning'
        : 'info';

    const sources = chosen.sourceIds.length > 0 ? chosen.sourceIds : node.sourceIds;

    findings.push({
      issueType: MESH_ISSUE_TYPES.C2_OVER_BROADCASTING,
      subjectKey: nodeSubjectKey(node.nodeNum),
      nodeNum: node.nodeNum,
      severity,
      confidence: 'medium',
      evidence: {
        stream,
        medianIntervalSeconds: medianSeconds,
        meanIntervalSeconds: chosen.meanIntervalSeconds,
        sampleCount: chosen.sampleCount,
        windowHours: ctx.windowHours,
        thresholdUsed: ctx.thresholds.overBroadcastSeconds,
        role: node.role,
        roleName: roleName(node.role),
        otherStreamMedianSeconds: other?.medianIntervalSeconds ?? null,
        sources,
      },
      sourceIds: sources,
      recommendation:
        'This node broadcasts position or telemetry far more often than the mesh needs. Increase the broadcast interval in its device settings. Roles that are meant to report often (Tracker, Sensor, TAK Tracker) are exempt from this check.',
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Combined evaluation
// ---------------------------------------------------------------------------

const ALL_RULES: Array<[string, (ctx: TierCRuleContext) => MeshIssueFinding[]]> = [
  ['C1_excessive_packets', evaluateC1ExcessivePackets],
  ['C1_key_security', evaluateC1KeySecurity],
  ['C1_time_offset', evaluateC1TimeOffset],
  ['C2_over_broadcasting', evaluateC2],
];

/** C1's three flags and C2, in order. Never throws — a rule that cannot
 *  evaluate returns []. */
export function evaluateAllTierC(ctx: TierCRuleContext): MeshIssueFinding[] {
  return runRulesIsolated('Tier C', ALL_RULES, ctx);
}

/**
 * Coarse availability gate only (D13 precedent from Tier B) — C2 needs
 * `ctx.cadence` to contain anything at all. The Phase 3 coverage preface is
 * the consumer.
 */
export function tierCSkips(ctx: TierCRuleContext): RuleSkip[] {
  const skips: RuleSkip[] = [];
  if (ctx.cadence.size === 0) {
    skips.push({ rule: 'C2', reason: 'no position or telemetry cadence data' });
  }
  return skips;
}
