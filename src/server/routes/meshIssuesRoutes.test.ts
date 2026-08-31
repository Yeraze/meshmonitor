/**
 * Mesh Issues routes — permission isolation + wire-shape tests (#4964 Phase 1 WP4).
 *
 * Uses `createRouteTestApp()` (real session + optionalAuth/requirePermission +
 * real SQL against the live singleton) rather than a mocked `checkPermissionAsync`
 * — this is the #3745 cross-source leak class, and a hand-rolled permission
 * lambda would not catch a regression in the real filtering logic. Only the
 * non-DB `meshIssuesScheduler` singleton is `vi.mock`ed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import meshIssuesRoutes, { redactEvidence, buildSummary } from './meshIssuesRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';
import {
  MESH_ISSUE_TYPES,
  nodeSubjectKey,
  edgeSubjectKey,
  clusterSubjectKey,
  type MeshIssueFinding,
} from '../services/meshIssues/types.js';
import type { MeshIssuesRunResult } from '../services/meshIssuesAnalysisService.js';
import type { MeshIssuesStatus } from '../services/meshIssuesScheduler.js';

vi.mock('../services/meshIssuesScheduler.js', () => ({
  meshIssuesScheduler: {
    runNow: vi.fn(),
    getStatus: vi.fn(),
  },
}));

import { meshIssuesScheduler } from '../services/meshIssuesScheduler.js';

const mockedRunNow = vi.mocked(meshIssuesScheduler.runNow);
const mockedGetStatus = vi.mocked(meshIssuesScheduler.getStatus);

function makeFinding(overrides: Partial<MeshIssueFinding> & { nodeNum: number }): MeshIssueFinding {
  return {
    issueType: MESH_ISSUE_TYPES.A1_DEPRECATED_ROLE,
    subjectKey: nodeSubjectKey(overrides.nodeNum),
    severity: 'warning',
    confidence: 'high',
    evidence: { role: 4, roleName: 'REPEATER' },
    sourceIds: [],
    recommendation: 'Consider CLIENT_BASE (fixed, powered) or ROUTER_LATE.',
    ...overrides,
  };
}

/**
 * Variant of `makeFinding` for Tier B graph-attributed findings (edge/cluster,
 * #4964 Phase 2 §4.7) — `nodeNum` is always `null` and `subjectKey` cannot be
 * derived from it (`edgeSubjectKey`/`clusterSubjectKey` take a member list,
 * not a single node), so the caller must always supply `subjectKey`.
 */
function makeGraphFinding(
  overrides: Partial<MeshIssueFinding> & { subjectKey: string },
): MeshIssueFinding {
  return {
    issueType: MESH_ISSUE_TYPES.B3_ASYMMETRIC_LINK,
    nodeNum: null,
    severity: 'warning',
    confidence: 'medium',
    evidence: { deltaDb: 9.1 },
    sourceIds: [],
    recommendation: 'One end of this link hears the other much better than the reverse.',
    ...overrides,
  };
}

