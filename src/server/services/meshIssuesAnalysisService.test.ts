/**
 * Tests for meshIssuesAnalysisService (#4964, Phase 1 WP3).
 *
 * `evaluateAllTierA` (WP2) is mocked here — its own predicate-by-predicate
 * behavior is covered by `meshIssues/rules.test.ts`. This suite is about
 * WP3's own orchestration: source resolution, the zeroed no-sources path,
 * upsert/clean-run persistence semantics, traceroute pagination capping, and
 * the zero-mesh-impact guarantees (no packets, no dataEventEmitter).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDb = vi.hoisted(() => ({
  sources: { getAllSources: vi.fn() },
  nodes: { getAllNodes: vi.fn() },
  telemetry: {
    getTelemetryByTypesSince: vi.fn(),
    getPositionTelemetryByNode: vi.fn(),
  },
  analysis: { getTraceroutes: vi.fn(), getNeighbors: vi.fn() },
  settings: { getSetting: vi.fn() },
  getMeshIssuesAsync: vi.fn(),
  upsertMeshIssueFindingAsync: vi.fn(),
  bumpMeshIssueCleanRunAsync: vi.fn(),
  getMqttDirectReceptionsByGatewayAsync: vi.fn(),
  getPacketHopArrivalCountsAsync: vi.fn(),
  getMqttPacketHopArrivalCountsAsync: vi.fn(),
  getTelemetryCadenceAggregatesAsync: vi.fn(),
  getTelemetryTimestampsAsync: vi.fn(),
}));
vi.mock('../../services/database.js', () => ({ default: mockDb }));

const mockRules = vi.hoisted(() => ({
  evaluateAllTierA: vi.fn(),
}));
vi.mock('./meshIssues/rules.js', () => mockRules);

const mockRulesTierB = vi.hoisted(() => ({
  evaluateAllTierB: vi.fn(),
  tierBSkips: vi.fn(),
}));
vi.mock('./meshIssues/rulesTierB.js', () => mockRulesTierB);

// `cadenceStatsFromTimestamps` stays REAL (via importOriginal) — the WP2
// hard-acceptance test below ("stage-2 query is called only for candidate
// nodes, chunked") exercises the service's real buildCadenceMap
// orchestration. Only the two "evaluate" entry points are mocked, matching
// the evaluateAllTierA/evaluateAllTierB precedent above.
const mockRulesTierC = vi.hoisted(() => ({
  evaluateAllTierC: vi.fn(),
  tierCSkips: vi.fn(),
}));
vi.mock('./meshIssues/rulesTierC.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./meshIssues/rulesTierC.js')>();
  return {
    ...actual,
    evaluateAllTierC: mockRulesTierC.evaluateAllTierC,
    tierCSkips: mockRulesTierC.tierCSkips,
  };
});

const mockRfGraph = vi.hoisted(() => ({
  buildRfGraph: vi.fn(),
}));
vi.mock('./meshIssues/rfGraph.js', () => mockRfGraph);

const mockPacketLogService = vi.hoisted(() => ({ isEnabled: vi.fn() }));
vi.mock('./packetLogService.js', () => ({ default: mockPacketLogService }));

const mockMqttPacketLogService = vi.hoisted(() => ({ isEnabled: vi.fn() }));
vi.mock('./mqttPacketLogService.js', () => ({ default: mockMqttPacketLogService }));

import { ALL_SOURCES } from '../../db/repositories/base.js';
import { dataEventEmitter } from './dataEventEmitter.js';
import { logger } from '../../utils/logger.js';
import { meshIssuesAnalysisService, MAX_CORPUS_PAGES } from './meshIssuesAnalysisService.js';

/** A fresh RfGraph-shaped stub each call — buildRfGraph is mocked, but the
 *  service reads/mutates `graph.stats.availability.packetLog` in place, so
 *  every test (and every call within a test) needs its own object. */
function makeGraphStats(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    availability: { neighborInfo: true, traceroute: false, mqttGateway: false, packetLog: false },
    neighborInfoRowCount: 0,
    neighborInfoEdgeCount: 0,
    tracerouteHopLinkCount: 0,
    tracerouteEdgeCount: 0,
    tracerouteSentinelHopsDropped: 0,
    gatewayCount: 0,
    gatewayDirectEdgeCount: 0,
    gatewayCoReceptionEdgeCount: 0,
    gatewayCellsSkipped: 0,
    totalEdgeCount: 0,
    directEdgeCount: 0,
    nodeCount: 0,
    snrDirectionsWithMinSamples: 0,
    ...overrides,
  };
}

function makeGraph(statsOverrides: Partial<Record<string, unknown>> = {}) {
  return {
    edges: new Map(),
    directAdjacency: new Map(),
    adjacency: new Map(),
    stats: makeGraphStats(statsOverrides),
  };
}

/**
 * Default `buildRfGraph` mock implementation: mirrors the real module's
 * `stats.availability = opts.availability` pass-through (same object
 * reference, so the service's later `graph.stats.availability.packetLog =
 * ...` mutation is visible on `result.coverage.evidence` exactly as it is
 * in production). Tests that only care about non-availability stats fields
 * override with `mockRfGraph.buildRfGraph.mockImplementation(() => makeGraph({...}))`.
 */
function graphEchoingAvailability(opts: { availability: Record<string, unknown> }) {
  const graph = makeGraph();
  graph.stats.availability = opts.availability as typeof graph.stats.availability;
  return graph;
}

const NOW = 1_700_000_000_000;

function makeSource(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'src-a',
    name: 'Source A',
    type: 'meshtastic_tcp',
    config: {},
    enabled: true,
    displayOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    createdBy: null,
    ...overrides,
  };
}

function makeNodeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    nodeNum: 100,
    nodeId: '!00000064',
    sourceId: 'src-a',
    longName: 'Node 100',
    shortName: 'N100',
    hwModel: 1,
    role: null,
    isUnmessagable: null,
    firmwareVersion: null,
    batteryLevel: null,
    voltage: null,
    channelUtilization: null,
    airUtilTx: null,
    latitude: null,
    longitude: null,
    positionOverrideEnabled: null,
    latitudeOverride: null,
    longitudeOverride: null,
    positionPrecisionBits: null,
    mobile: null,
    lastHeard: Math.floor(NOW / 1000),
    updatedAt: NOW,
    isExcessivePackets: null,
    packetRatePerHour: null,
    keyIsLowEntropy: null,
    duplicateKeyDetected: null,
    keyMismatchDetected: null,
    keySecurityIssueDetails: null,
    isTimeOffsetIssue: null,
    timeOffsetSeconds: null,
    ...overrides,
  };
}

function makeTracerouteRow(id: number) {
  return {
    id,
    fromNodeNum: 1,
    toNodeNum: 2,
    sourceId: 'src-a',
    route: null,
    routeBack: null,
    snrTowards: null,
    snrBack: null,
    timestamp: NOW,
    createdAt: NOW,
    packetId: id,
  };
}

function makeFinding(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    issueType: 'A1_deprecated_role',
    subjectKey: 'node:100',
    nodeNum: 100,
    severity: 'warning',
    confidence: 'high',
    evidence: {},
    sourceIds: ['src-a'],
    recommendation: 'Consider CLIENT.',
    ...overrides,
  };
}

