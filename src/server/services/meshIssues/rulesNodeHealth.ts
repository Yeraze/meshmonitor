/**
 * Protocol-neutral node-health rules A6-A9 (#6279). One implementation reads
 * `PooledNode` for both Meshtastic and MeshCore; scope is infrastructure nodes
 * (`isInfraNode`: Meshtastic infra roles, MeshCore repeaters and room servers).
 *
 * Pure. Numeric thresholds live in `thresholds.ts`. No recommendation may say
 * "promote" or suggest the bare ROUTER role, and none advises advertising more
 * often (that costs airtime). No finding carries coordinates.
 */
import { MESH_ISSUE_TYPES, type MeshIssueFinding } from './types.js';
import {
  isInfraNode,
  isMeshCoreNode,
  persistedNodeNum,
  subjectKeyFor,
  type PooledNode,
} from './nodeSnapshot.js';
import {
  batteryReading,
  infraBatteryDischarging,
  infraRoleName,
  isBatteryLow,
  meshcoreEvidence,
  staleHoursFor,
} from './nodeHealth.js';
import { BATTERY_CONFIRM_SAMPLES, POWER_WINDOW_HOURS, STALE_MAX_AGE_DAYS } from './thresholds.js';
import type { RuleContext } from './rules.js';
import type { RuleSkip } from './rulesTierB.js';

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

function identity(node: PooledNode): Record<string, unknown> {
  return isMeshCoreNode(node) ? meshcoreEvidence(node) : {};
}

function* infraNodes(ctx: RuleContext): Generator<PooledNode> {
  for (const node of ctx.nodes.values()) if (isInfraNode(node)) yield node;
}

// ---------------------------------------------------------------------------
// A6 — Stale infrastructure node
// ---------------------------------------------------------------------------

interface StaleScan {
  stale: Array<{ node: PooledNode; ageMs: number; windowMs: number; aliveSources: string[] }>;
  /** Stale-looking nodes held back because no source that hears them is alive. */
  silentSkipped: number;
}

function scanStale(ctx: RuleContext): StaleScan {
  const out: StaleScan = { stale: [], silentSkipped: 0 };
  for (const node of infraNodes(ctx)) {
    if (node.isLocal) continue;
    if (node.lastHeardMs == null) continue;
    const ageMs = ctx.nowMs - node.lastHeardMs;
    if (ageMs < 0) continue;
    const windowMs = staleHoursFor(node, ctx.thresholds) * HOUR_MS;
    if (!(ageMs > windowMs) || ageMs > STALE_MAX_AGE_DAYS * DAY_MS) continue;
    // Liveness guard: some source that hears this node must itself have heard
    // something inside the same window, else a dead radio marks every node stale.
    const aliveSources = node.sourceIds.filter((s) => {
      const heard = ctx.sourceLastHeardMs.get(s);
      return heard != null && ctx.nowMs - heard <= windowMs;
    });
    if (aliveSources.length === 0) {
      out.silentSkipped++;
      continue;
    }
    out.stale.push({ node, ageMs, windowMs, aliveSources });
  }
  return out;
}

export function evaluateA6(ctx: RuleContext): MeshIssueFinding[] {
  return scanStale(ctx).stale.map(({ node, ageMs, aliveSources }) => {
    const meshcore = isMeshCoreNode(node);
    const thresholdHours = staleHoursFor(node, ctx.thresholds);
    return {
      issueType: MESH_ISSUE_TYPES.A6_STALE_NODE,
      subjectKey: subjectKeyFor(node),
      nodeNum: persistedNodeNum(node),
      severity: 'warning',
      confidence: 'medium',
      evidence: {
        ...identity(node),
        lastHeardAgeMs: ageMs,
        thresholdHours,
        roleName: infraRoleName(node),
        aliveSources,
        sources: node.sourceIds,
      },
      sourceIds: node.sourceIds,
      recommendation:
        `Not heard for over ${thresholdHours} h. Check power and antenna; dismiss if it was retired.` +
        (meshcore
          ? ' If its flood-advert interval is longer than the stale window, raise the window.'
          : ''),
    };
  });
}

// ---------------------------------------------------------------------------
// A7 — Infrastructure node with no position
// ---------------------------------------------------------------------------