describe('meshIssuesRoutes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/api/analysis/mesh-issues', meshIssuesRoutes),
    });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await databaseService.meshIssues.deleteAll();
    // Seeded by the nodeName leak-class test; harmless to attempt when absent.
    await databaseService.deleteNodeAsync(500, harness.sourceB).catch(() => {});
    await harness.cleanup();
    vi.restoreAllMocks();
  });

  describe('GET /api/analysis/mesh-issues', () => {
    it('returns 403 NO_PERMITTED_SOURCES for a user with zero grants', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get('/api/analysis/mesh-issues');
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NO_PERMITTED_SOURCES');
      expect(res.body.success).toBe(false);
    });

    it('admin sees all findings, including one citing both sources', async () => {
      await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({ nodeNum: 100, sourceIds: [harness.sourceA, harness.sourceB] }),
        Date.now(),
      );
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/api/analysis/mesh-issues');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.issues).toHaveLength(1);
      expect(res.body.data.issues[0].sourceIds.sort()).toEqual([harness.sourceA, harness.sourceB].sort());
      expect(res.body.data.issues[0].nodeNum).toBe(100);
      expect(res.body.data.issues[0].nodeName).toBeDefined();
    });

    it('sourceA-only user sees the cross-source finding with sourceIds intersected to sourceA, and the sourceB-only finding is absent (#3745 leak class)', async () => {
      await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({ nodeNum: 101, sourceIds: [harness.sourceA, harness.sourceB] }),
        Date.now(),
      );
      await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({
          nodeNum: 102,
          issueType: MESH_ISSUE_TYPES.A2A_CHATTY_NODE,
          subjectKey: nodeSubjectKey(102),
          sourceIds: [harness.sourceB],
        }),
        Date.now(),
      );

      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get('/api/analysis/mesh-issues');

      expect(res.status).toBe(200);
      const issues = res.body.data.issues;
      expect(issues).toHaveLength(1);
      expect(issues[0].nodeNum).toBe(101);
      expect(issues[0].sourceIds).toEqual([harness.sourceA]);
      expect(issues.find((i: { nodeNum: number }) => i.nodeNum === 102)).toBeUndefined();
    });

    it('an edge finding (nodeNum: null, B3) round-trips through GET with nodeName: null (#4964 Phase 2 §4.7)', async () => {
      await databaseService.upsertMeshIssueFindingAsync(
        makeGraphFinding({
          issueType: MESH_ISSUE_TYPES.B3_ASYMMETRIC_LINK,
          subjectKey: edgeSubjectKey(1, 2),
          sourceIds: [harness.sourceA],
        }),
        Date.now(),
      );

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/api/analysis/mesh-issues');

      expect(res.status).toBe(200);
      const issue = res.body.data.issues.find((i: { subjectKey: string }) => i.subjectKey === 'edge:1-2');
      expect(issue).toBeDefined();
      expect(issue.issueType).toBe(MESH_ISSUE_TYPES.B3_ASYMMETRIC_LINK);
      expect(issue.nodeNum).toBeNull();
      expect(issue.nodeName).toBeNull();
      expect(issue.sourceIds).toEqual([harness.sourceA]);
    });

    it('a cluster finding (nodeNum: null, B1) round-trips through GET with nodeName: null (#4964 Phase 2 §4.7)', async () => {
      const subjectKey = clusterSubjectKey([10, 11, 12]);
      await databaseService.upsertMeshIssueFindingAsync(
        makeGraphFinding({
          issueType: MESH_ISSUE_TYPES.B1_ROUTER_CLUSTER,
          subjectKey,
          severity: 'critical',
          sourceIds: [harness.sourceA],
        }),
        Date.now(),
      );

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/api/analysis/mesh-issues');

      expect(res.status).toBe(200);
      const issue = res.body.data.issues.find((i: { subjectKey: string }) => i.subjectKey === subjectKey);
      expect(issue).toBeDefined();
      expect(issue.issueType).toBe(MESH_ISSUE_TYPES.B1_ROUTER_CLUSTER);
      expect(issue.nodeNum).toBeNull();
      expect(issue.nodeName).toBeNull();
      expect(issue.severity).toBe('critical');
    });

    it('a sourceB-only Tier B edge finding is absent for a sourceA-only user (#3745 leak class, #4964 Phase 2 §4.7)', async () => {
      await databaseService.upsertMeshIssueFindingAsync(
        makeGraphFinding({
          issueType: MESH_ISSUE_TYPES.B3_ASYMMETRIC_LINK,
          subjectKey: edgeSubjectKey(3, 4),
          sourceIds: [harness.sourceB],
        }),
        Date.now(),
      );

      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get('/api/analysis/mesh-issues');

      expect(res.status).toBe(200);
      expect(res.body.data.issues.find((i: { subjectKey: string }) => i.subjectKey === 'edge:3-4')).toBeUndefined();
    });

    it('nodeName is never resolved from a source the caller cannot read (#3745 leak class)', async () => {
      // The node row (and its longName) exists ONLY under sourceB.
      await databaseService.upsertNodeAsync(
        { nodeNum: 500, nodeId: '!000001f4', longName: 'Only In SourceB' },
        harness.sourceB,
      );
      // The finding cites both sources, so a sourceA-only user still sees the
      // row (sourceIds intersects to ['sourceA']) — but must not see the name.
      await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({ nodeNum: 500, sourceIds: [harness.sourceA, harness.sourceB] }),
        Date.now(),
      );

      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get('/api/analysis/mesh-issues');

      expect(res.status).toBe(200);
      const issue = res.body.data.issues.find((i: { nodeNum: number }) => i.nodeNum === 500);
      expect(issue).toBeDefined();
      expect(issue.sourceIds).toEqual([harness.sourceA]);
      // Never the sourceB longName — falls back to the !hex form instead.
      expect(issue.nodeName).not.toBe('Only In SourceB');
      expect(issue.nodeName).toBe('!000001f4');

      // Admin (permitted to both sources) still sees the real name.
      const adminAgent = await harness.loginAs(harness.admin);
      const adminRes = await adminAgent.get('/api/analysis/mesh-issues');
      const adminIssue = adminRes.body.data.issues.find((i: { nodeNum: number }) => i.nodeNum === 500);
      expect(adminIssue.nodeName).toBe('Only In SourceB');
    });

    it('counts matches the returned (post-filter) set', async () => {
      await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({ nodeNum: 200, severity: 'critical', sourceIds: [harness.sourceA] }),
        Date.now(),
      );
      await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({
          nodeNum: 201,
          issueType: MESH_ISSUE_TYPES.A2A_CHATTY_NODE,
          subjectKey: nodeSubjectKey(201),
          severity: 'warning',
          sourceIds: [harness.sourceA],
        }),
        Date.now(),
      );
      await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({
          nodeNum: 202,
          issueType: MESH_ISSUE_TYPES.A5_COSPLAY_ROUTER,
          subjectKey: nodeSubjectKey(202),
          severity: 'info',
          confidence: 'low',
          sourceIds: [harness.sourceA],
        }),
        Date.now(),
      );
      // Dropped by permission filter — must not be double-counted or leak.
      await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({
          nodeNum: 203,
          issueType: MESH_ISSUE_TYPES.A3_INFRA_POWER,
          subjectKey: nodeSubjectKey(203),
          severity: 'critical',
          sourceIds: [harness.sourceB],
        }),
        Date.now(),
      );

      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get('/api/analysis/mesh-issues');

      expect(res.status).toBe(200);
      expect(res.body.data.counts).toEqual({ critical: 1, warning: 1, info: 1, total: 3, dismissed: 0 });
    });

    it('includeClosed=true includes closed findings; default excludes them', async () => {
      const { issue } = await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({ nodeNum: 300, sourceIds: [harness.sourceA] }),
        Date.now(),
      );
      const closeResult = await databaseService.bumpMeshIssueCleanRunAsync(issue.id, 1, Date.now());
      expect(closeResult.closed).toBe(true);

      const agent = await harness.loginAs(harness.admin);

      const defaultRes = await agent.get('/api/analysis/mesh-issues');
      expect(defaultRes.body.data.issues).toHaveLength(0);

      const closedRes = await agent.get('/api/analysis/mesh-issues?includeClosed=true');
      expect(closedRes.body.data.issues).toHaveLength(1);
      expect(closedRes.body.data.issues[0].status).toBe('closed');
    });

    it('malformed evidence JSON does not 500 — row returned with evidence: {}', async () => {
      const { issue } = await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({ nodeNum: 400, sourceIds: [harness.sourceA] }),
        Date.now(),
      );
      databaseService.db.prepare('UPDATE mesh_issues SET evidence = ? WHERE id = ?').run('{not valid json', issue.id);

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/api/analysis/mesh-issues');
      expect(res.status).toBe(200);
      const found = res.body.data.issues.find((i: { nodeNum: number }) => i.nodeNum === 400);
      expect(found).toBeDefined();
      expect(found.evidence).toEqual({});
    });

    it('malformed sourceIds JSON drops the row (fail closed)', async () => {
      const { issue } = await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({ nodeNum: 401, sourceIds: [harness.sourceA] }),
        Date.now(),
      );
      databaseService.db.prepare('UPDATE mesh_issues SET sourceIds = ? WHERE id = ?').run('not valid json', issue.id);

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/api/analysis/mesh-issues');
      expect(res.status).toBe(200);
      expect(res.body.data.issues.find((i: { nodeNum: number }) => i.nodeNum === 401)).toBeUndefined();
    });
  });

  describe('GET /api/analysis/mesh-issues — wire-level pagination (#4964 post-epic follow-ups)', () => {
    it('total/counts reflect the FULL filtered set while issues is only the requested page', async () => {
      for (let i = 0; i < 5; i++) {
        await databaseService.upsertMeshIssueFindingAsync(
          makeFinding({
            nodeNum: 700 + i,
            subjectKey: nodeSubjectKey(700 + i),
            severity: i < 2 ? 'critical' : i < 4 ? 'warning' : 'info',
            sourceIds: [harness.sourceA],
          }),
          Date.now(),
        );
      }

      const agent = await harness.loginAs(harness.admin);

      const full = await agent.get('/api/analysis/mesh-issues');
      expect(full.body.data.issues).toHaveLength(5);
      const fullIds = full.body.data.issues.map((i: { id: number }) => i.id);

      const page = await agent.get('/api/analysis/mesh-issues?offset=3');
      expect(page.status).toBe(200);
      // Same deterministic ordering, just sliced from offset 3.
      expect(page.body.data.issues.map((i: { id: number }) => i.id)).toEqual(fullIds.slice(3));
      // total/counts come from the FULL set, not the 2-row page.
      expect(page.body.data.total).toBe(5);
      expect(page.body.data.counts).toEqual(full.body.data.counts);
      expect(page.body.data.counts).toEqual({ critical: 2, warning: 2, info: 1, total: 5, dismissed: 0 });
      expect(page.body.data.limit).toBe(500);
      expect(page.body.data.offset).toBe(3);
    });

    it('an offset past the end of the full set returns an empty issues array with the correct total', async () => {
      await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({ nodeNum: 705, sourceIds: [harness.sourceA] }),
        Date.now(),
      );

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/api/analysis/mesh-issues?offset=1000');

      expect(res.status).toBe(200);
      expect(res.body.data.issues).toEqual([]);
      expect(res.body.data.total).toBe(1);
      expect(res.body.data.offset).toBe(1000);
    });

    it('clamps limit to [50, 2000] and floors/defaults offset at 0', async () => {
      const agent = await harness.loginAs(harness.admin);

      const tooSmall = await agent.get('/api/analysis/mesh-issues?limit=1');
      expect(tooSmall.body.data.limit).toBe(50);

      const tooBig = await agent.get('/api/analysis/mesh-issues?limit=999999');
      expect(tooBig.body.data.limit).toBe(2000);

      const negativeOffset = await agent.get('/api/analysis/mesh-issues?offset=-5');
      expect(negativeOffset.body.data.offset).toBe(0);

      const nonNumeric = await agent.get('/api/analysis/mesh-issues?limit=abc&offset=xyz');
      expect(nonNumeric.body.data.limit).toBe(500);
      expect(nonNumeric.body.data.offset).toBe(0);

      const missing = await agent.get('/api/analysis/mesh-issues');
      expect(missing.body.data.limit).toBe(500);
      expect(missing.body.data.offset).toBe(0);
    });

    it('returns identical, deterministic ordering across two identical requests, tiebreaking equal lastDetected by id desc', async () => {
      const now = Date.now();
      for (let i = 0; i < 4; i++) {
        await databaseService.upsertMeshIssueFindingAsync(
          makeFinding({
            nodeNum: 710 + i,
            subjectKey: nodeSubjectKey(710 + i),
            severity: 'warning',
            sourceIds: [harness.sourceA],
          }),
          now,
        );
      }

      const agent = await harness.loginAs(harness.admin);
      const res1 = await agent.get('/api/analysis/mesh-issues');
      const res2 = await agent.get('/api/analysis/mesh-issues');

      const isSeeded = (i: { nodeNum: number }) => i.nodeNum >= 710 && i.nodeNum < 714;
      const ids1 = res1.body.data.issues.filter(isSeeded).map((i: { id: number }) => i.id);
      const ids2 = res2.body.data.issues.filter(isSeeded).map((i: { id: number }) => i.id);

      expect(ids1).toHaveLength(4);
      expect(ids1).toEqual(ids2);
      // Same severity + same lastDetected -> the id-desc tiebreak decides order.
      expect(ids1).toEqual([...ids1].sort((a, b) => b - a));
    });

    it('a source-filtered-out finding is excluded from both counts/total and the page (#3745 leak class + pagination)', async () => {
      await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({ nodeNum: 720, sourceIds: [harness.sourceA] }),
        Date.now(),
      );
      await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({ nodeNum: 721, subjectKey: nodeSubjectKey(721), sourceIds: [harness.sourceB] }),
        Date.now(),
      );

      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get('/api/analysis/mesh-issues');

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(1);
      expect(res.body.data.counts.total).toBe(1);
      expect(res.body.data.issues).toHaveLength(1);
      expect(res.body.data.issues[0].nodeNum).toBe(720);
    });
  });

  describe('GET /api/analysis/mesh-issues/status', () => {
    it('returns 403 NO_PERMITTED_SOURCES for a user with zero grants', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get('/api/analysis/mesh-issues/status');
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NO_PERMITTED_SOURCES');
    });

    it('returns scheduler status for a permitted user', async () => {
      const status: MeshIssuesStatus = {
        running: true,
        inProgress: false,
        enabled: true,
        frequencyHours: 24,
        lookbackHours: 168,
        pairBucketHours: 6,
        lastRunTime: 12345,
        lastRunResult: null,
      };
      mockedGetStatus.mockResolvedValue(status);

      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get('/api/analysis/mesh-issues/status');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual(status);
    });
  });

  describe('POST /api/analysis/mesh-issues/run-now', () => {
    it('403s a user without settings:write', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/api/analysis/mesh-issues/run-now');
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
      expect(mockedRunNow).not.toHaveBeenCalled();
    });

    it('200s for admin, returns the run result, and writes an audit log entry', async () => {
      const result: MeshIssuesRunResult = {
        durationMs: 12,
        sourceCount: 2,
        nodeCount: 5,
        findingCount: 3,
        newCount: 1,
        reopenedCount: 0,
        updatedCount: 2,
        closedCount: 0,
        byType: { A1_deprecated_role: 3 },
        corpusStats: {
          rawCount: 0,
          validCount: 0,
          dedupedCount: 0,
          sampledCount: 0,
          distinctPairCount: 0,
          truncated: false,
        },
        coverage: {
          evidence: { neighborInfo: false, traceroute: false, mqttGateway: false, packetLog: false },
          neighborInfoRowCount: 0,
          neighborInfoEdgeCount: 0,
          tracerouteEdgeCount: 0,
          tracerouteSentinelHopsDropped: 0,
          gatewayCount: 0,
          gatewayDirectEdgeCount: 0,
          gatewayCoReceptionEdgeCount: 0,
          gatewayCellsSkipped: 0,
          directEdgeCount: 0,
          totalEdgeCount: 0,
          graphNodeCount: 0,
          snrDirectionsWithMinSamples: 0,
          hopHorizonSource: null,
          hopHorizonNodeCount: 0,
          skippedRules: [],
        },
      };
      mockedRunNow.mockResolvedValue(result);
      const auditSpy = vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined);

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/api/analysis/mesh-issues/run-now');

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual(result);
      expect(auditSpy).toHaveBeenCalledWith(
        harness.admin.id,
        'mesh_issues_run',
        'settings',
        expect.stringContaining('3 finding'),
        expect.anything(),
        null,
        expect.any(String),
      );
    });

    it('409s MESH_ISSUES_RUN_IN_PROGRESS when the scheduler rejects a concurrent run', async () => {
      mockedRunNow.mockRejectedValue(new Error('Mesh issues analysis already in progress'));

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/api/analysis/mesh-issues/run-now');

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('MESH_ISSUES_RUN_IN_PROGRESS');
    });

    it('500s MESH_ISSUES_RUN_FAILED on an unexpected scheduler failure', async () => {
      mockedRunNow.mockRejectedValue(new Error('boom'));

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/api/analysis/mesh-issues/run-now');

      expect(res.status).toBe(500);
      expect(res.body.code).toBe('MESH_ISSUES_RUN_FAILED');
    });
  });

  describe('GET /api/analysis/mesh-issues — includeDismissed and sourceNames (#4964 Phase 3 WP3)', () => {
    it('default excludes dismissed rows; includeDismissed=true returns them with dismissed/dismissedAt set', async () => {
      const { issue } = await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({ nodeNum: 600, sourceIds: [harness.sourceA] }),
        Date.now(),
      );
      await databaseService.setMeshIssueDismissedAsync(issue.id, true, harness.admin.id, Date.now());

      const agent = await harness.loginAs(harness.admin);

      const defaultRes = await agent.get('/api/analysis/mesh-issues');
      expect(defaultRes.body.data.issues.find((i: { nodeNum: number }) => i.nodeNum === 600)).toBeUndefined();

      const includeRes = await agent.get('/api/analysis/mesh-issues?includeDismissed=true');
      const found = includeRes.body.data.issues.find((i: { nodeNum: number }) => i.nodeNum === 600);
      expect(found).toBeDefined();
      expect(found.dismissed).toBe(true);
      expect(typeof found.dismissedAt).toBe('number');
      expect(includeRes.body.data.counts.dismissed).toBe(1);
    });

    it('a non-dismissed row reports dismissed: false and dismissedAt: null', async () => {
      await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({ nodeNum: 601, sourceIds: [harness.sourceA] }),
        Date.now(),
      );
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/api/analysis/mesh-issues');
      const found = res.body.data.issues.find((i: { nodeNum: number }) => i.nodeNum === 601);
      expect(found.dismissed).toBe(false);
      expect(found.dismissedAt).toBeNull();
      expect(res.body.data.counts.dismissed).toBe(0);
    });

    it('sourceNames contains only permitted sources, resolved from a single getAllSources() call', async () => {
      await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({ nodeNum: 602, sourceIds: [harness.sourceA] }),
        Date.now(),
      );
      const getAllSourcesSpy = vi.spyOn(databaseService.sources, 'getAllSources');

      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get('/api/analysis/mesh-issues');

      expect(res.status).toBe(200);
      expect(res.body.data.sourceNames[harness.sourceA]).toBeDefined();
      expect(res.body.data.sourceNames[harness.sourceB]).toBeUndefined();
      expect(getAllSourcesSpy).toHaveBeenCalledTimes(1);

      getAllSourcesSpy.mockRestore();
    });
  });

  describe('POST /:id/dismiss and /:id/restore (#4964 Phase 3 WP3, P3-D7)', () => {
    it('403s a user without settings:write', async () => {
      const { issue } = await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({ nodeNum: 610, sourceIds: [harness.sourceA] }),
        Date.now(),
      );
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post(`/api/analysis/mesh-issues/${issue.id}/dismiss`);
      expect(res.status).toBe(403);
    });

    it('200s for admin, flips the dismissed column, and writes an audit log entry', async () => {
      const { issue } = await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({ nodeNum: 611, sourceIds: [harness.sourceA] }),
        Date.now(),
      );
      const auditSpy = vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined);

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post(`/api/analysis/mesh-issues/${issue.id}/dismiss`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const row = await databaseService.getMeshIssueByIdAsync(issue.id);
      expect(row?.dismissed).toBe(true);
      expect(row?.dismissedAt).toEqual(expect.any(Number));
      expect(auditSpy).toHaveBeenCalledWith(
        harness.admin.id,
        'mesh_issue_dismiss',
        'settings',
        expect.stringContaining(String(issue.id)),
        expect.anything(),
        null,
        null,
      );

      // Restore flips it back.
      const restoreRes = await agent.post(`/api/analysis/mesh-issues/${issue.id}/restore`);
      expect(restoreRes.status).toBe(200);
      const restoredRow = await databaseService.getMeshIssueByIdAsync(issue.id);
      expect(restoredRow?.dismissed).toBe(false);
      expect(restoredRow?.dismissedAt).toBeNull();
    });

    it('404s an unknown id', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/api/analysis/mesh-issues/999999999/dismiss');
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('MESH_ISSUE_NOT_FOUND');
    });

    it('400s a non-numeric id', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/api/analysis/mesh-issues/not-a-number/dismiss');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_ISSUE_ID');
    });

    it('404s for a finding whose sourceIds do not intersect the caller\'s permitted set (#3745 leak class), and does not mutate the row', async () => {
      const { issue } = await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({ nodeNum: 612, sourceIds: [harness.sourceB] }),
        Date.now(),
      );

      // Real limited user: settings:write (global admin action) but only
      // nodes:read on sourceA — the finding is entirely sourceB.
      await harness.grant(harness.limited.id, 'settings', 'write', harness.sourceA);
      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);

      const res = await agent.post(`/api/analysis/mesh-issues/${issue.id}/dismiss`);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('MESH_ISSUE_NOT_FOUND');

      const row = await databaseService.getMeshIssueByIdAsync(issue.id);
      expect(row?.dismissed).toBe(false);
    });
  });

  describe('GET /api/analysis/mesh-issues — filters (#4964 report reorg WP1, spec §4.1)', () => {
    it('severity narrows issues, counts and total together', async () => {
      await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({ nodeNum: 800, severity: 'critical', sourceIds: [harness.sourceA] }),
        Date.now(),
      );
      await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({
          nodeNum: 801,
          issueType: MESH_ISSUE_TYPES.A2A_CHATTY_NODE,
          subjectKey: nodeSubjectKey(801),
          severity: 'warning',
          sourceIds: [harness.sourceA],
        }),
        Date.now(),
      );

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/api/analysis/mesh-issues?severity=critical');
      expect(res.status).toBe(200);
      expect(res.body.data.issues).toHaveLength(1);
      expect(res.body.data.issues[0].nodeNum).toBe(800);
      expect(res.body.data.counts).toEqual({ critical: 1, warning: 0, info: 0, total: 1, dismissed: 0 });
      expect(res.body.data.total).toBe(1);
    });

    it('tier narrows to issueType[0] match', async () => {
      await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({
          nodeNum: 810,
          issueType: MESH_ISSUE_TYPES.A1_DEPRECATED_ROLE,
          subjectKey: nodeSubjectKey(810),
          sourceIds: [harness.sourceA],
        }),
        Date.now(),
      );
      await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({
          nodeNum: 811,
          issueType: MESH_ISSUE_TYPES.B2_REDUNDANT_ROUTER,
          subjectKey: nodeSubjectKey(811),
          sourceIds: [harness.sourceA],
        }),
        Date.now(),
      );

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/api/analysis/mesh-issues?tier=B');
      expect(res.status).toBe(200);
      expect(res.body.data.issues).toHaveLength(1);
      expect(res.body.data.issues[0].nodeNum).toBe(811);
    });

    it('issueType narrows to an exact match (GET / only)', async () => {
      await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({
          nodeNum: 820,
          issueType: MESH_ISSUE_TYPES.A1_DEPRECATED_ROLE,
          subjectKey: nodeSubjectKey(820),
          sourceIds: [harness.sourceA],
        }),
        Date.now(),
      );
      await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({
          nodeNum: 821,
          issueType: MESH_ISSUE_TYPES.A2A_CHATTY_NODE,
          subjectKey: nodeSubjectKey(821),
          sourceIds: [harness.sourceA],
        }),
        Date.now(),
      );

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/api/analysis/mesh-issues?issueType=${MESH_ISSUE_TYPES.A2A_CHATTY_NODE}`);
      expect(res.body.data.issues).toHaveLength(1);
      expect(res.body.data.issues[0].nodeNum).toBe(821);
    });

    it('nodeNum=none matches only nodeNum IS NULL rows', async () => {
      await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({ nodeNum: 830, sourceIds: [harness.sourceA] }),
        Date.now(),
      );
      await databaseService.upsertMeshIssueFindingAsync(
        makeGraphFinding({ subjectKey: edgeSubjectKey(5, 6), sourceIds: [harness.sourceA] }),
        Date.now(),
      );

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/api/analysis/mesh-issues?nodeNum=none');
      expect(res.status).toBe(200);
      expect(res.body.data.issues.length).toBeGreaterThan(0);
      expect(res.body.data.issues.every((i: { nodeNum: number | null }) => i.nodeNum === null)).toBe(true);
    });

    it('nodeNum=<n> matches exactly that node', async () => {
      await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({ nodeNum: 840, sourceIds: [harness.sourceA] }),
        Date.now(),
      );
      await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({
          nodeNum: 841,
          issueType: MESH_ISSUE_TYPES.A2A_CHATTY_NODE,
          subjectKey: nodeSubjectKey(841),
          sourceIds: [harness.sourceA],
        }),
        Date.now(),
      );

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/api/analysis/mesh-issues?nodeNum=840');
      expect(res.body.data.issues).toHaveLength(1);
      expect(res.body.data.issues[0].nodeNum).toBe(840);
    });

    it('unknown severity/tier/issueType tokens are dropped, never a 400 (clamp-never-reject)', async () => {
      await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({ nodeNum: 850, sourceIds: [harness.sourceA] }),
        Date.now(),
      );

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/api/analysis/mesh-issues?severity=bogus&tier=Z&issueType=not_a_real_type');
      expect(res.status).toBe(200);
      // all-unknown tokens -> filter treated as absent -> no narrowing
      expect(res.body.data.issues.some((i: { nodeNum: number }) => i.nodeNum === 850)).toBe(true);
    });

    it('q matches the resolved nodeName, case-insensitively', async () => {
      await databaseService.upsertNodeAsync(
        { nodeNum: 860, nodeId: '!00000360', longName: 'Mountain Ridge Repeater' },
        harness.sourceA,
      );
      await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({ nodeNum: 860, sourceIds: [harness.sourceA] }),
        Date.now(),
      );
      await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({
          nodeNum: 861,
          issueType: MESH_ISSUE_TYPES.A2A_CHATTY_NODE,
          subjectKey: nodeSubjectKey(861),
          sourceIds: [harness.sourceA],
        }),
        Date.now(),
      );

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/api/analysis/mesh-issues?q=ridge');
      expect(res.body.data.issues).toHaveLength(1);
      expect(res.body.data.issues[0].nodeNum).toBe(860);

      await databaseService.deleteNodeAsync(860, harness.sourceA).catch(() => {});
    });

    it("sources is intersected with the caller's permitted set — an unreadable source is dropped, not a 403", async () => {
      await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({ nodeNum: 870, sourceIds: [harness.sourceA] }),
        Date.now(),
      );

      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/api/analysis/mesh-issues?sources=${harness.sourceA},${harness.sourceB}`);
      expect(res.status).toBe(200);
      expect(res.body.data.issues.some((i: { nodeNum: number }) => i.nodeNum === 870)).toBe(true);
    });

    it('sources filter narrows out a finding whose visible sourceIds do not intersect the requested set', async () => {
      await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({ nodeNum: 880, sourceIds: [harness.sourceA] }),
        Date.now(),
      );
      await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({
          nodeNum: 881,
          issueType: MESH_ISSUE_TYPES.A2A_CHATTY_NODE,
          subjectKey: nodeSubjectKey(881),
          sourceIds: [harness.sourceB],
        }),
        Date.now(),
      );

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/api/analysis/mesh-issues?sources=${harness.sourceA}`);
      const nodeNums = res.body.data.issues.map((i: { nodeNum: number }) => i.nodeNum);
      expect(nodeNums).toContain(880);
      expect(nodeNums).not.toContain(881);
    });

    it('filters compose with limit/offset and the sort stays deterministic', async () => {
      for (let i = 0; i < 4; i++) {
        await databaseService.upsertMeshIssueFindingAsync(
          makeFinding({
            nodeNum: 890 + i,
            subjectKey: nodeSubjectKey(890 + i),
            severity: 'warning',
            sourceIds: [harness.sourceA],
          }),
          Date.now(),
        );
      }
      const agent = await harness.loginAs(harness.admin);
      const isSeeded = (i: { nodeNum: number }) => i.nodeNum >= 890 && i.nodeNum < 894;

      const full = await agent.get('/api/analysis/mesh-issues?severity=warning');
      const fullIds = full.body.data.issues.filter(isSeeded).map((i: { id: number }) => i.id);
      expect(fullIds).toHaveLength(4);

      const page = await agent.get('/api/analysis/mesh-issues?severity=warning&limit=50&offset=0');
      const pageIds = page.body.data.issues.filter(isSeeded).map((i: { id: number }) => i.id);
      expect(pageIds).toEqual(fullIds);
    });
  });

  describe('GET /api/analysis/mesh-issues/summary (#4964 report reorg WP1, spec §4.3)', () => {
    it('returns 403 NO_PERMITTED_SOURCES for a user with zero grants', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get('/api/analysis/mesh-issues/summary');
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NO_PERMITTED_SOURCES');
    });

    it('aggregates match a hand-computed fixture: byType worst-first, byNode with the Mesh-wide group first, no evidence anywhere', async () => {
      await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({
          nodeNum: 900,
          issueType: MESH_ISSUE_TYPES.A1_DEPRECATED_ROLE,
          subjectKey: nodeSubjectKey(900),
          severity: 'warning',
          sourceIds: [harness.sourceA],
        }),
        Date.now(),
      );
      await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({
          nodeNum: 900,
          issueType: MESH_ISSUE_TYPES.A2A_CHATTY_NODE,
          subjectKey: nodeSubjectKey(900),
          severity: 'critical',
          sourceIds: [harness.sourceA],
        }),
        Date.now(),
      );
      await databaseService.upsertMeshIssueFindingAsync(
        makeGraphFinding({
          issueType: MESH_ISSUE_TYPES.B1_ROUTER_CLUSTER,
          subjectKey: clusterSubjectKey([901, 902]),
          severity: 'info',
          sourceIds: [harness.sourceA],
        }),
        Date.now(),
      );

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/api/analysis/mesh-issues/summary');
      expect(res.status).toBe(200);
      const data = res.body.data;

      expect(data.byType[0].issueType).toBe(MESH_ISSUE_TYPES.A2A_CHATTY_NODE);
      expect(data.byType[0].worstSeverity).toBe('critical');

      // Mesh-wide group (nodeNum: null, from the B1 cluster finding) pinned first.
      expect(data.byNode[0].nodeNum).toBeNull();
      expect(data.byNode[0].nodeName).toBeNull();

      const node900 = data.byNode.find((n: { nodeNum: number | null }) => n.nodeNum === 900);
      expect(node900).toBeDefined();
      expect(node900.total).toBe(2);
      expect(node900.issueTypes).toEqual([MESH_ISSUE_TYPES.A2A_CHATTY_NODE, MESH_ISSUE_TYPES.A1_DEPRECATED_ROLE]);

      expect(JSON.stringify(data)).not.toMatch(/"evidence"/);
    });

    it('honours severity/tier/sources/q; ignores issueType/nodeNum (spec §4.3)', async () => {
      await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({
          nodeNum: 910,
          issueType: MESH_ISSUE_TYPES.A1_DEPRECATED_ROLE,
          subjectKey: nodeSubjectKey(910),
          severity: 'critical',
          sourceIds: [harness.sourceA],
        }),
        Date.now(),
      );
      await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({
          nodeNum: 911,
          issueType: MESH_ISSUE_TYPES.A2A_CHATTY_NODE,
          subjectKey: nodeSubjectKey(911),
          severity: 'warning',
          sourceIds: [harness.sourceA],
        }),
        Date.now(),
      );

      const agent = await harness.loginAs(harness.admin);

      const filtered = await agent.get('/api/analysis/mesh-issues/summary?severity=critical');
      expect(filtered.body.data.byType.map((t: { issueType: string }) => t.issueType)).toEqual([
        MESH_ISSUE_TYPES.A1_DEPRECATED_ROLE,
      ]);

      const ignored = await agent.get(
        `/api/analysis/mesh-issues/summary?issueType=${MESH_ISSUE_TYPES.A1_DEPRECATED_ROLE}&nodeNum=910`,
      );
      const ignoredTypes = ignored.body.data.byType.map((t: { issueType: string }) => t.issueType);
      expect(ignoredTypes).toContain(MESH_ISSUE_TYPES.A1_DEPRECATED_ROLE);
      expect(ignoredTypes).toContain(MESH_ISSUE_TYPES.A2A_CHATTY_NODE);
    });

    it("a limited user's summary counts only their visible findings (#3745 leak class)", async () => {
      await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({ nodeNum: 920, sourceIds: [harness.sourceA] }),
        Date.now(),
      );
      await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({
          nodeNum: 921,
          issueType: MESH_ISSUE_TYPES.A2A_CHATTY_NODE,
          subjectKey: nodeSubjectKey(921),
          sourceIds: [harness.sourceB],
        }),
        Date.now(),
      );

      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get('/api/analysis/mesh-issues/summary');
      expect(res.body.data.total).toBe(1);
      expect(res.body.data.counts.total).toBe(1);
    });
  });

  describe('POST /api/analysis/mesh-issues/bulk/dismiss and /bulk/restore (#4964 report reorg WP1, spec §4.4)', () => {
    it('403s a user without settings:write', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent
        .post('/api/analysis/mesh-issues/bulk/dismiss')
        .send({ scope: 'issueType', issueType: MESH_ISSUE_TYPES.A1_DEPRECATED_ROLE });
      expect(res.status).toBe(403);
    });

    it('a user with settings:write but no readable source gets 403 NO_PERMITTED_SOURCES', async () => {
      await harness.grant(harness.limited.id, 'settings', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent
        .post('/api/analysis/mesh-issues/bulk/dismiss')
        .send({ scope: 'issueType', issueType: MESH_ISSUE_TYPES.A1_DEPRECATED_ROLE });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NO_PERMITTED_SOURCES');
    });

    it('400s INVALID_BULK_SCOPE for a missing/unknown scope, or a nodeNum that is neither an integer nor null', async () => {
      const agent = await harness.loginAs(harness.admin);

      const res1 = await agent.post('/api/analysis/mesh-issues/bulk/dismiss').send({});
      expect(res1.status).toBe(400);
      expect(res1.body.code).toBe('INVALID_BULK_SCOPE');

      const res2 = await agent.post('/api/analysis/mesh-issues/bulk/dismiss').send({ scope: 'bogus' });
      expect(res2.status).toBe(400);
      expect(res2.body.code).toBe('INVALID_BULK_SCOPE');

      const res3 = await agent
        .post('/api/analysis/mesh-issues/bulk/dismiss')
        .send({ scope: 'node', nodeNum: 'not-a-number' });
      expect(res3.status).toBe(400);
      expect(res3.body.code).toBe('INVALID_BULK_SCOPE');
    });

    it('400s INVALID_ISSUE_TYPE for an unknown issue type', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent
        .post('/api/analysis/mesh-issues/bulk/dismiss')
        .send({ scope: 'issueType', issueType: 'not_a_real_type' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_ISSUE_TYPE');
    });

    it('admin, {scope: issueType} flips every visible finding of that type in one call, leaves other types untouched, and audit-logs the affected count', async () => {
      await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({
          nodeNum: 930,
          issueType: MESH_ISSUE_TYPES.A5_COSPLAY_ROUTER,
          subjectKey: nodeSubjectKey(930),
          sourceIds: [harness.sourceA],
        }),
        Date.now(),
      );
      await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({
          nodeNum: 931,
          issueType: MESH_ISSUE_TYPES.A5_COSPLAY_ROUTER,
          subjectKey: nodeSubjectKey(931),
          sourceIds: [harness.sourceA],
        }),
        Date.now(),
      );
      await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({
          nodeNum: 932,
          issueType: MESH_ISSUE_TYPES.A1_DEPRECATED_ROLE,
          subjectKey: nodeSubjectKey(932),
          sourceIds: [harness.sourceA],
        }),
        Date.now(),
      );

      const auditSpy = vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined);
      const agent = await harness.loginAs(harness.admin);
      const res = await agent
        .post('/api/analysis/mesh-issues/bulk/dismiss')
        .send({ scope: 'issueType', issueType: MESH_ISSUE_TYPES.A5_COSPLAY_ROUTER });

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ affected: 2 });

      const rows = await databaseService.getMeshIssuesAsync({ includeDismissed: true });
      expect(rows.find((r) => r.nodeNum === 930)?.dismissed).toBe(true);
      expect(rows.find((r) => r.nodeNum === 931)?.dismissed).toBe(true);
      expect(rows.find((r) => r.nodeNum === 932)?.dismissed).toBe(false);

      expect(auditSpy).toHaveBeenCalledWith(
        harness.admin.id,
        'mesh_issue_bulk_dismiss',
        'settings',
        expect.stringContaining('Dismissed 2 mesh issue'),
        expect.anything(),
        null,
        expect.stringContaining('"affected":2'),
      );
    });

    it('partial visibility: a sourceA-only user dismisses only sourceA-visible findings; the sourceB-only row stays dismissed: false and the response has no skipped field (#3745 leak class)', async () => {
      await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({
          nodeNum: 940,
          issueType: MESH_ISSUE_TYPES.B2_REDUNDANT_ROUTER,
          subjectKey: nodeSubjectKey(940),
          sourceIds: [harness.sourceA],
        }),
        Date.now(),
      );
      await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({
          nodeNum: 941,
          issueType: MESH_ISSUE_TYPES.B2_REDUNDANT_ROUTER,
          subjectKey: nodeSubjectKey(941),
          sourceIds: [harness.sourceA],
        }),
        Date.now(),
      );
      await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({
          nodeNum: 942,
          issueType: MESH_ISSUE_TYPES.B2_REDUNDANT_ROUTER,
          subjectKey: nodeSubjectKey(942),
          sourceIds: [harness.sourceB],
        }),
        Date.now(),
      );

      await harness.grant(harness.limited.id, 'settings', 'write', harness.sourceA);
      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent
        .post('/api/analysis/mesh-issues/bulk/dismiss')
        .send({ scope: 'issueType', issueType: MESH_ISSUE_TYPES.B2_REDUNDANT_ROUTER });

      expect(res.status).toBe(200);
      expect(res.body.data.affected).toBe(2);
      expect('skipped' in res.body.data).toBe(false);
      expect(JSON.stringify(res.body)).not.toMatch(/skipped/i);

      const rows = await databaseService.getMeshIssuesAsync({ includeDismissed: true });
      expect(rows.find((r) => r.nodeNum === 942)?.dismissed).toBe(false);
    });

    it('{scope: node, nodeNum: null} hits only nodeNum IS NULL rows', async () => {
      await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({ nodeNum: 950, sourceIds: [harness.sourceA] }),
        Date.now(),
      );
      await databaseService.upsertMeshIssueFindingAsync(
        makeGraphFinding({
          issueType: MESH_ISSUE_TYPES.B3_ASYMMETRIC_LINK,
          subjectKey: edgeSubjectKey(7, 8),
          sourceIds: [harness.sourceA],
        }),
        Date.now(),
      );

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/api/analysis/mesh-issues/bulk/dismiss').send({ scope: 'node', nodeNum: null });
      expect(res.status).toBe(200);
      expect(res.body.data.affected).toBe(1);

      const rows = await databaseService.getMeshIssuesAsync({ includeDismissed: true });
      expect(rows.find((r) => r.nodeNum === 950)?.dismissed).toBe(false);
      expect(rows.find((r) => r.subjectKey === 'edge:7-8')?.dismissed).toBe(true);
    });

    it('a second identical call is idempotent: affected: 0', async () => {
      await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({
          nodeNum: 960,
          issueType: MESH_ISSUE_TYPES.A4_MOBILE_INFRA,
          subjectKey: nodeSubjectKey(960),
          sourceIds: [harness.sourceA],
        }),
        Date.now(),
      );

      const agent = await harness.loginAs(harness.admin);
      const first = await agent
        .post('/api/analysis/mesh-issues/bulk/dismiss')
        .send({ scope: 'issueType', issueType: MESH_ISSUE_TYPES.A4_MOBILE_INFRA });
      expect(first.body.data.affected).toBe(1);

      const second = await agent
        .post('/api/analysis/mesh-issues/bulk/dismiss')
        .send({ scope: 'issueType', issueType: MESH_ISSUE_TYPES.A4_MOBILE_INFRA });
      expect(second.body.data.affected).toBe(0);
    });

    it('restore is the inverse and only touches dismissed === true rows', async () => {
      const { issue: issueDismissed } = await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({
          nodeNum: 970,
          issueType: MESH_ISSUE_TYPES.B4_IDLE_ROUTER,
          subjectKey: nodeSubjectKey(970),
          sourceIds: [harness.sourceA],
        }),
        Date.now(),
      );
      const { issue: issueOpen } = await databaseService.upsertMeshIssueFindingAsync(
        makeFinding({
          nodeNum: 971,
          issueType: MESH_ISSUE_TYPES.B4_IDLE_ROUTER,
          subjectKey: nodeSubjectKey(971),
          sourceIds: [harness.sourceA],
        }),
        Date.now(),
      );
      await databaseService.setMeshIssueDismissedAsync(issueDismissed.id, true, 1, Date.now());

      const agent = await harness.loginAs(harness.admin);
      const res = await agent
        .post('/api/analysis/mesh-issues/bulk/restore')
        .send({ scope: 'issueType', issueType: MESH_ISSUE_TYPES.B4_IDLE_ROUTER });
      expect(res.status).toBe(200);
      expect(res.body.data.affected).toBe(1);

      const rows = await databaseService.getMeshIssuesAsync({ includeDismissed: true });
      expect(rows.find((r) => r.id === issueDismissed.id)?.dismissed).toBe(false);
      expect(rows.find((r) => r.id === issueOpen.id)?.dismissed).toBe(false);
    });
  });
});

describe('redactEvidence (#4964 Phase 3 WP3 §4.3, D12)', () => {
  const permitted = ['sourceA'];
  const nodeNames = new Map<number, string>([
    [1, 'Permitted Node 1'],
    [2, 'Permitted Node 2'],
  ]);

  it('intersects a top-level sources array with permitted', () => {
    const out = redactEvidence({ sources: ['sourceA', 'sourceB'] }, permitted, nodeNames);
    expect(out.sources).toEqual(['sourceA']);
  });

  it('intersects a sources array nested inside an array of objects', () => {
    const out = redactEvidence(
      { members: [{ nodeNum: 1, sources: ['sourceA', 'sourceB'] }] },
      permitted,
      nodeNames,
    );
    const members = out.members as Array<{ sources: string[] }>;
    expect(members[0].sources).toEqual(['sourceA']);
  });

  it('replaces members[].name with the permitted name, and null when the node has no permitted name', () => {
    const out = redactEvidence(
      {
        members: [
          { nodeNum: 1, name: 'Leaked SourceB Name' },
          { nodeNum: 99, name: 'Also Leaked' },
        ],
      },
      permitted,
      nodeNames,
    );
    const members = out.members as Array<{ nodeNum: number; name: string | null }>;
    expect(members[0].name).toBe('Permitted Node 1');
    expect(members[1].name).toBeNull();
  });

  it('rewrites the bestSitedNodeNum/bestSitedName pair (B1)', () => {
    const out = redactEvidence(
      { bestSitedNodeNum: 2, bestSitedName: 'Leaked Best Sited Name' },
      permitted,
      nodeNames,
    );
    expect(out.bestSitedName).toBe('Permitted Node 2');
  });

  it('rewrites A2b-style nodes[].longName', () => {
    const out = redactEvidence(
      { nodes: [{ nodeNum: 1, longName: 'Leaked Long Name' }] },
      permitted,
      nodeNames,
    );
    const nodes = out.nodes as Array<{ longName: string | null }>;
    expect(nodes[0].longName).toBe('Permitted Node 1');
  });

  it('leaves a non-node name field alone (no sibling nodeNum, and roleName is not a node label)', () => {
    const out = redactEvidence(
      { name: 'Not A Node', members: [{ nodeNum: 1, name: 'X', role: 2, roleName: 'ROUTER' }] },
      permitted,
      nodeNames,
    );
    // Top-level `name` has no sibling `nodeNum` at this object level -> untouched.
    expect(out.name).toBe('Not A Node');
    const members = out.members as Array<{ roleName: string }>;
    // roleName has no matching `roleNodeNum` sibling -> untouched even though
    // the object also carries a `nodeNum` field.
    expect(members[0].roleName).toBe('ROUTER');
  });

  it('does not throw on a pathologically deep structure and stops walking past the depth cap', () => {
    let deep: Record<string, unknown> = { nodeNum: 1, name: 'leaf' };
    for (let i = 0; i < 20; i++) {
      deep = { child: deep };
    }
    expect(() => redactEvidence(deep, permitted, nodeNames)).not.toThrow();
  });
});

describe('buildSummary (#4964 report reorg WP1, spec §4.3, §10.1)', () => {
  type WireIssue = Parameters<typeof buildSummary>[0][number];

  function makeWire(overrides: Partial<WireIssue> & { id: number; issueType: string }): WireIssue {
    return {
      subjectKey: `node:${overrides.id}`,
      nodeNum: null,
      nodeName: null,
      severity: 'info',
      confidence: 'medium',
      evidence: {},
      sourceIds: ['sourceA'],
      firstDetected: 1000,
      lastDetected: 1000,
      status: 'open',
      dismissed: false,
      dismissedAt: null,
      ...overrides,
    };
  }

  it('byType: worst-severity rank first, then total desc, then issueType asc', () => {
    const issues: WireIssue[] = [
      makeWire({ id: 1, issueType: 'A1_deprecated_role', severity: 'info' }),
      makeWire({ id: 2, issueType: 'A1_deprecated_role', severity: 'info' }),
      makeWire({ id: 3, issueType: 'B7_coverage_shadow', severity: 'info' }),
      makeWire({ id: 4, issueType: 'B7_coverage_shadow', severity: 'info' }),
      makeWire({ id: 5, issueType: 'B7_coverage_shadow', severity: 'info' }),
      makeWire({ id: 6, issueType: 'C1_key_security', severity: 'critical' }),
    ];
    const summary = buildSummary(issues, {});
    expect(summary.byType.map((t) => t.issueType)).toEqual([
      'C1_key_security',
      'B7_coverage_shadow',
      'A1_deprecated_role',
    ]);
    const b7 = summary.byType.find((t) => t.issueType === 'B7_coverage_shadow')!;
    expect(b7.total).toBe(3);
    expect(b7.worstSeverity).toBe('info');
    expect(b7.bySeverity).toEqual({ critical: 0, warning: 0, info: 3 });
  });

  it('byType tie on worstSeverity + total falls back to issueType asc', () => {
    const issues: WireIssue[] = [
      makeWire({ id: 1, issueType: 'B7_coverage_shadow', severity: 'warning' }),
      makeWire({ id: 2, issueType: 'A5_cosplay_router', severity: 'warning' }),
    ];
    const summary = buildSummary(issues, {});
    expect(summary.byType.map((t) => t.issueType)).toEqual(['A5_cosplay_router', 'B7_coverage_shadow']);
  });

  it('byType.dismissed counts dismissed rows of that type; latestDetected is the max lastDetected; only types with total > 0 appear', () => {
    const issues: WireIssue[] = [
      makeWire({ id: 1, issueType: 'A1_deprecated_role', lastDetected: 1000, dismissed: true }),
      makeWire({ id: 2, issueType: 'A1_deprecated_role', lastDetected: 5000, dismissed: false }),
    ];
    const summary = buildSummary(issues, {});
    expect(summary.byType).toHaveLength(1);
    const a1 = summary.byType[0];
    expect(a1.dismissed).toBe(1);
    expect(a1.latestDetected).toBe(5000);
  });

  it('byNode: the Mesh-wide (nodeNum: null) group is pinned first regardless of severity/count', () => {
    const issues: WireIssue[] = [
      makeWire({ id: 1, issueType: 'C1_key_security', nodeNum: 200, severity: 'critical' }),
      makeWire({ id: 2, issueType: 'A2b_congested_area', nodeNum: null, severity: 'info' }),
    ];
    const summary = buildSummary(issues, {});
    expect(summary.byNode[0].nodeNum).toBeNull();
    expect(summary.byNode[1].nodeNum).toBe(200);
  });

  it('byNode: worst-severity rank beats total, which beats latestDetected, which beats the nodeNum tiebreak', () => {
    const issues: WireIssue[] = [
      makeWire({ id: 1, issueType: 'A1_deprecated_role', nodeNum: 100, severity: 'warning', lastDetected: 1000 }),
      makeWire({ id: 2, issueType: 'A2a_chatty_node', nodeNum: 100, severity: 'warning', lastDetected: 1000 }),
      makeWire({ id: 3, issueType: 'A3_infra_power', nodeNum: 100, severity: 'warning', lastDetected: 1000 }),
      makeWire({ id: 4, issueType: 'C1_key_security', nodeNum: 200, severity: 'critical', lastDetected: 500 }),
      makeWire({ id: 5, issueType: 'A1_deprecated_role', nodeNum: 300, severity: 'warning', lastDetected: 1000 }),
      makeWire({ id: 6, issueType: 'A1_deprecated_role', nodeNum: 400, severity: 'warning', lastDetected: 2000 }),
    ];
    const summary = buildSummary(issues, {});
    const order = summary.byNode.map((n) => n.nodeNum);
    // 200 (critical, total 1) beats 100 (warning, total 3) on severity alone;
    // 100 (total 3) beats 400/300 (total 1 each) on total; 400 beats 300 on
    // more-recent latestDetected.
    expect(order).toEqual([200, 100, 400, 300]);
  });

  it('byNode: nodeNum asc breaks a full tie (severity, total, latestDetected all equal)', () => {
    const issues: WireIssue[] = [
      makeWire({ id: 1, issueType: 'A1_deprecated_role', nodeNum: 500, severity: 'warning', lastDetected: 1000 }),
      makeWire({ id: 2, issueType: 'A1_deprecated_role', nodeNum: 100, severity: 'warning', lastDetected: 1000 }),
    ];
    const summary = buildSummary(issues, {});
    expect(summary.byNode.map((n) => n.nodeNum)).toEqual([100, 500]);
  });

  it('byNode.issueTypes: ordered worst-severity-first for THAT node, then lexicographic', () => {
    const issues: WireIssue[] = [
      makeWire({ id: 1, issueType: 'B7_coverage_shadow', nodeNum: 100, severity: 'info' }),
      makeWire({ id: 2, issueType: 'A1_deprecated_role', nodeNum: 100, severity: 'critical' }),
      makeWire({ id: 3, issueType: 'A5_cosplay_router', nodeNum: 100, severity: 'warning' }),
      makeWire({ id: 4, issueType: 'A2a_chatty_node', nodeNum: 100, severity: 'warning' }),
    ];
    const summary = buildSummary(issues, {});
    const node = summary.byNode.find((n) => n.nodeNum === 100)!;
    expect(node.issueTypes).toEqual([
      'A1_deprecated_role', // critical
      'A2a_chatty_node', // warning, alpha before A5
      'A5_cosplay_router', // warning
      'B7_coverage_shadow', // info
    ]);
  });

  it("byNode.nodeName resolves from the group's findings; null for the Mesh-wide group", () => {
    const issues: WireIssue[] = [
      makeWire({ id: 1, issueType: 'A1_deprecated_role', nodeNum: 100, nodeName: 'Node A' }),
      makeWire({ id: 2, issueType: 'A2b_congested_area', nodeNum: null, nodeName: null }),
    ];
    const summary = buildSummary(issues, {});
    expect(summary.byNode.find((n) => n.nodeNum === 100)!.nodeName).toBe('Node A');
    expect(summary.byNode.find((n) => n.nodeNum === null)!.nodeName).toBeNull();
  });

  it('counts/total mirror the full input set, sourceNames passes through, and no evidence field appears anywhere in the output', () => {
    const issues: WireIssue[] = [
      makeWire({ id: 1, issueType: 'A1_deprecated_role', severity: 'critical', evidence: { secretSquirrel: true } }),
      makeWire({ id: 2, issueType: 'A1_deprecated_role', severity: 'warning' }),
    ];
    const summary = buildSummary(issues, { sourceA: 'Source A' });
    expect(summary.counts).toEqual({ critical: 1, warning: 1, info: 0, total: 2, dismissed: 0 });
    expect(summary.total).toBe(2);
    expect(summary.sourceNames).toEqual({ sourceA: 'Source A' });
    expect(JSON.stringify(summary)).not.toContain('secretSquirrel');
  });

  it('an empty input produces empty byType/byNode and zeroed counts', () => {
    const summary = buildSummary([], {});
    expect(summary.byType).toEqual([]);
    expect(summary.byNode).toEqual([]);
    expect(summary.counts).toEqual({ critical: 0, warning: 0, info: 0, total: 0, dismissed: 0 });
    expect(summary.total).toBe(0);
  });
});
