/**
 * Route Segment Routes — per-transport records + permission isolation (#5101 P2 WP4)
 *
 * Rewritten onto the real-middleware harness (createRouteTestApp), per
 * CLAUDE.md's Route Test Harness rule: new/changed route tests must use it
 * instead of monkey-patching `vi.mock('../../services/database.js', ...)`.
 * Template: src/server/routes/sourceRoutes.permissions.test.ts.
 *
 * See docs/internal/dev-notes/TRANSPORT_BREAKDOWN_P2_SPEC.md §4.5 / §7 / §10.3.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import routeSegmentRoutes from './routeSegmentRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import type { DbRouteSegment } from '../../db/types.js';

const BASE_SEGMENT: Omit<DbRouteSegment, 'fromNodeNum' | 'toNodeNum' | 'fromNodeId' | 'toNodeId'> = {
  distanceKm: 1,
  isRecordHolder: false,
  transportMechanism: null,
  timestamp: Date.now(),
  createdAt: Date.now(),
};

/** Insert a route segment for a source, RF by default (transportMechanism null). */
async function seedSegment(
  harness: RouteTestHarness,
  sourceId: string,
  overrides: Partial<DbRouteSegment> & { fromNodeNum: number; toNodeNum: number },
): Promise<void> {
  await harness.db.traceroutes.insertRouteSegment(
    {
      ...BASE_SEGMENT,
      fromNodeId: `!${overrides.fromNodeNum.toString(16).padStart(8, '0')}`,
      toNodeId: `!${overrides.toNodeNum.toString(16).padStart(8, '0')}`,
      ...overrides,
    },
    sourceId,
  );
}

