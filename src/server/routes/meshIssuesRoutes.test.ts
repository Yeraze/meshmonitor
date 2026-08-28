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
import meshIssuesRoutes from './meshIssuesRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';
import { MESH_ISSUE_TYPES, nodeSubjectKey, type MeshIssueFinding } from '../services/meshIssues/types.js';
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
    nodeNum: overrides.nodeNum,
    severity: 'warning',
    confidence: 'high',
    evidence: { role: 4, roleName: 'REPEATER' },
    sourceIds: [],
    recommendation: 'Consider CLIENT_BASE (fixed, powered) or ROUTER_LATE.',
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
      expect(res.body.data.counts).toEqual({ critical: 1, warning: 1, info: 1, total: 3 });
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
});
