/**
 * Cross-source read scope for traceroute history and route-segment records
 * (#5898). `requirePermission(..., { sourceIdFrom: 'query' })` passes on a
 * grant for ANY source when the request names none, and these handlers used
 * to read every source in that case. With no `sourceId` they now read only
 * the sources the caller holds `traceroute:read` on (every source for an
 * admin). A named source the caller may not read stays a 403.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Express } from 'express';
import tracerouteRoutes from './tracerouteRoutes.js';
import routeSegmentRoutes from './routeSegmentRoutes.js';
import { createRouteTestApp, type RouteTestHarness, type SeededUser } from '../test-helpers/routeTestApp.js';

const FROM = 0x6c000001;
const TO = 0x6c000002;

const traceroute = (marker: string) => ({
  fromNodeNum: FROM,
  toNodeNum: TO,
  fromNodeId: marker,
  toNodeId: '!6c000002',
  route: '[1]',
  routeBack: '[]',
  snrTowards: '[4]',
  snrBack: '[]',
  timestamp: Date.now() - 1000,
  createdAt: Date.now(),
  channel: null,
});

const segment = (distanceKm: number, isRecordHolder: boolean) => ({
  fromNodeNum: FROM,
  toNodeNum: TO,
  fromNodeId: '!6c000001',
  toNodeId: '!6c000002',
  distanceKm,
  isRecordHolder,
  transportMechanism: null,
  timestamp: Date.now(),
  createdAt: Date.now(),
});

describe('traceroute history and route-segment records: per-source read scope', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app: Express) => {
        app.use('/traceroutes', tracerouteRoutes);
        app.use('/route-segments', routeSegmentRoutes);
      },
    });
    for (const sourceId of [harness.sourceA, harness.sourceB]) {
      await harness.db.traceroutes.deleteAllTraceroutes(sourceId);
      await harness.db.traceroutes.deleteAllRouteSegments(sourceId);
    }
    await harness.db.traceroutes.insertTraceroute(traceroute('A-ROW') as never, harness.sourceA);
    await harness.db.traceroutes.insertTraceroute(traceroute('B-ROW') as never, harness.sourceB);
    // B's segments are longer, so an unscoped read picks B's.
    await harness.db.traceroutes.insertRouteSegment(segment(5, false), harness.sourceA);
    await harness.db.traceroutes.insertRouteSegment(segment(5, true), harness.sourceA);
    await harness.db.traceroutes.insertRouteSegment(segment(50, false), harness.sourceB);
    await harness.db.traceroutes.insertRouteSegment(segment(50, true), harness.sourceB);
  });

  afterEach(async () => {
    for (const sourceId of [harness.sourceA, harness.sourceB]) {
      await harness.db.traceroutes.deleteAllTraceroutes(sourceId);
      await harness.db.traceroutes.deleteAllRouteSegments(sourceId);
    }
    await harness.cleanup();
  });

  const historyMarkers = async (user: SeededUser, sourceId?: string) => {
    const agent = await harness.loginAs(user);
    const res = await agent.get(`/traceroutes/history/${FROM}/${TO}`).query(sourceId ? { sourceId } : {});
    return {
      status: res.status,
      markers: Array.isArray(res.body)
        ? (res.body as Array<{ fromNodeId: string; toNodeId: string }>)
          .map((tr) => [tr.fromNodeId, tr.toNodeId].find((id) => /^[AB]-/.test(id)) ?? '?')
          .sort()
        : [],
    };
  };

  describe('GET /traceroutes/history/:from/:to', () => {
    it('with no source named, a user granted only A gets no rows from B', async () => {
      await harness.grant(harness.limited.id, 'traceroute', 'read', harness.sourceA);
      const res = await historyMarkers(harness.limited);
      expect(res.status).toBe(200);
      expect(res.markers).toEqual(['A-ROW']);
    });

    it('an admin who names no source reads every source', async () => {
      const res = await historyMarkers(harness.admin);
      expect(res.markers).toEqual(['A-ROW', 'B-ROW']);
    });

    it('a named source the caller cannot read is a 403', async () => {
      await harness.grant(harness.limited.id, 'traceroute', 'read', harness.sourceA);
      const res = await historyMarkers(harness.limited, harness.sourceB);
      expect(res.status).toBe(403);
      expect(res.markers).toEqual([]);
    });

    it('a named source the caller can read returns that source only', async () => {
      await harness.grant(harness.limited.id, 'traceroute', 'read', harness.sourceA);
      expect((await historyMarkers(harness.limited, harness.sourceA)).markers).toEqual(['A-ROW']);
    });
  });

  for (const path of ['/route-segments/longest-active', '/route-segments/record-holder']) {
    describe(`GET ${path}`, () => {
      it('with no source named, a user granted only A gets A\'s record, not B\'s', async () => {
        await harness.grant(harness.limited.id, 'traceroute', 'read', harness.sourceA);
        const agent = await harness.loginAs(harness.limited);
        const res = await agent.get(path);
        expect(res.status).toBe(200);
        expect(res.body?.distanceKm).toBe(5);
      });

      it('an admin who names no source reads every source', async () => {
        const agent = await harness.loginAs(harness.admin);
        const res = await agent.get(path);
        expect(res.status).toBe(200);
        expect(res.body?.distanceKm).toBe(50);
      });

      it('a named source the caller cannot read is a 403', async () => {
        await harness.grant(harness.limited.id, 'traceroute', 'read', harness.sourceA);
        const agent = await harness.loginAs(harness.limited);
        const res = await agent.get(path).query({ sourceId: harness.sourceB });
        expect(res.status).toBe(403);
      });
    });
  }
});