describe('routeSegmentRoutes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/', routeSegmentRoutes),
    });
  });

  afterEach(async () => {
    // The harness does not clear route_segments/messages between tests.
    await harness.db.traceroutes.deleteAllRouteSegments(harness.sourceA);
    await harness.db.traceroutes.deleteAllRouteSegments(harness.sourceB);
    await harness.cleanup();
  });

  describe('GET /longest-active', () => {
    it('returns null when no segment exists for the source', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/longest-active?sourceId=${harness.sourceA}`);

      expect(res.status).toBe(200);
      expect(res.body).toBeNull();
    });

    it('returns legacy top-level fields = longest of the three classes, plus byTransport', async () => {
      await seedSegment(harness, harness.sourceA, {
        fromNodeNum: 100, toNodeNum: 200, distanceKm: 5, transportMechanism: null, // rf
      });
      await seedSegment(harness, harness.sourceA, {
        fromNodeNum: 100, toNodeNum: 300, distanceKm: 9, transportMechanism: 6, // udp — longest overall
      });

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/longest-active?sourceId=${harness.sourceA}`);

      expect(res.status).toBe(200);
      expect(res.body.distanceKm).toBe(9);
      expect(res.body.transport).toBe('udp');
      expect(res.body.byTransport.udp.distanceKm).toBe(9);
      expect(res.body.byTransport.rf.distanceKm).toBe(5);
      expect(res.body.byTransport.mqtt).toBeNull();
    });

    it('enriches segment with node names', async () => {
      await harness.db.nodes.upsertNode(
        { nodeNum: 100, nodeId: '!00000064', longName: 'Alpha', shortName: 'A', channel: 0, lastHeard: Math.floor(Date.now() / 1000) },
        harness.sourceA,
      );
      await harness.db.nodes.upsertNode(
        { nodeNum: 200, nodeId: '!000000c8', longName: 'Beta', shortName: 'B', channel: 0, lastHeard: Math.floor(Date.now() / 1000) },
        harness.sourceA,
      );
      await seedSegment(harness, harness.sourceA, { fromNodeNum: 100, toNodeNum: 200, distanceKm: 5 });

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/longest-active?sourceId=${harness.sourceA}`);

      expect(res.body.fromNodeName).toBe('Alpha');
      expect(res.body.toNodeName).toBe('Beta');
    });

    it('falls back to nodeId when node not found', async () => {
      await seedSegment(harness, harness.sourceA, { fromNodeNum: 555, toNodeNum: 666, distanceKm: 5 });

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/longest-active?sourceId=${harness.sourceA}`);

      expect(res.body.fromNodeName).toBe(`!${(555).toString(16).padStart(8, '0')}`);
      expect(res.body.toNodeName).toBe(`!${(666).toString(16).padStart(8, '0')}`);
    });

    it('?sourceId=A never returns B\'s segments', async () => {
      await seedSegment(harness, harness.sourceB, { fromNodeNum: 100, toNodeNum: 200, distanceKm: 50 });

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/longest-active?sourceId=${harness.sourceA}`);

      expect(res.status).toBe(200);
      expect(res.body).toBeNull();
    });
  });

  describe('GET /record-holder', () => {
    it('returns null when no record holder exists', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/record-holder?sourceId=${harness.sourceA}`);

      expect(res.status).toBe(200);
      expect(res.body).toBeNull();
    });

    it('returns the record-holder shape with byTransport', async () => {
      await seedSegment(harness, harness.sourceA, {
        fromNodeNum: 100, toNodeNum: 200, distanceKm: 12, isRecordHolder: true, transportMechanism: 5, // mqtt
      });

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/record-holder?sourceId=${harness.sourceA}`);

      expect(res.status).toBe(200);
      expect(res.body.transport).toBe('mqtt');
      expect(res.body.byTransport.mqtt.distanceKm).toBe(12);
      expect(res.body.byTransport.rf).toBeNull();
      expect(res.body.byTransport.udp).toBeNull();
    });
  });

  describe('GET permission isolation (#5101 §10.3)', () => {
    beforeEach(async () => {
      await harness.grant(harness.limited.id, 'info', 'read', harness.sourceA);
      // No grant at all for sourceB.
    });

    it('a grant on sourceA does not permit reading sourceB (403)', async () => {
      const agent = await harness.loginAs(harness.limited);

      const resA = await agent.get(`/longest-active?sourceId=${harness.sourceA}`);
      expect(resA.status).toBe(200);

      const resB = await agent.get(`/longest-active?sourceId=${harness.sourceB}`);
      expect(resB.status).toBe(403);
    });

    it('record-holder: a grant on sourceA does not permit reading sourceB (403)', async () => {
      const agent = await harness.loginAs(harness.limited);

      const resA = await agent.get(`/record-holder?sourceId=${harness.sourceA}`);
      expect(resA.status).toBe(200);

      const resB = await agent.get(`/record-holder?sourceId=${harness.sourceB}`);
      expect(resB.status).toBe(403);
    });
  });

  describe('DELETE /record-holder', () => {
    beforeEach(async () => {
      await seedSegment(harness, harness.sourceA, {
        fromNodeNum: 100, toNodeNum: 200, distanceKm: 5, isRecordHolder: true, transportMechanism: null, // rf
      });
      await seedSegment(harness, harness.sourceA, {
        fromNodeNum: 100, toNodeNum: 300, distanceKm: 9, isRecordHolder: true, transportMechanism: 5, // mqtt
      });
    });

    it('transport=mqtt clears only the mqtt record, keeps rf', async () => {
      const agent = await harness.loginAs(harness.admin);
      const del = await agent.delete(`/record-holder?sourceId=${harness.sourceA}&transport=mqtt`);
      expect(del.status).toBe(200);
      expect(del.body.success).toBe(true);

      const res = await agent.get(`/record-holder?sourceId=${harness.sourceA}`);
      expect(res.body.byTransport.mqtt).toBeNull();
      expect(res.body.byTransport.rf.distanceKm).toBe(5);
    });

    it('no transport clears all classes (legacy)', async () => {
      const agent = await harness.loginAs(harness.admin);
      const del = await agent.delete(`/record-holder?sourceId=${harness.sourceA}`);
      expect(del.status).toBe(200);
      expect(del.body.success).toBe(true);

      const res = await agent.get(`/record-holder?sourceId=${harness.sourceA}`);
      expect(res.body).toBeNull();
    });

    it('transport=bogus → 400 INVALID_TRANSPORT', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.delete(`/record-holder?sourceId=${harness.sourceA}&transport=bogus`);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_TRANSPORT');
    });

    it('no sourceId → 400 MISSING_SOURCE_ID (repository throws without one)', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.delete('/record-holder');

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('MISSING_SOURCE_ID');
    });

    it('no info:write grant → 403', async () => {
      await harness.grant(harness.limited.id, 'info', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.delete(`/record-holder?sourceId=${harness.sourceA}`);

      expect(res.status).toBe(403);
    });

    it('info:write on sourceA does not permit clearing sourceB (403)', async () => {
      await harness.grant(harness.limited.id, 'info', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.delete(`/record-holder?sourceId=${harness.sourceB}`);

      expect(res.status).toBe(403);
    });
  });
});
