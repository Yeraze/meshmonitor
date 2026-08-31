import { describe, it, expect } from 'vitest';
import {
  evaluateC1ExcessivePackets,
  evaluateC1KeySecurity,
  evaluateC1TimeOffset,
  evaluateC2,
  evaluateAllTierC,
  tierCSkips,
  cadenceStatsFromTimestamps,
  parseSharedWithNodeNums,
  type TierCRuleContext,
  type CadenceStats,
  type NodeCadence,
} from './rulesTierC.js';
import { MESH_ISSUE_TYPES } from './types.js';
import { DEFAULT_MESH_ISSUE_THRESHOLDS, OVER_BROADCAST_MIN_SAMPLES } from './thresholds.js';
import { DeviceRole } from '../../../constants/index.js';
import type { PooledNode } from './nodeSnapshot.js';

const NOW_MS = 2_000_000_000_000;

function makeNode(overrides: Partial<PooledNode> = {}): PooledNode {
  const nodeNum = overrides.nodeNum ?? 100;
  return {
    nodeNum,
    nodeId: `!${(nodeNum >>> 0).toString(16).padStart(8, '0')}`,
    longName: 'Test Node',
    shortName: 'TN',
    hwModel: 1,
    role: DeviceRole.CLIENT,
    isUnmessagable: false,
    firmwareVersion: null,
    batteryLevel: null,
    voltage: null,
    channelUtilization: null,
    airUtilTx: null,
    latitude: null,
    longitude: null,
    positionPrecisionBits: null,
    mobile: false,
    lastHeardMs: null,
    sourceIds: ['src-a'],
    isExcessivePackets: false,
    packetRatePerHour: null,
    keyIsLowEntropy: false,
    duplicateKeyDetected: false,
    keyMismatchDetected: false,
    keySecurityIssueDetails: null,
    isTimeOffsetIssue: false,
    timeOffsetSeconds: null,
    ...overrides,
  };
}

function nodeMap(nodes: PooledNode[]): Map<number, PooledNode> {
  return new Map(nodes.map((n) => [n.nodeNum, n]));
}

function makeCadenceStats(overrides: Partial<CadenceStats> = {}): CadenceStats {
  return {
    sampleCount: OVER_BROADCAST_MIN_SAMPLES,
    meanIntervalSeconds: 60,
    medianIntervalSeconds: 60,
    sourceIds: ['src-a'],
    ...overrides,
  };
}

function makeContext(
  nodes: PooledNode[],
  cadence: Map<number, NodeCadence> = new Map(),
  thresholds = DEFAULT_MESH_ISSUE_THRESHOLDS,
  nowMs = NOW_MS,
  windowHours = 168,
): TierCRuleContext {
  return { nodes: nodeMap(nodes), cadence, thresholds, nowMs, windowHours };
}

// ---------------------------------------------------------------------------
// cadenceStatsFromTimestamps
// ---------------------------------------------------------------------------

describe('cadenceStatsFromTimestamps', () => {
  it('returns null for fewer than two distinct timestamps', () => {
    expect(cadenceStatsFromTimestamps([])).toBeNull();
    expect(cadenceStatsFromTimestamps([1000])).toBeNull();
    expect(cadenceStatsFromTimestamps([1000, 1000])).toBeNull(); // dedupes to one
  });

  it('computes mean and median (even count) inter-arrival in seconds', () => {
    // Distinct sorted: 0, 10000, 20000, 40000 -> intervals 10000,10000,20000 (s: 10,10,20)
    const stats = cadenceStatsFromTimestamps([0, 10_000, 20_000, 40_000]);
    expect(stats!.sampleCount).toBe(4);
    expect(stats!.meanIntervalSeconds).toBeCloseTo(40 / 3, 5);
    expect(stats!.medianIntervalSeconds).toBe(10); // sorted [10,10,20], odd count -> middle
  });

  it('deduplicates repeated timestamps before computing intervals', () => {
    const stats = cadenceStatsFromTimestamps([0, 0, 10_000, 10_000, 20_000]);
    expect(stats!.sampleCount).toBe(3);
  });

  it('sorts and dedupes contributing sourceIds', () => {
    const stats = cadenceStatsFromTimestamps([0, 1000], ['src-b', 'src-a', 'src-a']);
    expect(stats!.sourceIds).toEqual(['src-a', 'src-b']);
  });
});