describe('meshIssuesAnalysisService.runAnalysis', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.settings.getSetting.mockResolvedValue(null);
    mockDb.telemetry.getTelemetryByTypesSince.mockResolvedValue([]);
    mockDb.telemetry.getPositionTelemetryByNode.mockResolvedValue([]);
    mockDb.analysis.getTraceroutes.mockResolvedValue({
      items: [], pageSize: 2000, hasMore: false, nextCursor: null,
    });
    mockDb.analysis.getNeighbors.mockResolvedValue({ items: [] });
    mockDb.getMeshIssuesAsync.mockResolvedValue([]);
    mockDb.upsertMeshIssueFindingAsync.mockResolvedValue({ issue: {}, outcome: 'created' });
    mockDb.bumpMeshIssueCleanRunAsync.mockResolvedValue({ cleanRuns: 1, closed: false });
    mockDb.getMqttDirectReceptionsByGatewayAsync.mockResolvedValue([]);
    mockDb.getPacketHopArrivalCountsAsync.mockResolvedValue([]);
    mockDb.getMqttPacketHopArrivalCountsAsync.mockResolvedValue([]);
    mockDb.getTelemetryCadenceAggregatesAsync.mockResolvedValue([]);
    mockDb.getTelemetryTimestampsAsync.mockResolvedValue([]);
    mockRules.evaluateAllTierA.mockReturnValue([]);
    mockRulesTierB.evaluateAllTierB.mockReturnValue([]);
    mockRulesTierB.tierBSkips.mockReturnValue([]);
    mockRulesTierC.evaluateAllTierC.mockReturnValue([]);
    mockRulesTierC.tierCSkips.mockReturnValue([]);
    mockRfGraph.buildRfGraph.mockImplementation(graphEchoingAvailability);
    mockPacketLogService.isEnabled.mockResolvedValue(false);
    mockMqttPacketLogService.isEnabled.mockResolvedValue(false);
  });

  describe('no Meshtastic-family sources', () => {
    it('returns a zeroed result and writes nothing when there are no sources at all', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([]);

      const result = await meshIssuesAnalysisService.runAnalysis({ lookbackHours: 168, pairBucketHours: 6, nowMs: NOW });

      expect(result.sourceCount).toBe(0);
      expect(result.nodeCount).toBe(0);
      expect(result.findingCount).toBe(0);
      expect(result.newCount).toBe(0);
      expect(result.closedCount).toBe(0);
      expect(result.byType).toEqual({});
      expect(result.corpusStats.truncated).toBe(false);

      expect(mockDb.nodes.getAllNodes).not.toHaveBeenCalled();
      expect(mockDb.telemetry.getTelemetryByTypesSince).not.toHaveBeenCalled();
      expect(mockDb.analysis.getTraceroutes).not.toHaveBeenCalled();
      expect(mockDb.upsertMeshIssueFindingAsync).not.toHaveBeenCalled();
      expect(mockDb.bumpMeshIssueCleanRunAsync).not.toHaveBeenCalled();
    });

    it('returns a zeroed result when every source is disabled or non-Meshtastic (e.g. meshcore)', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([
        makeSource({ id: 'disabled', enabled: false }),
        makeSource({ id: 'meshcore-1', type: 'meshcore' }),
      ]);

      const result = await meshIssuesAnalysisService.runAnalysis({ lookbackHours: 168, pairBucketHours: 6, nowMs: NOW });

      expect(result.sourceCount).toBe(0);
      expect(mockDb.nodes.getAllNodes).not.toHaveBeenCalled();
      expect(mockDb.upsertMeshIssueFindingAsync).not.toHaveBeenCalled();
    });

    it('includes mqtt_broker / mqtt_bridge sources alongside meshtastic_tcp', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([
        makeSource({ id: 'src-a', type: 'meshtastic_tcp' }),
        makeSource({ id: 'src-b', type: 'mqtt_broker' }),
      ]);
      mockDb.nodes.getAllNodes.mockResolvedValue([]);

      const result = await meshIssuesAnalysisService.runAnalysis({ lookbackHours: 168, pairBucketHours: 6, nowMs: NOW });

      expect(result.sourceCount).toBe(2);
      expect(mockDb.nodes.getAllNodes).toHaveBeenCalledWith(ALL_SOURCES);
    });
  });

  describe('persistence semantics', () => {
    beforeEach(() => {
      mockDb.sources.getAllSources.mockResolvedValue([makeSource()]);
      mockDb.nodes.getAllNodes.mockResolvedValue([makeNodeRow()]);
    });

    it('persists each finding via upsertFinding and tallies outcomes + byType', async () => {
      const findings = [
        makeFinding({ issueType: 'A1_deprecated_role', subjectKey: 'node:100' }),
        makeFinding({ issueType: 'A2a_chatty_node', subjectKey: 'node:200', nodeNum: 200 }),
      ];
      mockRules.evaluateAllTierA.mockReturnValue(findings);
      mockDb.upsertMeshIssueFindingAsync.mockImplementation(async (finding: any) => ({
        issue: {},
        outcome: finding.subjectKey === 'node:100' ? 'created' : 'updated',
      }));

      const result = await meshIssuesAnalysisService.runAnalysis({ lookbackHours: 168, pairBucketHours: 6, nowMs: NOW });

      expect(mockDb.upsertMeshIssueFindingAsync).toHaveBeenCalledTimes(2);
      expect(mockDb.upsertMeshIssueFindingAsync).toHaveBeenCalledWith(findings[0], NOW);
      expect(mockDb.upsertMeshIssueFindingAsync).toHaveBeenCalledWith(findings[1], NOW);
      expect(result.findingCount).toBe(2);
      expect(result.newCount).toBe(1);
      expect(result.updatedCount).toBe(1);
      expect(result.reopenedCount).toBe(0);
      expect(result.byType).toEqual({ A1_deprecated_role: 1, A2a_chatty_node: 1 });
    });

    it('bumps cleanRuns for an open issue absent from this run, and skips one that is present', async () => {
      mockRules.evaluateAllTierA.mockReturnValue([
        makeFinding({ issueType: 'A1_deprecated_role', subjectKey: 'node:100' }),
      ]);
      mockDb.getMeshIssuesAsync.mockResolvedValue([
        { id: 1, issueType: 'A1_deprecated_role', subjectKey: 'node:100' }, // present -> no bump
        { id: 2, issueType: 'A3_infra_power', subjectKey: 'node:300' },      // absent -> bump, stays open
        { id: 3, issueType: 'A4_mobile_infra', subjectKey: 'node:400' },     // absent -> bump, auto-closes
      ]);
      mockDb.bumpMeshIssueCleanRunAsync.mockImplementation(async (id: number) =>
        id === 3 ? { cleanRuns: 3, closed: true } : { cleanRuns: 1, closed: false }
      );

      const result = await meshIssuesAnalysisService.runAnalysis({ lookbackHours: 168, pairBucketHours: 6, nowMs: NOW });

      expect(mockDb.getMeshIssuesAsync).toHaveBeenCalledWith({ includeClosed: false, includeDismissed: true });
      expect(mockDb.bumpMeshIssueCleanRunAsync).toHaveBeenCalledTimes(2);
      expect(mockDb.bumpMeshIssueCleanRunAsync).toHaveBeenCalledWith(2, expect.any(Number), NOW);
      expect(mockDb.bumpMeshIssueCleanRunAsync).toHaveBeenCalledWith(3, expect.any(Number), NOW);
      expect(mockDb.bumpMeshIssueCleanRunAsync).not.toHaveBeenCalledWith(1, expect.any(Number), NOW);
      expect(result.closedCount).toBe(1);
    });

    it('surfaces corpusStats on the result even with an empty traceroute corpus', async () => {
      const result = await meshIssuesAnalysisService.runAnalysis({ lookbackHours: 168, pairBucketHours: 6, nowMs: NOW });
      expect(result.corpusStats).toEqual({
        rawCount: 0,
        validCount: 0,
        dedupedCount: 0,
        sampledCount: 0,
        distinctPairCount: 0,
        truncated: false,
      });
    });
  });

  describe('traceroute pagination cap', () => {
    it('stops at MAX_CORPUS_PAGES and sets corpusStats.truncated when more pages remain', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([makeSource()]);
      mockDb.nodes.getAllNodes.mockResolvedValue([]);
      let call = 0;
      mockDb.analysis.getTraceroutes.mockImplementation(async () => {
        call += 1;
        return { items: [makeTracerouteRow(call)], pageSize: 2000, hasMore: true, nextCursor: `cursor-${call}` };
      });

      const result = await meshIssuesAnalysisService.runAnalysis({ lookbackHours: 168, pairBucketHours: 6, nowMs: NOW });

      expect(mockDb.analysis.getTraceroutes).toHaveBeenCalledTimes(MAX_CORPUS_PAGES);
      expect(result.corpusStats.truncated).toBe(true);
      expect(result.corpusStats.rawCount).toBe(MAX_CORPUS_PAGES);
    });

    it('does not report truncated when the natural end of the result set is reached before the cap', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([makeSource()]);
      mockDb.nodes.getAllNodes.mockResolvedValue([]);
      mockDb.analysis.getTraceroutes
        .mockResolvedValueOnce({ items: [makeTracerouteRow(1)], pageSize: 2000, hasMore: true, nextCursor: 'c1' })
        .mockResolvedValueOnce({ items: [makeTracerouteRow(2)], pageSize: 2000, hasMore: false, nextCursor: null });

      const result = await meshIssuesAnalysisService.runAnalysis({ lookbackHours: 168, pairBucketHours: 6, nowMs: NOW });

      expect(mockDb.analysis.getTraceroutes).toHaveBeenCalledTimes(2);
      expect(result.corpusStats.truncated).toBe(false);
      expect(result.corpusStats.rawCount).toBe(2);
    });
  });

  describe('mesh-impact guarantees', () => {
    it('sends no packets and never calls dataEventEmitter, even on a full Tier A + Tier B run that finds and closes issues', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([makeSource(), makeSource({ id: 'src-b', type: 'mqtt_broker' })]);
      mockDb.nodes.getAllNodes.mockResolvedValue([makeNodeRow()]);
      mockDb.analysis.getNeighbors.mockResolvedValue({
        items: [{ id: 1, nodeNum: 100, neighborNum: 200, sourceId: 'src-a', snr: 5, timestamp: NOW }],
      });
      mockPacketLogService.isEnabled.mockResolvedValue(true);
      mockDb.getPacketHopArrivalCountsAsync.mockResolvedValue([{ nodeNum: 100, totalPackets: 30, exhaustedPackets: 20 }]);
      mockMqttPacketLogService.isEnabled.mockResolvedValue(true);
      mockDb.getMqttDirectReceptionsByGatewayAsync.mockResolvedValue([
        { gatewayNodeNum: 300, fromNode: 100, sourceId: 'src-b', receptionCount: 5, meanRxSnr: 3, firstSeen: NOW, lastSeen: NOW },
      ]);
      mockRules.evaluateAllTierA.mockReturnValue([makeFinding()]);
      mockRulesTierB.evaluateAllTierB.mockReturnValue([
        makeFinding({ issueType: 'B6_hop_horizon', subjectKey: 'node:100', nodeNum: 100 }),
      ]);
      mockDb.getMeshIssuesAsync.mockResolvedValue([
        { id: 9, issueType: 'A3_infra_power', subjectKey: 'node:900' },
      ]);
      mockDb.bumpMeshIssueCleanRunAsync.mockResolvedValue({ cleanRuns: 3, closed: true });

      const emitSpy = vi.spyOn(dataEventEmitter, 'emit');

      await meshIssuesAnalysisService.runAnalysis({ lookbackHours: 168, pairBucketHours: 6, nowMs: NOW });

      expect(emitSpy).not.toHaveBeenCalled();
      emitSpy.mockRestore();
    });
  });

  describe('Tier B integration (WP5a)', () => {
    beforeEach(() => {
      mockDb.sources.getAllSources.mockResolvedValue([makeSource()]);
      mockDb.nodes.getAllNodes.mockResolvedValue([makeNodeRow()]);
    });

    it('persists Tier B findings alongside Tier A findings', async () => {
      mockRules.evaluateAllTierA.mockReturnValue([
        makeFinding({ issueType: 'A1_deprecated_role', subjectKey: 'node:100' }),
      ]);
      mockRulesTierB.evaluateAllTierB.mockReturnValue([
        makeFinding({ issueType: 'B1_router_cluster', subjectKey: 'cluster:2:abcd', nodeNum: null }),
      ]);

      const result = await meshIssuesAnalysisService.runAnalysis({ lookbackHours: 168, pairBucketHours: 6, nowMs: NOW });

      expect(mockDb.upsertMeshIssueFindingAsync).toHaveBeenCalledTimes(2);
      expect(result.findingCount).toBe(2);
      expect(result.byType).toEqual({ A1_deprecated_role: 1, B1_router_cluster: 1 });
    });

    it('passes the corpus samples (not just stats) through to buildRfGraph', async () => {
      mockDb.analysis.getTraceroutes.mockResolvedValueOnce({
        items: [makeTracerouteRow(1)], pageSize: 2000, hasMore: false, nextCursor: null,
      });

      await meshIssuesAnalysisService.runAnalysis({ lookbackHours: 168, pairBucketHours: 6, nowMs: NOW });

      expect(mockRfGraph.buildRfGraph).toHaveBeenCalledTimes(1);
      const graphArgs = mockRfGraph.buildRfGraph.mock.calls[0][0];
      expect(Array.isArray(graphArgs.samples)).toBe(true);
    });

    it('calls getNeighbors exactly once with the resolved sourceIds and sinceMs — no per-node loop', async () => {
      await meshIssuesAnalysisService.runAnalysis({ lookbackHours: 168, pairBucketHours: 6, nowMs: NOW });

      expect(mockDb.analysis.getNeighbors).toHaveBeenCalledTimes(1);
      expect(mockDb.analysis.getNeighbors).toHaveBeenCalledWith({
        sourceIds: ['src-a'],
        sinceMs: NOW - 168 * 3600_000,
      });
    });

    it('does not call the gateway aggregate when mqttPacketLogService.isEnabled() is false', async () => {
      mockMqttPacketLogService.isEnabled.mockResolvedValue(false);

      const result = await meshIssuesAnalysisService.runAnalysis({ lookbackHours: 168, pairBucketHours: 6, nowMs: NOW });

      expect(mockDb.getMqttDirectReceptionsByGatewayAsync).not.toHaveBeenCalled();
      expect(result.coverage.evidence.mqttGateway).toBe(false);
    });

    it('does not call the gateway aggregate when no MQTT source is resolved, even if the setting is enabled', async () => {
      mockMqttPacketLogService.isEnabled.mockResolvedValue(true);
      mockDb.sources.getAllSources.mockResolvedValue([makeSource()]); // meshtastic_tcp only

      const result = await meshIssuesAnalysisService.runAnalysis({ lookbackHours: 168, pairBucketHours: 6, nowMs: NOW });

      expect(mockDb.getMqttDirectReceptionsByGatewayAsync).not.toHaveBeenCalled();
      expect(result.coverage.evidence.mqttGateway).toBe(false);
    });

    it('calls the gateway aggregate and sets availability.mqttGateway true when enabled with an MQTT source', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([makeSource(), makeSource({ id: 'src-b', type: 'mqtt_broker' })]);
      mockMqttPacketLogService.isEnabled.mockResolvedValue(true);
      mockDb.getMqttDirectReceptionsByGatewayAsync.mockResolvedValue([
        { gatewayNodeNum: 300, fromNode: 100, sourceId: 'src-b', receptionCount: 5, meanRxSnr: 3, firstSeen: NOW, lastSeen: NOW },
      ]);

      const result = await meshIssuesAnalysisService.runAnalysis({ lookbackHours: 168, pairBucketHours: 6, nowMs: NOW });

      expect(mockDb.getMqttDirectReceptionsByGatewayAsync).toHaveBeenCalledWith({
        sourceIds: ['src-b'],
        since: NOW - 168 * 3600_000,
      });
      expect(result.coverage.evidence.mqttGateway).toBe(true);
    });

    it('degrades (does not abort) when the neighbours query throws — Tier A findings still persist', async () => {
      mockDb.analysis.getNeighbors.mockRejectedValue(new Error('neighbors boom'));
      mockRules.evaluateAllTierA.mockReturnValue([makeFinding()]);
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      const result = await meshIssuesAnalysisService.runAnalysis({ lookbackHours: 168, pairBucketHours: 6, nowMs: NOW });

      expect(warnSpy).toHaveBeenCalled();
      expect(result.coverage.evidence.neighborInfo).toBe(false);
      expect(mockRfGraph.buildRfGraph).toHaveBeenCalledTimes(1);
      expect(mockRfGraph.buildRfGraph.mock.calls[0][0].neighbors).toEqual([]);
      expect(mockDb.upsertMeshIssueFindingAsync).toHaveBeenCalledTimes(1);
      expect(result.findingCount).toBe(1);
      warnSpy.mockRestore();
    });

    it('degrades (does not abort) when the gateway-receptions query throws', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([makeSource(), makeSource({ id: 'src-b', type: 'mqtt_broker' })]);
      mockMqttPacketLogService.isEnabled.mockResolvedValue(true);
      mockDb.getMqttDirectReceptionsByGatewayAsync.mockRejectedValue(new Error('gateway boom'));
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      const result = await meshIssuesAnalysisService.runAnalysis({ lookbackHours: 168, pairBucketHours: 6, nowMs: NOW });

      expect(warnSpy).toHaveBeenCalled();
      expect(result.coverage.evidence.mqttGateway).toBe(false);
      warnSpy.mockRestore();
    });

    it('degrades (does not abort) when the hop-horizon packet_log query throws', async () => {
      mockPacketLogService.isEnabled.mockResolvedValue(true);
      mockDb.getPacketHopArrivalCountsAsync.mockRejectedValue(new Error('hop-horizon boom'));
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      const result = await meshIssuesAnalysisService.runAnalysis({ lookbackHours: 168, pairBucketHours: 6, nowMs: NOW });

      expect(warnSpy).toHaveBeenCalled();
      expect(result.coverage.hopHorizonSource).toBeNull();
      expect(result.coverage.evidence.packetLog).toBe(false);
      warnSpy.mockRestore();
    });
  });

  describe('tier gating (#4964 Phase 3 WP1)', () => {
    beforeEach(() => {
      mockDb.sources.getAllSources.mockResolvedValue([makeSource()]);
      mockDb.nodes.getAllNodes.mockResolvedValue([makeNodeRow()]);
    });

    it('does not evaluate Tier A, and produces no A findings, when mesh_issues_tier_a_enabled is false', async () => {
      mockDb.settings.getSetting.mockImplementation(async (key: string) =>
        key === 'mesh_issues_tier_a_enabled' ? 'false' : null,
      );
      mockRules.evaluateAllTierA.mockReturnValue([
        makeFinding({ issueType: 'A1_deprecated_role', subjectKey: 'node:100' }),
      ]);

      const result = await meshIssuesAnalysisService.runAnalysis({ lookbackHours: 168, pairBucketHours: 6, nowMs: NOW });

      expect(mockRules.evaluateAllTierA).not.toHaveBeenCalled();
      expect(result.findingCount).toBe(0);
      expect(result.byType).toEqual({});
    });

    it('does not evaluate Tier B, and produces no B findings, when mesh_issues_tier_b_enabled is false', async () => {
      mockDb.settings.getSetting.mockImplementation(async (key: string) =>
        key === 'mesh_issues_tier_b_enabled' ? 'false' : null,
      );
      mockRulesTierB.evaluateAllTierB.mockReturnValue([
        makeFinding({ issueType: 'B1_router_cluster', subjectKey: 'cluster:2:abcd', nodeNum: null }),
      ]);

      const result = await meshIssuesAnalysisService.runAnalysis({ lookbackHours: 168, pairBucketHours: 6, nowMs: NOW });

      expect(mockRulesTierB.evaluateAllTierB).not.toHaveBeenCalled();
      expect(result.findingCount).toBe(0);
    });

    it('a disabled tier still bumps cleanRuns for its existing open findings (auto-close, no row deletion)', async () => {
      mockDb.settings.getSetting.mockImplementation(async (key: string) =>
        key === 'mesh_issues_tier_a_enabled' ? 'false' : null,
      );
      mockDb.getMeshIssuesAsync.mockResolvedValue([
        { id: 42, issueType: 'A1_deprecated_role', subjectKey: 'node:100' },
      ]);

      await meshIssuesAnalysisService.runAnalysis({ lookbackHours: 168, pairBucketHours: 6, nowMs: NOW });

      expect(mockDb.bumpMeshIssueCleanRunAsync).toHaveBeenCalledWith(42, expect.any(Number), NOW);
    });

    it('resolves thresholds once and passes the same resolved values into both the Tier A and Tier B contexts', async () => {
      mockDb.settings.getSetting.mockImplementation(async (key: string) =>
        key === 'mesh_issues_air_util_tx_pct' ? '15' : null,
      );

      await meshIssuesAnalysisService.runAnalysis({ lookbackHours: 168, pairBucketHours: 6, nowMs: NOW });

      const tierACtx = mockRules.evaluateAllTierA.mock.calls[0][0];
      const tierBCtx = mockRulesTierB.evaluateAllTierB.mock.calls[0][0];
      expect(tierACtx.thresholds.airUtilTxPct).toBe(15);
      expect(tierBCtx.thresholds.airUtilTxPct).toBe(15);
      expect(tierACtx.thresholds).toEqual(tierBCtx.thresholds);
    });
  });

  describe('hop-horizon preference (spec §3.3, D8)', () => {
    beforeEach(() => {
      mockDb.sources.getAllSources.mockResolvedValue([makeSource(), makeSource({ id: 'src-b', type: 'mqtt_broker' })]);
      mockDb.nodes.getAllNodes.mockResolvedValue([makeNodeRow()]);
    });

    it('prefers packet_log when it returns rows', async () => {
      mockPacketLogService.isEnabled.mockResolvedValue(true);
      mockDb.getPacketHopArrivalCountsAsync.mockResolvedValue([{ nodeNum: 100, totalPackets: 30, exhaustedPackets: 20 }]);
      mockMqttPacketLogService.isEnabled.mockResolvedValue(true);
      mockDb.getMqttPacketHopArrivalCountsAsync.mockResolvedValue([{ nodeNum: 100, totalPackets: 99, exhaustedPackets: 99 }]);

      const result = await meshIssuesAnalysisService.runAnalysis({ lookbackHours: 168, pairBucketHours: 6, nowMs: NOW });

      expect(result.coverage.hopHorizonSource).toBe('packet_log');
      expect(result.coverage.hopHorizonNodeCount).toBe(1);
      expect(mockDb.getMqttPacketHopArrivalCountsAsync).not.toHaveBeenCalled();
      const tierBArgs = mockRulesTierB.evaluateAllTierB.mock.calls[0][0];
      expect(tierBArgs.hopHorizon.get(100)).toEqual({ totalPackets: 30, exhaustedPackets: 20, sourceIds: ['src-a', 'src-b'] });
    });

    it('falls back to mqtt_packet_log when packet_log is enabled but returns nothing', async () => {
      mockPacketLogService.isEnabled.mockResolvedValue(true);
      mockDb.getPacketHopArrivalCountsAsync.mockResolvedValue([]);
      mockMqttPacketLogService.isEnabled.mockResolvedValue(true);
      mockDb.getMqttPacketHopArrivalCountsAsync.mockResolvedValue([{ nodeNum: 100, totalPackets: 25, exhaustedPackets: 20 }]);

      const result = await meshIssuesAnalysisService.runAnalysis({ lookbackHours: 168, pairBucketHours: 6, nowMs: NOW });

      expect(result.coverage.hopHorizonSource).toBe('mqtt_packet_log');
      expect(result.coverage.hopHorizonNodeCount).toBe(1);
      expect(mockDb.getMqttPacketHopArrivalCountsAsync).toHaveBeenCalledWith({
        sourceIds: ['src-b'],
        since: NOW - 168 * 3600_000,
      });
    });

    it('falls back to mqtt_packet_log when packet_log is not enabled at all', async () => {
      mockPacketLogService.isEnabled.mockResolvedValue(false);
      mockMqttPacketLogService.isEnabled.mockResolvedValue(true);
      mockDb.getMqttPacketHopArrivalCountsAsync.mockResolvedValue([{ nodeNum: 100, totalPackets: 25, exhaustedPackets: 20 }]);

      const result = await meshIssuesAnalysisService.runAnalysis({ lookbackHours: 168, pairBucketHours: 6, nowMs: NOW });

      expect(mockDb.getPacketHopArrivalCountsAsync).not.toHaveBeenCalled();
      expect(result.coverage.hopHorizonSource).toBe('mqtt_packet_log');
    });

    it('reports B6 in skippedRules and an empty hopHorizon when neither log is usable', async () => {
      mockPacketLogService.isEnabled.mockResolvedValue(false);
      mockMqttPacketLogService.isEnabled.mockResolvedValue(false);
      mockRulesTierB.tierBSkips.mockReturnValue([{ rule: 'B6', reason: 'no packet log enabled' }]);

      const result = await meshIssuesAnalysisService.runAnalysis({ lookbackHours: 168, pairBucketHours: 6, nowMs: NOW });

      expect(result.coverage.hopHorizonSource).toBeNull();
      expect(result.coverage.hopHorizonNodeCount).toBe(0);
      const tierBArgs = mockRulesTierB.evaluateAllTierB.mock.calls[0][0];
      expect(tierBArgs.hopHorizon.size).toBe(0);
      expect(result.coverage.skippedRules).toEqual([{ rule: 'B6', reason: 'no packet log enabled' }]);
    });
  });

  describe('coverage (spec §2.9)', () => {
    beforeEach(() => {
      mockDb.sources.getAllSources.mockResolvedValue([makeSource()]);
      mockDb.nodes.getAllNodes.mockResolvedValue([makeNodeRow()]);
    });

    it('is present on the result and arithmetically consistent with the RF graph stats', async () => {
      mockRfGraph.buildRfGraph.mockImplementation(() =>
        makeGraph({
          neighborInfoRowCount: 4,
          neighborInfoEdgeCount: 2,
          tracerouteEdgeCount: 3,
          tracerouteSentinelHopsDropped: 1,
          gatewayCount: 1,
          gatewayDirectEdgeCount: 1,
          gatewayCoReceptionEdgeCount: 0,
          gatewayCellsSkipped: 0,
          directEdgeCount: 5,
          totalEdgeCount: 6,
          nodeCount: 7,
          snrDirectionsWithMinSamples: 2,
        }),
      );

      const result = await meshIssuesAnalysisService.runAnalysis({ lookbackHours: 168, pairBucketHours: 6, nowMs: NOW });

      expect(result.coverage).toMatchObject({
        neighborInfoRowCount: 4,
        neighborInfoEdgeCount: 2,
        tracerouteEdgeCount: 3,
        tracerouteSentinelHopsDropped: 1,
        gatewayCount: 1,
        gatewayDirectEdgeCount: 1,
        gatewayCoReceptionEdgeCount: 0,
        gatewayCellsSkipped: 0,
        directEdgeCount: 5,
        totalEdgeCount: 6,
        graphNodeCount: 7,
        snrDirectionsWithMinSamples: 2,
      });
      // directEdgeCount can never exceed totalEdgeCount.
      expect(result.coverage.directEdgeCount).toBeLessThanOrEqual(result.coverage.totalEdgeCount);
    });

    it('is present (zeroed) on the no-sources short-circuit path', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([]);

      const result = await meshIssuesAnalysisService.runAnalysis({ lookbackHours: 168, pairBucketHours: 6, nowMs: NOW });

      expect(result.coverage.totalEdgeCount).toBe(0);
      expect(result.coverage.hopHorizonSource).toBeNull();
      expect(result.coverage.skippedRules).toEqual([]);
    });
  });

  describe('Tier C integration (#4964 Phase 3 WP2)', () => {
    beforeEach(() => {
      mockDb.sources.getAllSources.mockResolvedValue([makeSource()]);
      mockDb.nodes.getAllNodes.mockResolvedValue([makeNodeRow()]);
    });

    it('does not evaluate Tier C, and produces no C findings, when mesh_issues_tier_c_enabled is false', async () => {
      mockDb.settings.getSetting.mockImplementation(async (key: string) =>
        key === 'mesh_issues_tier_c_enabled' ? 'false' : null,
      );
      mockRulesTierC.evaluateAllTierC.mockReturnValue([
        makeFinding({ issueType: 'C1_excessive_packets', subjectKey: 'node:100' }),
      ]);

      const result = await meshIssuesAnalysisService.runAnalysis({ lookbackHours: 168, pairBucketHours: 6, nowMs: NOW });

      expect(mockRulesTierC.evaluateAllTierC).not.toHaveBeenCalled();
      expect(result.findingCount).toBe(0);
    });

    it('a disabled Tier C still bumps cleanRuns for its existing open findings (auto-close, no row deletion)', async () => {
      mockDb.settings.getSetting.mockImplementation(async (key: string) =>
        key === 'mesh_issues_tier_c_enabled' ? 'false' : null,
      );
      mockDb.getMeshIssuesAsync.mockResolvedValue([
        { id: 55, issueType: 'C1_excessive_packets', subjectKey: 'node:100' },
      ]);

      await meshIssuesAnalysisService.runAnalysis({ lookbackHours: 168, pairBucketHours: 6, nowMs: NOW });

      expect(mockDb.bumpMeshIssueCleanRunAsync).toHaveBeenCalledWith(55, expect.any(Number), NOW);
    });

    it('resolves thresholds once and passes the same resolved thresholds into the Tier C context too', async () => {
      mockDb.settings.getSetting.mockImplementation(async (key: string) =>
        key === 'mesh_issues_over_broadcast_seconds' ? '120' : null,
      );

      await meshIssuesAnalysisService.runAnalysis({ lookbackHours: 168, pairBucketHours: 6, nowMs: NOW });

      const tierACtx = mockRules.evaluateAllTierA.mock.calls[0][0];
      const tierCCtx = mockRulesTierC.evaluateAllTierC.mock.calls[0][0];
      expect(tierCCtx.thresholds.overBroadcastSeconds).toBe(120);
      expect(tierCCtx.thresholds).toEqual(tierACtx.thresholds);
    });

    it('passes opts.lookbackHours through as windowHours on the Tier C context', async () => {
      await meshIssuesAnalysisService.runAnalysis({ lookbackHours: 72, pairBucketHours: 6, nowMs: NOW });

      const tierCCtx = mockRulesTierC.evaluateAllTierC.mock.calls[0][0];
      expect(tierCCtx.windowHours).toBe(72);
    });

    it('maps the eight Tier C node columns from NodeRow into the pooled snapshot', async () => {
      mockDb.nodes.getAllNodes.mockResolvedValue([
        makeNodeRow({
          isExcessivePackets: true,
          packetRatePerHour: 42,
          keyIsLowEntropy: true,
          duplicateKeyDetected: false,
          keyMismatchDetected: false,
          keySecurityIssueDetails: 'low-entropy key',
          isTimeOffsetIssue: true,
          timeOffsetSeconds: -90,
        }),
      ]);

      await meshIssuesAnalysisService.runAnalysis({ lookbackHours: 168, pairBucketHours: 6, nowMs: NOW });

      const tierCCtx = mockRulesTierC.evaluateAllTierC.mock.calls[0][0];
      const node = tierCCtx.nodes.get(100);
      expect(node.isExcessivePackets).toBe(true);
      expect(node.packetRatePerHour).toBe(42);
      expect(node.keyIsLowEntropy).toBe(true);
      expect(node.keySecurityIssueDetails).toBe('low-entropy key');
      expect(node.isTimeOffsetIssue).toBe(true);
      expect(node.timeOffsetSeconds).toBe(-90);
    });

    it('includes tierCSkips in coverage.skippedRules alongside tierBSkips', async () => {
      mockRulesTierB.tierBSkips.mockReturnValue([{ rule: 'B6', reason: 'no packet log enabled' }]);
      mockRulesTierC.tierCSkips.mockReturnValue([{ rule: 'C2', reason: 'no position or telemetry cadence data' }]);

      const result = await meshIssuesAnalysisService.runAnalysis({ lookbackHours: 168, pairBucketHours: 6, nowMs: NOW });

      expect(result.coverage.skippedRules).toEqual([
        { rule: 'B6', reason: 'no packet log enabled' },
        { rule: 'C2', reason: 'no position or telemetry cadence data' },
      ]);
    });

    it('persists Tier C findings alongside Tier A findings', async () => {
      mockRulesTierC.evaluateAllTierC.mockReturnValue([
        makeFinding({ issueType: 'C1_excessive_packets', subjectKey: 'node:100' }),
      ]);

      const result = await meshIssuesAnalysisService.runAnalysis({ lookbackHours: 168, pairBucketHours: 6, nowMs: NOW });

      expect(result.findingCount).toBe(1);
      expect(result.byType).toEqual({ C1_excessive_packets: 1 });
    });
  });

  describe('C2 cadence — real buildCadenceMap orchestration (#4964 Phase 3 WP2 hard acceptance)', () => {
    beforeEach(() => {
      mockDb.sources.getAllSources.mockResolvedValue([makeSource()]);
      mockDb.nodes.getAllNodes.mockResolvedValue([makeNodeRow()]);
    });

    function makeAggregate(overrides: Partial<Record<string, unknown>> = {}) {
      return {
        nodeNum: 1,
        telemetryType: 'latitude',
        sampleCount: 10,
        firstTimestamp: 0,
        lastTimestamp: 9000, // mean = 9000/1000/9 = 1s -> well under any threshold*factor gate
        ...overrides,
      };
    }

    it('does not call the stage-2 timestamps query at all when the candidate set is empty', async () => {
      // sampleCount below OVER_BROADCAST_MIN_SAMPLES (6) -> never a candidate.
      mockDb.getTelemetryCadenceAggregatesAsync.mockResolvedValue([makeAggregate({ sampleCount: 3 })]);

      await meshIssuesAnalysisService.runAnalysis({ lookbackHours: 168, pairBucketHours: 6, nowMs: NOW });

      expect(mockDb.getTelemetryTimestampsAsync).not.toHaveBeenCalled();
    });

    it('does not call the stage-2 timestamps query when the stage-1 mean is above the candidate gate', async () => {
      // mean = (last-first)/1000/(sampleCount-1). thresholds default
      // overBroadcastSeconds=300, candidate factor=2 -> gate is 600s.
      // (5990*1000)/1000/(10-1) ~ 665s, above the gate.
      mockDb.getTelemetryCadenceAggregatesAsync.mockResolvedValue([
        makeAggregate({ sampleCount: 10, firstTimestamp: 0, lastTimestamp: 5_990_000 }),
      ]);

      await meshIssuesAnalysisService.runAnalysis({ lookbackHours: 168, pairBucketHours: 6, nowMs: NOW });

      expect(mockDb.getTelemetryTimestampsAsync).not.toHaveBeenCalled();
    });

    it('calls stage-2 only for candidate nodeNums, in chunks of 25', async () => {
      const aggregates = Array.from({ length: 30 }, (_, i) => makeAggregate({ nodeNum: i + 1 }));
      mockDb.getTelemetryCadenceAggregatesAsync.mockResolvedValue(aggregates);
      mockDb.getTelemetryTimestampsAsync.mockResolvedValue([]);

      await meshIssuesAnalysisService.runAnalysis({ lookbackHours: 168, pairBucketHours: 6, nowMs: NOW });

      expect(mockDb.getTelemetryTimestampsAsync).toHaveBeenCalledTimes(2);
      const firstCall = mockDb.getTelemetryTimestampsAsync.mock.calls[0][0];
      const secondCall = mockDb.getTelemetryTimestampsAsync.mock.calls[1][0];
      expect(firstCall.nodeNums).toHaveLength(25);
      expect(secondCall.nodeNums).toHaveLength(5);
      expect([...firstCall.nodeNums, ...secondCall.nodeNums].sort((a: number, b: number) => a - b)).toEqual(
        Array.from({ length: 30 }, (_, i) => i + 1),
      );
    });

    it('builds an exact median position CadenceStats from the stage-2 timestamps and threads it into the Tier C context', async () => {
      mockDb.getTelemetryCadenceAggregatesAsync.mockResolvedValue([makeAggregate({ nodeNum: 100 })]);
      mockDb.getTelemetryTimestampsAsync.mockResolvedValue([
        { nodeNum: 100, telemetryType: 'latitude', timestamp: 0 },
        { nodeNum: 100, telemetryType: 'latitude', timestamp: 10_000 },
        { nodeNum: 100, telemetryType: 'latitude', timestamp: 20_000 },
      ]);

      await meshIssuesAnalysisService.runAnalysis({ lookbackHours: 168, pairBucketHours: 6, nowMs: NOW });

      const tierCCtx = mockRulesTierC.evaluateAllTierC.mock.calls[0][0];
      const posCadence = tierCCtx.cadence.get(100)?.position;
      expect(posCadence).toBeTruthy();
      expect(posCadence.sampleCount).toBe(3);
      expect(posCadence.medianIntervalSeconds).toBe(10); // two 10s gaps -> median 10s
    });
  });
});
