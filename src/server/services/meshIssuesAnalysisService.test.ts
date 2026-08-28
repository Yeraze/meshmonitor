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
  analysis: { getTraceroutes: vi.fn() },
  getMeshIssuesAsync: vi.fn(),
  upsertMeshIssueFindingAsync: vi.fn(),
  bumpMeshIssueCleanRunAsync: vi.fn(),
}));
vi.mock('../../services/database.js', () => ({ default: mockDb }));

const mockRules = vi.hoisted(() => ({
  evaluateAllTierA: vi.fn(),
}));
vi.mock('./meshIssues/rules.js', () => mockRules);

import { ALL_SOURCES } from '../../db/repositories/base.js';
import { dataEventEmitter } from './dataEventEmitter.js';
import { meshIssuesAnalysisService, MAX_CORPUS_PAGES } from './meshIssuesAnalysisService.js';

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
    mockDb.telemetry.getTelemetryByTypesSince.mockResolvedValue([]);
    mockDb.telemetry.getPositionTelemetryByNode.mockResolvedValue([]);
    mockDb.analysis.getTraceroutes.mockResolvedValue({
      items: [], pageSize: 2000, hasMore: false, nextCursor: null,
    });
    mockDb.getMeshIssuesAsync.mockResolvedValue([]);
    mockDb.upsertMeshIssueFindingAsync.mockResolvedValue({ issue: {}, outcome: 'created' });
    mockDb.bumpMeshIssueCleanRunAsync.mockResolvedValue({ cleanRuns: 1, closed: false });
    mockRules.evaluateAllTierA.mockReturnValue([]);
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
    it('sends no packets and never calls dataEventEmitter, even on a run that finds and closes issues', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([makeSource()]);
      mockDb.nodes.getAllNodes.mockResolvedValue([makeNodeRow()]);
      mockRules.evaluateAllTierA.mockReturnValue([makeFinding()]);
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
});