// ---------------------------------------------------------------------------
// C1 — excessive packets / key security / time offset
// ---------------------------------------------------------------------------

describe('evaluateC1ExcessivePackets', () => {
  it('fires only when isExcessivePackets is true', () => {
    const ctx = makeContext([
      makeNode({ nodeNum: 1, isExcessivePackets: true, packetRatePerHour: 250 }),
      makeNode({ nodeNum: 2, isExcessivePackets: false }),
    ]);
    const findings = evaluateC1ExcessivePackets(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].issueType).toBe(MESH_ISSUE_TYPES.C1_EXCESSIVE_PACKETS);
    expect(findings[0].nodeNum).toBe(1);
    expect(findings[0].evidence.packetRatePerHour).toBe(250);
  });
});

describe('evaluateC1KeySecurity', () => {
  it('emits nothing when every key-security flag is false', () => {
    const ctx = makeContext([makeNode({ nodeNum: 1 })]);
    expect(evaluateC1KeySecurity(ctx)).toEqual([]);
  });

  it('emits exactly ONE finding per node with multiple clauses when more than one flag is set', () => {
    const ctx = makeContext([
      makeNode({ nodeNum: 1, keyIsLowEntropy: true, duplicateKeyDetected: true, keyMismatchDetected: true }),
    ]);
    const findings = evaluateC1KeySecurity(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].evidence.clauses).toEqual(['keyIsLowEntropy', 'duplicateKeyDetected', 'keyMismatchDetected']);
  });

  it('confidence is high only when keyIsLowEntropy is among the clauses', () => {
    const lowEntropyCtx = makeContext([makeNode({ nodeNum: 1, keyIsLowEntropy: true })]);
    expect(evaluateC1KeySecurity(lowEntropyCtx)[0].confidence).toBe('high');

    const duplicateOnlyCtx = makeContext([makeNode({ nodeNum: 2, duplicateKeyDetected: true })]);
    expect(evaluateC1KeySecurity(duplicateOnlyCtx)[0].confidence).toBe('medium');

    const mismatchOnlyCtx = makeContext([makeNode({ nodeNum: 3, keyMismatchDetected: true })]);
    expect(evaluateC1KeySecurity(mismatchOnlyCtx)[0].confidence).toBe('medium');
  });

  it('carries keySecurityIssueDetails into evidence.details', () => {
    const ctx = makeContext([
      makeNode({ nodeNum: 1, duplicateKeyDetected: true, keySecurityIssueDetails: 'seen twice' }),
    ]);
    expect(evaluateC1KeySecurity(ctx)[0].evidence.details).toBe('seen twice');
  });

  it('recommends re-exchanging NodeInfo on the channel, not a DM', () => {
    const ctx = makeContext([makeNode({ nodeNum: 1, keyMismatchDetected: true })]);
    expect(evaluateC1KeySecurity(ctx)[0].recommendation).toMatch(/channel/i);
    expect(evaluateC1KeySecurity(ctx)[0].recommendation).not.toMatch(/\bDM\b/i);
  });

  it('emits sharedWithNodes with resolved names when duplicateKeyDetected is a clause', () => {
    const ctx = makeContext([
      makeNode({
        nodeNum: 1,
        longName: 'Alpha',
        duplicateKeyDetected: true,
        keySecurityIssueDetails: 'Key shared with nodes: 2, 3',
      }),
      makeNode({ nodeNum: 2, longName: 'Bravo', shortName: null }),
      // longName null → falls back to shortName
      makeNode({ nodeNum: 3, longName: null, shortName: 'CHR' }),
    ]);
    const finding = evaluateC1KeySecurity(ctx).find((f) => f.nodeNum === 1)!;
    expect(finding.evidence.sharedWithNodes).toEqual([
      { nodeNum: 2, name: 'Bravo' },
      { nodeNum: 3, name: 'CHR' },
    ]);
    // Keep the original string too so old renderers still work.
    expect(finding.evidence.details).toBe('Key shared with nodes: 2, 3');
  });

  it('populates sharedWithNodes even when the shared node is absent from the snapshot (name null)', () => {
    const ctx = makeContext([
      makeNode({
        nodeNum: 1,
        duplicateKeyDetected: true,
        keySecurityIssueDetails: 'Key shared with nodes: 9999',
      }),
    ]);
    const finding = evaluateC1KeySecurity(ctx)[0];
    expect(finding.evidence.sharedWithNodes).toEqual([{ nodeNum: 9999, name: null }]);
  });

  it('does NOT emit sharedWithNodes when only keyMismatchDetected fires', () => {
    const ctx = makeContext([
      makeNode({
        nodeNum: 1,
        keyMismatchDetected: true,
        keySecurityIssueDetails: 'Key mismatch: node broadcast NEW... but device has OLD...',
      }),
    ]);
    const finding = evaluateC1KeySecurity(ctx)[0];
    expect(finding.evidence.sharedWithNodes).toBeUndefined();
  });

  it('does NOT emit sharedWithNodes when details is missing or malformed', () => {
    const ctx = makeContext([
      makeNode({ nodeNum: 1, duplicateKeyDetected: true, keySecurityIssueDetails: null }),
    ]);
    const finding = evaluateC1KeySecurity(ctx)[0];
    expect(finding.evidence.sharedWithNodes).toBeUndefined();
  });
});

