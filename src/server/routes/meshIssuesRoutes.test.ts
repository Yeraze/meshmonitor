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
import meshIssuesRoutes, { redactEvidence } from './meshIssuesRoutes.js';
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