export function evaluateA7(ctx: RuleContext): MeshIssueFinding[] {
  const findings: MeshIssueFinding[] = [];
  for (const node of infraNodes(ctx)) {
    if (node.hasPositionOverride) continue;
    const meshcore = isMeshCoreNode(node);
    let clause: 'no_position' | 'position_sharing_disabled' | 'advert_without_position' | null = null;
    if (node.reportedPosition === 'none') {
      clause = !meshcore && node.positionPrecisionBits === 0 ? 'position_sharing_disabled' : 'no_position';
    } else if (meshcore && node.reportedPosition === 'valid' && node.advertHadPosition === false) {
      // The firmware keeps the old fix when a later advert carries none (#5578).
      clause = 'advert_without_position';
    }
    if (clause == null) continue;
    findings.push({
      issueType: MESH_ISSUE_TYPES.A7_NO_POSITION,
      subjectKey: subjectKeyFor(node),
      nodeNum: persistedNodeNum(node),
      severity: 'info',
      confidence: clause === 'advert_without_position' ? 'medium' : 'high',
      evidence: {
        ...identity(node),
        clause,
        positionPrecisionBits: node.positionPrecisionBits,
        roleName: infraRoleName(node),
        sources: node.sourceIds,
      },
      sourceIds: node.sourceIds,
      recommendation: meshcore
        ? 'This repeater has no current position. Set its latitude and longitude in the Repeater settings or over the CLI.'
        : 'Set a fixed position on this node, or enable position sharing at reduced precision.',
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// A8 — Low battery
// ---------------------------------------------------------------------------

export function evaluateA8(ctx: RuleContext): MeshIssueFinding[] {
  const findings: MeshIssueFinding[] = [];
  const windowStart = ctx.nowMs - POWER_WINDOW_HOURS * HOUR_MS;
  for (const node of infraNodes(ctx)) {
    const series = ctx.telemetry.get(node.nodeNum);
    const reading = batteryReading(node, series, windowStart);
    if (!reading || !isBatteryLow(reading, ctx.thresholds)) continue;
    // A3 owns an infra node whose battery clause already fires; show it once.
    if (infraBatteryDischarging(node, series, windowStart, ctx.thresholds).met) continue;

    const pct = reading.unit === 'pct';
    const line = pct ? ctx.thresholds.lowBatteryPct : ctx.thresholds.lowBatteryMv;
    const tail = reading.values.slice(-BATTERY_CONFIRM_SAMPLES);
    const confirmed = tail.length >= BATTERY_CONFIRM_SAMPLES && tail.every((v) => v < line);
    findings.push({
      issueType: MESH_ISSUE_TYPES.A8_LOW_BATTERY,
      subjectKey: subjectKeyFor(node),
      nodeNum: persistedNodeNum(node),
      severity: 'warning',
      confidence: confirmed ? 'high' : 'low',
      evidence: {
        ...identity(node),
        latestBatteryPct: pct ? reading.latest : null,
        latestBatteryMv: pct ? null : reading.latest,
        latestReadingAgeMs: ctx.nowMs - reading.latestTs,
        sampleCount: reading.samples,
        thresholdUsed: line,
        unit: reading.unit,
        roleName: infraRoleName(node),
        sources: reading.sources,
      },
      sourceIds: reading.sources.length > 0 ? reading.sources : node.sourceIds,
      recommendation:
        'The battery is low. Check the power source and charging, and recharge or replace the battery before the node goes offline.',
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// A9 — Bad reported position
// ---------------------------------------------------------------------------

export function evaluateA9(ctx: RuleContext): MeshIssueFinding[] {
  const findings: MeshIssueFinding[] = [];
  for (const node of infraNodes(ctx)) {
    if (node.reportedPosition !== 'bogus') continue;
    findings.push({
      issueType: MESH_ISSUE_TYPES.A9_BAD_POSITION,
      subjectKey: subjectKeyFor(node),
      nodeNum: persistedNodeNum(node),
      severity: 'info',
      confidence: 'high',
      evidence: {
        ...identity(node),
        positionIssue: node.bogusPositionKind ?? 'out_of_range',
        positionPrecisionBits: node.positionPrecisionBits,
        discardSettingOn: false,
        roleName: infraRoleName(node),
        sources: node.sourceIds,
      },
      sourceIds: node.sourceIds,
      recommendation: 'This node reports an impossible position. Fix its GPS or set a fixed position.',
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Skips
// ---------------------------------------------------------------------------

/** Coarse availability notes for the coverage preface. */
export function nodeHealthSkips(ctx: RuleContext): RuleSkip[] {
  const skips: RuleSkip[] = [];
  const { silentSkipped } = scanStale(ctx);
  if (silentSkipped > 0) {
    skips.push({ rule: 'A6', reason: `${silentSkipped} node(s) skipped, source(s) silent` });
  }
  const windowStart = ctx.nowMs - POWER_WINDOW_HOURS * HOUR_MS;
  let infra = 0;
  let withBattery = 0;
  for (const node of infraNodes(ctx)) {
    infra++;
    if (batteryReading(node, ctx.telemetry.get(node.nodeNum), windowStart)) withBattery++;
  }
  if (infra > 0 && withBattery === 0) {
    skips.push({ rule: 'A8', reason: 'no battery telemetry in window' });
  }
  return skips;
}