describe('parseSharedWithNodeNums', () => {
  it('extracts a comma-separated list', () => {
    expect(parseSharedWithNodeNums('Key shared with nodes: 100, 200, 300')).toEqual([100, 200, 300]);
  });

  it('accepts singular "node:"', () => {
    expect(parseSharedWithNodeNums('Key shared with node: 42')).toEqual([42]);
  });

  it('accepts the low-entropy prefix that duplicateKeySchedulerService prepends', () => {
    expect(parseSharedWithNodeNums('Known low-entropy key; Key shared with nodes: 1, 2')).toEqual([1, 2]);
  });

  it('returns [] on unrelated or empty strings', () => {
    expect(parseSharedWithNodeNums('unrelated message')).toEqual([]);
    expect(parseSharedWithNodeNums(null)).toEqual([]);
    expect(parseSharedWithNodeNums(undefined)).toEqual([]);
    expect(parseSharedWithNodeNums('')).toEqual([]);
  });

  it('drops non-positive parts within the numeric run', () => {
    expect(parseSharedWithNodeNums('Key shared with nodes: 5, 0, 7')).toEqual([5, 7]);
  });

  it('stops at the first non-numeric token (documented truncation semantics)', () => {
    // The regex captures the leading digit/comma/space run only. A stray
    // "foo" ends the match; nothing after it is parsed.
    expect(parseSharedWithNodeNums('Key shared with nodes: 5, foo, 7')).toEqual([5]);
  });
});

describe('evaluateC1TimeOffset', () => {
  it('fires only when isTimeOffsetIssue is true, carrying timeOffsetSeconds', () => {
    const ctx = makeContext([
      makeNode({ nodeNum: 1, isTimeOffsetIssue: true, timeOffsetSeconds: -1800 }),
      makeNode({ nodeNum: 2, isTimeOffsetIssue: false }),
    ]);
    const findings = evaluateC1TimeOffset(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].nodeNum).toBe(1);
    expect(findings[0].severity).toBe('info');
    expect(findings[0].confidence).toBe('high');
    expect(findings[0].evidence.timeOffsetSeconds).toBe(-1800);
  });
});

