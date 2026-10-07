/**
 * GET /api/traceroutes/recent serves the rows the `traceroutes` section of
 * GET /api/poll serves, so it carries the same gate: `traceroute:read` on the
 * row's source, and `viewOnMap` on the row's channel there when it has one.
 * It used to have no check and read every source.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import tracerouteRoutes from './tracerouteRoutes.js';
import { createRouteTestApp, type RouteTestHarness, type SeededUser } from '../test-helpers/routeTestApp.js';
import { ALL_SOURCES } from '../../db/repositories/index.js';

const row = (marker: string, channel: number | null, n: number) => ({
  fromNodeNum: 0x6a000000 + n,
  toNodeNum: 0x6b000000 + n,
  fromNodeId: `!6a00000${n}`,
  toNodeId: marker,
  route: '[1,2]',
  routeBack: '[]',
  snrTowards: '[4]',
  snrBack: '[]',
  timestamp: Date.now() - 1000 * n,
  createdAt: Date.now(),
  channel,
});

describe('GET /recent permission scope', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', tracerouteRoutes) });
    for (const sourceId of [harness.sourceA, harness.sourceB]) {
      await harness.db.traceroutes.deleteAllTraceroutes(sourceId);
    }
    await harness.db.traceroutes.insertTraceroute(row('A-CH0', 0, 1) as never, harness.sourceA);
    await harness.db.traceroutes.insertTraceroute(row('A-CH3', 3, 2) as never, harness.sourceA);
    await harness.db.traceroutes.insertTraceroute(row('A-NOCH', null, 3) as never, harness.sourceA);
    await harness.db.traceroutes.insertTraceroute(row('B-CH0', 0, 4) as never, harness.sourceB);
  });

  afterEach(async () => {
    for (const sourceId of [harness.sourceA, harness.sourceB]) {
      await harness.db.traceroutes.deleteAllTraceroutes(sourceId);
    }
    await harness.revokeAll(harness.anonymous.id);
    await harness.cleanup();
  });

  const markers = async (user: SeededUser | null, sourceId?: string): Promise<string[]> => {
    const agent = await harness.loginAs(user);
    const res = await agent.get('/recent').query(sourceId ? { sourceId } : {});
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // Rows come back requester-first, so the marker may be on either end.
    return (res.body as Array<{ fromNodeId: string; toNodeId: string }>)
      .map((tr) => [tr.fromNodeId, tr.toNodeId].find((id) => /^[AB]-/.test(id)) ?? '?')
      .sort();
  };

  it('an admin reads every source, and one source when it is named', async () => {
    expect(await markers(harness.admin)).toEqual(['A-CH0', 'A-CH3', 'A-NOCH', 'B-CH0']);
    expect(await markers(harness.admin, harness.sourceB)).toEqual(['B-CH0']);
  });

  it('a signed-out caller with no anonymous grant reads nothing', async () => {
    expect(await markers(null)).toEqual([]);
    const agent = await harness.loginAs(null);
    expect((await agent.get('/recent').query({ sourceId: harness.sourceA })).status).toBe(403);
  });

  it('a signed-out caller reads what the anonymous user is granted', async () => {
    await harness.grant(harness.anonymous.id, 'traceroute', 'read', harness.sourceA);
    await harness.grant(harness.anonymous.id, 'channel_0', 'viewOnMap', harness.sourceA);
    expect(await markers(null)).toEqual(['A-CH0', 'A-NOCH']);
  });

  it('with no source named, reads only the sources the caller holds traceroute:read on', async () => {
    await harness.grant(harness.limited.id, 'traceroute', 'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceA);
    // Channel grants on B without traceroute:read there show none of B.
    await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceB);
    expect(await markers(harness.limited)).toEqual(['A-CH0', 'A-NOCH']);
  });

  it('a named source needs traceroute:read on that source: a grant on another is a 403', async () => {
    await harness.grant(harness.limited.id, 'traceroute', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/recent').query({ sourceId: harness.sourceB });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('B-CH0');
  });

  it('hides a row heard on a channel the caller cannot view on the map', async () => {
    await harness.grant(harness.limited.id, 'traceroute', 'read', harness.sourceA);
    // No channel grant at all: only the row with no channel recorded.
    expect(await markers(harness.limited, harness.sourceA)).toEqual(['A-NOCH']);
    await harness.grant(harness.limited.id, 'channel_3', 'viewOnMap', harness.sourceA);
    expect(await markers(harness.limited, harness.sourceA)).toEqual(['A-CH3', 'A-NOCH']);
  });

  // The route's own behaviour, as an admin (moved here from the mocked
  // tracerouteRoutes.test.ts when the route gained its gate).
  describe('limit, window and hop count', () => {
    afterEach(() => vi.restoreAllMocks());

    it('adds hopCount, and 999 for a route that is not a JSON array', async () => {
      await harness.db.traceroutes.insertTraceroute({ ...row('A-BAD', null, 5), route: 'not-json' } as never, harness.sourceA);
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/recent').query({ sourceId: harness.sourceA });
      const hops = Object.fromEntries((res.body as Array<{ fromNodeId: string; toNodeId: string; hopCount: number }>)
        .map((tr) => [[tr.fromNodeId, tr.toNodeId].find((id) => /^A-/.test(id)), tr.hopCount]));
      expect(hops).toEqual({ 'A-CH0': 2, 'A-CH3': 2, 'A-NOCH': 2, 'A-BAD': 999 });
    });

    it('drops rows older than the hours window', async () => {
      await harness.db.traceroutes.insertTraceroute(
        { ...row('A-OLD', null, 6), timestamp: Date.now() - 48 * 60 * 60 * 1000 } as never, harness.sourceA);
      expect(await markers(harness.admin, harness.sourceA)).toEqual(['A-CH0', 'A-CH3', 'A-NOCH']);
    });

    it('passes an explicit limit, over every source for an admin who names none', async () => {
      const read = vi.spyOn(harness.db.traceroutes, 'getAllTraceroutes');
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/recent').query({ limit: 2 });
      expect(read).toHaveBeenCalledWith(2, ALL_SOURCES);
      expect(res.body).toHaveLength(2);
    });

    it('derives the limit from the per-source maxNodeAgeHours when a source is named (#4412 Phase 2)', async () => {
      vi.spyOn(harness.db.settings, 'getSetting').mockResolvedValue('5'); // tracerouteIntervalMinutes
      const perSource = vi.spyOn(harness.db.settings, 'getSettingForSource').mockImplementation(
        async (sourceId: string | null | undefined, key: string) =>
          key === 'maxNodeAgeHours' && sourceId === harness.sourceA ? '168' : null,
      );
      const read = vi.spyOn(harness.db.traceroutes, 'getAllTraceroutes');
      const agent = await harness.loginAs(harness.admin);
      await agent.get('/recent').query({ sourceId: harness.sourceA });
      // traceroutesPerHour(12) * maxNodeAgeHours(168) * 1.1 = 2217.6 -> ceil 2218
      expect(read).toHaveBeenCalledWith(2218, harness.sourceA);
      expect(perSource).toHaveBeenCalledWith(harness.sourceA, 'maxNodeAgeHours');
    });

    it('reads the un-namespaced global maxNodeAgeHours when no source is named', async () => {
      vi.spyOn(harness.db.settings, 'getSetting').mockResolvedValue('5');
      const perSource = vi.spyOn(harness.db.settings, 'getSettingForSource').mockResolvedValue('48');
      const read = vi.spyOn(harness.db.traceroutes, 'getAllTraceroutes');
      const agent = await harness.loginAs(harness.admin);
      await agent.get('/recent');
      expect(perSource).toHaveBeenCalledWith(null, 'maxNodeAgeHours');
      // traceroutesPerHour(12) * maxNodeAgeHours(48) * 1.1 = 633.6 -> ceil 634
      expect(read).toHaveBeenCalledWith(634, ALL_SOURCES);
    });

    it('a non-admin who names no source reads the permitted list, never ALL_SOURCES', async () => {
      await harness.grant(harness.limited.id, 'traceroute', 'read', harness.sourceA);
      const read = vi.spyOn(harness.db.traceroutes, 'getAllTraceroutes');
      const agent = await harness.loginAs(harness.limited);
      await agent.get('/recent').query({ limit: 7 });
      expect(read).toHaveBeenCalledWith(7, [harness.sourceA]);
    });

    it('answers 500 when a read fails', async () => {
      vi.spyOn(harness.db.traceroutes, 'getAllTraceroutes').mockRejectedValue(new Error('db error'));
      const agent = await harness.loginAs(harness.admin);
      expect((await agent.get('/recent')).status).toBe(500);
    });
  });
});
