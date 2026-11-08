/**
 * Mesh Issues routes — MeshCore findings (#6263 S5): subjectKey `mc:<pk>`,
 * `nodeNum` null, evidence `publicKey` / `nodeName` / `sourceIds`. The route
 * must intersect `sourceIds` with the caller's permitted sources and must not
 * leak another source's ids or contact name through evidence.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import meshIssuesRoutes, { buildSummary } from './meshIssuesRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';
import { MESH_ISSUE_TYPES, meshcoreSubjectKey, type MeshIssueFinding } from '../services/meshIssues/types.js';

vi.mock('../services/meshIssuesScheduler.js', () => ({
  meshIssuesScheduler: { runNow: vi.fn(), getStatus: vi.fn() },
}));

const PK = 'ab'.repeat(32);

function mcFinding(sourceIds: string[]): MeshIssueFinding {
  return {
    issueType: MESH_ISSUE_TYPES.A4_MOBILE_INFRA,
    subjectKey: meshcoreSubjectKey(PK),
    nodeNum: null,
    severity: 'warning',
    confidence: 'medium',
    evidence: {
      publicKey: PK,
      nodeName: 'Hill Repeater',
      sourceIds,
      roleName: 'Repeater',
      spanMeters: 5000,
      sources: sourceIds,
    },
    sourceIds,
    recommendation: 'A node that moves should be CLIENT.',
  };
}

describe('meshIssuesRoutes with MeshCore findings', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/api/analysis/mesh-issues', meshIssuesRoutes),
    });
  });

  afterEach(async () => {
    await databaseService.meshIssues.deleteAll();
    await harness.cleanup();
  });

  it('persists subjectKey mc:<pk> with a null nodeNum and returns evidence identity to an admin', async () => {
    await databaseService.upsertMeshIssueFindingAsync(mcFinding([harness.sourceA, harness.sourceB]), Date.now());
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/api/analysis/mesh-issues');
    expect(res.status).toBe(200);
    const issue = res.body.data.issues[0];
    expect(issue.subjectKey).toBe(`mc:${PK}`);
    expect(issue.nodeNum).toBeNull();
    expect(issue.evidence.publicKey).toBe(PK);
    expect(issue.evidence.nodeName).toBe('Hill Repeater');
    expect(issue.evidence.sourceIds.sort()).toEqual([harness.sourceA, harness.sourceB].sort());
  });

  it('drops a finding whose sources the caller cannot read', async () => {
    await databaseService.upsertMeshIssueFindingAsync(mcFinding([harness.sourceB]), Date.now());
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/api/analysis/mesh-issues');
    expect(res.status).toBe(200);
    expect(res.body.data.issues).toHaveLength(0);
  });

  it('intersects sourceIds and withholds the contact name when another source contributed', async () => {
    await databaseService.upsertMeshIssueFindingAsync(mcFinding([harness.sourceA, harness.sourceB]), Date.now());
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/api/analysis/mesh-issues');
    expect(res.status).toBe(200);
    expect(res.body.data.issues).toHaveLength(1);
    const issue = res.body.data.issues[0];
    expect(issue.sourceIds).toEqual([harness.sourceA]);
    expect(issue.evidence.sourceIds).toEqual([harness.sourceA]);
    expect(issue.evidence.sources).toEqual([harness.sourceA]);
    expect(issue.evidence.nodeName).toBeNull();
    expect(JSON.stringify(issue)).not.toContain(harness.sourceB);
  });

  it('keeps the contact name when every contributing source is readable', async () => {
    await databaseService.upsertMeshIssueFindingAsync(mcFinding([harness.sourceA]), Date.now());
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/api/analysis/mesh-issues');
    expect(res.body.data.issues[0].evidence.nodeName).toBe('Hill Repeater');
  });

  describe('By Node grouping', () => {
    const PK2 = 'cd'.repeat(32);

    async function seed() {
      const now = Date.now();
      await databaseService.upsertMeshIssueFindingAsync(mcFinding([harness.sourceA]), now);
      await databaseService.upsertMeshIssueFindingAsync(
        { ...mcFinding([harness.sourceA]), subjectKey: meshcoreSubjectKey(PK2), issueType: MESH_ISSUE_TYPES.A3_INFRA_POWER,
          evidence: { publicKey: PK2, nodeName: 'Other', sourceIds: [harness.sourceA], sources: [harness.sourceA] } },
        now,
      );
      await databaseService.upsertMeshIssueFindingAsync(
        { ...mcFinding([harness.sourceA]), subjectKey: 'area:1:1', issueType: MESH_ISSUE_TYPES.A2B_CONGESTED_AREA, evidence: {} },
        now,
      );
    }

    it('summary groups MeshCore findings per node and keeps Mesh-wide for the rest', async () => {
      await seed();
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/api/analysis/mesh-issues/summary');
      expect(res.status).toBe(200);
      const byNode = res.body.data.byNode;
      expect(byNode).toHaveLength(3);
      expect(byNode[0].nodeNum).toBeNull();
      expect(byNode[0].subjectKey).toBeUndefined();
      expect(byNode[0].total).toBe(1); // only the area finding
      const mc = byNode.filter((n: { subjectKey?: string }) => n.subjectKey);
      expect(mc.map((n: { subjectKey: string }) => n.subjectKey).sort()).toEqual([`mc:${PK}`, `mc:${PK2}`].sort());
      expect(mc.find((n: { subjectKey: string }) => n.subjectKey === `mc:${PK}`).nodeName).toBe('Hill Repeater');
      expect(mc[0].sourceIds).toEqual([harness.sourceA]);
    });

    it('GET ?nodeNum=none excludes MeshCore rows; ?subjectKey= returns one node', async () => {
      await seed();
      const agent = await harness.loginAs(harness.admin);
      const none = await agent.get('/api/analysis/mesh-issues?nodeNum=none');
      expect(none.body.data.issues.map((i: { subjectKey: string }) => i.subjectKey)).toEqual(['area:1:1']);
      const one = await agent.get(`/api/analysis/mesh-issues?subjectKey=mc:${PK}`);
      expect(one.body.data.issues.map((i: { subjectKey: string }) => i.subjectKey)).toEqual([`mc:${PK}`]);
    });

    it('bulk dismiss: Mesh-wide scope spares MeshCore findings; subject scope hits only that node', async () => {
      await seed();
      const agent = await harness.loginAs(harness.admin);
      const wide = await agent.post('/api/analysis/mesh-issues/bulk/dismiss').send({ scope: 'node', nodeNum: null });
      expect(wide.body.data.affected).toBe(1);
      const sub = await agent
        .post('/api/analysis/mesh-issues/bulk/dismiss')
        .send({ scope: 'subject', subjectKey: `mc:${PK}` });
      expect(sub.body.data.affected).toBe(1);
      const bad = await agent.post('/api/analysis/mesh-issues/bulk/dismiss').send({ scope: 'subject', subjectKey: 'node:1' });
      expect(bad.status).toBe(400);
    });

    it('buildSummary leaves Meshtastic-only output unchanged (no subjectKey/sourceIds keys)', () => {
      const issue = {
        id: 1, issueType: 'A1_deprecated_role', subjectKey: 'node:100', nodeNum: 100, nodeName: 'N',
        severity: 'warning', confidence: 'high', evidence: {}, sourceIds: ['s'], firstDetected: 1, lastDetected: 2,
        status: 'open', dismissed: false, dismissedAt: null,
      };
      const summary = buildSummary([issue as any], {});
      expect(Object.keys(summary.byNode[0]).sort()).toEqual(
        ['bySeverity', 'issueTypes', 'latestDetected', 'nodeName', 'nodeNum', 'total', 'worstSeverity'],
      );
    });
  });
});