describe('C1 — no findings when every flag is false', () => {
  it('produces no findings across all three C1 rules for a clean node', () => {
    const ctx = makeContext([makeNode({ nodeNum: 1 })]);
    expect(evaluateC1ExcessivePackets(ctx)).toEqual([]);
    expect(evaluateC1KeySecurity(ctx)).toEqual([]);
    expect(evaluateC1TimeOffset(ctx)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// C2 — over-broadcasting
// ---------------------------------------------------------------------------

describe('evaluateC2', () => {
  it('fires when the position or telemetry median is under the threshold with enough samples', () => {
    const cadence = new Map([[1, { position: makeCadenceStats({ medianIntervalSeconds: 60 }), telemetry: null }]]);
    const ctx = makeContext([makeNode({ nodeNum: 1, role: DeviceRole.CLIENT_BASE, batteryLevel: 101 })], cadence);
    const findings = evaluateC2(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].issueType).toBe(MESH_ISSUE_TYPES.C2_OVER_BROADCASTING);
    expect(findings[0].evidence.stream).toBe('position');
  });

  it.each([DeviceRole.TRACKER, DeviceRole.SENSOR, DeviceRole.TAK_TRACKER])(
    'does not fire for exempt role %i',
    (role) => {
      const cadence = new Map([[1, { position: makeCadenceStats({ medianIntervalSeconds: 10 }), telemetry: null }]]);
      const ctx = makeContext([makeNode({ nodeNum: 1, role })], cadence);
      expect(evaluateC2(ctx)).toEqual([]);
    },
  );

  it('does not fire for a null role', () => {
    const cadence = new Map([[1, { position: makeCadenceStats({ medianIntervalSeconds: 10 }), telemetry: null }]]);
    const ctx = makeContext([makeNode({ nodeNum: 1, role: null })], cadence);
    expect(evaluateC2(ctx)).toEqual([]);
  });

  it('respects OVER_BROADCAST_MIN_SAMPLES — does not fire below the sample floor', () => {
    const cadence = new Map([
      [1, { position: makeCadenceStats({ medianIntervalSeconds: 10, sampleCount: OVER_BROADCAST_MIN_SAMPLES - 1 }), telemetry: null }],
    ]);
    const ctx = makeContext([makeNode({ nodeNum: 1 })], cadence);
    expect(evaluateC2(ctx)).toEqual([]);
  });

  it('fires at exactly OVER_BROADCAST_MIN_SAMPLES', () => {
    const cadence = new Map([
      [1, { position: makeCadenceStats({ medianIntervalSeconds: 10, sampleCount: OVER_BROADCAST_MIN_SAMPLES }), telemetry: null }],
    ]);
    const ctx = makeContext([makeNode({ nodeNum: 1 })], cadence);
    expect(evaluateC2(ctx)).toHaveLength(1);
  });

  it('picks the faster (lower-median) stream and emits exactly one finding when both qualify', () => {
    const cadence = new Map([
      [
        1,
        {
          position: makeCadenceStats({ medianIntervalSeconds: 30 }),
          telemetry: makeCadenceStats({ medianIntervalSeconds: 90 }),
        },
      ],
    ]);
    const ctx = makeContext([makeNode({ nodeNum: 1 })], cadence);
    const findings = evaluateC2(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].evidence.stream).toBe('position');
    expect(findings[0].evidence.otherStreamMedianSeconds).toBe(90);
  });

  it('picks telemetry when it is the faster stream', () => {
    const cadence = new Map([
      [
        1,
        {
          position: makeCadenceStats({ medianIntervalSeconds: 90 }),
          telemetry: makeCadenceStats({ medianIntervalSeconds: 30 }),
        },
      ],
    ]);
    const ctx = makeContext([makeNode({ nodeNum: 1 })], cadence);
    const findings = evaluateC2(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].evidence.stream).toBe('telemetry');
    expect(findings[0].evidence.otherStreamMedianSeconds).toBe(90);
  });

  it('severity is warning when the node is on battery (not powered)', () => {
    const cadence = new Map([[1, { position: makeCadenceStats({ medianIntervalSeconds: 250 }), telemetry: null }]]);
    // Not under half the threshold (150s), so severity comes purely from power state.
    const ctx = makeContext([makeNode({ nodeNum: 1, batteryLevel: 80 })], cadence);
    expect(evaluateC2(ctx)[0].severity).toBe('warning');
  });

  it('severity is info when the node is powered and not under half the threshold', () => {
    const cadence = new Map([[1, { position: makeCadenceStats({ medianIntervalSeconds: 250 }), telemetry: null }]]);
    const ctx = makeContext([makeNode({ nodeNum: 1, batteryLevel: 101 })], cadence); // >100 = powered
    expect(evaluateC2(ctx)[0].severity).toBe('info');
  });

  it('severity is warning when powered but the median is under half the threshold', () => {
    const cadence = new Map([[1, { position: makeCadenceStats({ medianIntervalSeconds: 100 }), telemetry: null }]]); // < 300/2=150
    const ctx = makeContext([makeNode({ nodeNum: 1, batteryLevel: 101 })], cadence);
    expect(evaluateC2(ctx)[0].severity).toBe('warning');
  });

  it('honours ctx.thresholds.overBroadcastSeconds — the same fixture fires or not depending on the threshold', () => {
    const cadence = new Map([[1, { position: makeCadenceStats({ medianIntervalSeconds: 200 }), telemetry: null }]]);
    const node = makeNode({ nodeNum: 1 });

    const strictCtx = makeContext([node], cadence, { ...DEFAULT_MESH_ISSUE_THRESHOLDS, overBroadcastSeconds: 100 });
    expect(evaluateC2(strictCtx)).toEqual([]); // 200 is not < 100

    const looseCtx = makeContext([node], cadence, { ...DEFAULT_MESH_ISSUE_THRESHOLDS, overBroadcastSeconds: 300 });
    expect(evaluateC2(looseCtx)).toHaveLength(1); // 200 < 300
  });

  it('does not fire when there is no cadence entry for the node at all', () => {
    const ctx = makeContext([makeNode({ nodeNum: 1 })], new Map());
    expect(evaluateC2(ctx)).toEqual([]);
  });

  it('falls back to the node\'s own sourceIds when the chosen stream carries none', () => {
    const cadence = new Map([
      [1, { position: makeCadenceStats({ medianIntervalSeconds: 60, sourceIds: [] }), telemetry: null }],
    ]);
    const ctx = makeContext([makeNode({ nodeNum: 1, sourceIds: ['src-fallback'] })], cadence);
    expect(evaluateC2(ctx)[0].sourceIds).toEqual(['src-fallback']);
  });
});

// ---------------------------------------------------------------------------
// evaluateAllTierC / tierCSkips
// ---------------------------------------------------------------------------

describe('evaluateAllTierC', () => {
  it('runs C1 and C2 together and never throws when a node is malformed', () => {
    const ctx = makeContext([
      makeNode({ nodeNum: 1, isExcessivePackets: true }),
      makeNode({ nodeNum: 2, keyMismatchDetected: true }),
    ]);
    const findings = evaluateAllTierC(ctx);
    expect(findings.map((f) => f.issueType).sort()).toEqual(
      [MESH_ISSUE_TYPES.C1_EXCESSIVE_PACKETS, MESH_ISSUE_TYPES.C1_KEY_SECURITY].sort(),
    );
  });

  it('no Tier C recommendation contains "promote" or suggests ROUTER (cross-rule guard)', () => {
    const cadence = new Map([[3, { position: makeCadenceStats({ medianIntervalSeconds: 10 }), telemetry: null }]]);
    const ctx = makeContext(
      [
        makeNode({ nodeNum: 1, isExcessivePackets: true }),
        makeNode({ nodeNum: 2, keyIsLowEntropy: true, duplicateKeyDetected: true, isTimeOffsetIssue: true, timeOffsetSeconds: 40 }),
        makeNode({ nodeNum: 3, role: DeviceRole.CLIENT }),
      ],
      cadence,
    );
    const findings = evaluateAllTierC(ctx);
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(finding.recommendation.toLowerCase()).not.toContain('promote');
      expect(finding.recommendation.toUpperCase()).not.toContain('ROUTER');
    }
  });
});

describe('tierCSkips', () => {
  it('reports C2 skipped when the cadence map is empty', () => {
    const ctx = makeContext([makeNode({ nodeNum: 1 })], new Map());
    expect(tierCSkips(ctx)).toEqual([{ rule: 'C2', reason: 'no position or telemetry cadence data' }]);
  });

  it('reports nothing skipped when the cadence map has entries', () => {
    const cadence = new Map([[1, { position: makeCadenceStats(), telemetry: null }]]);
    const ctx = makeContext([makeNode({ nodeNum: 1 })], cadence);
    expect(tierCSkips(ctx)).toEqual([]);
  });
});
