/**
 * GET /api/sources/:id/nodes/:nodeNum/flight-match (#5374) — per-source
 * isolation and the private-position rule, on the real-middleware harness.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import aircraftFlightMatchRoutes from './aircraftFlightMatchRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const NODE = 0xdeadbeef;

describe('GET /sources/:id/nodes/:nodeNum/flight-match', () => {
  let harness: RouteTestHarness;

  const seedNode = async (sourceId: string, privatePos = false) => {
    await harness.db.nodes.upsertNode(
      {
        nodeNum: NODE,
        nodeId: '!deadbeef',
        longName: 'Balloon',
        shortName: 'BAL',
        channel: 0,
        positionOverrideIsPrivate: privatePos,
        lastHeard: Math.floor(Date.now() / 1000),
      } as any,
      sourceId,
    );
  };

  const seedMatch = async (sourceId: string, hex: string, status: 'possible' | 'matched' | 'none' = 'matched') => {
    await harness.db.startAircraftFlightMatchEpisodeAsync(sourceId, NODE, 1000);
    await harness.db.recordAircraftFlightMatchLookupAsync(sourceId, NODE, {
      episodeStartedAt: 1000,
      lookupsBefore: 0,
      firstLookupAt: 1500,
      result: {
        status,
        feed: 'adsb.lol',
        hex: status === 'none' ? null : hex,
        callsign: 'UAL123',
        aircraftType: 'B738',
        registration: 'N12345',
        gsKt: 450,
        trackDeg: 270,
        altM: 3000,
        distanceKm: 1.2,
        matchedAt: 2000,
      },
    });
  };

  const url = (sourceId: string, nodeNum: number | string = NODE) => `/sources/${sourceId}/nodes/${nodeNum}/flight-match`;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => {
        const parent = express.Router();
        parent.use('/:id/nodes/:nodeNum/flight-match', aircraftFlightMatchRoutes);
        app.use('/sources', parent);
      },
    });
    await harness.db.settings.setSetting('adsbMatchEnabled', 'true');
    await seedNode(harness.sourceA);
    await seedNode(harness.sourceB);
    await seedMatch(harness.sourceA, 'aaaaaa');
    await seedMatch(harness.sourceB, 'bbbbbb');
  });

  afterEach(async () => {
    await harness.db.settings.deleteSetting('adsbMatchEnabled').catch(() => {});
    await harness.db.deleteNodeAsync(NODE, harness.sourceA).catch(() => {});
    await harness.db.deleteNodeAsync(NODE, harness.sourceB).catch(() => {});
    await harness.cleanup();
  });

  it('denies a user without nodes:read', async () => {
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.get(url(harness.sourceA))).status).toBe(403);
  });

  describe('with nodes:read on sourceA only', () => {
    beforeEach(async () => {
      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    });

    it('returns sourceA\'s match with the feed link and credit', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(url(harness.sourceA));
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toMatchObject({
        nodeNum: NODE,
        status: 'matched',
        hex: 'aaaaaa',
        callsign: 'UAL123',
        aircraftType: 'B738',
        registration: 'N12345',
        gsKt: 450,
        trackDeg: 270,
        feed: 'adsb.lol',
        feedName: 'adsb.lol',
        flightUrl: 'https://adsb.lol/?icao=aaaaaa',
        attribution: 'Data: adsb.lol',
      });
      // Internal bookkeeping stays server-side.
      expect(res.body.data).not.toHaveProperty('lookups');
      expect(res.body.data).not.toHaveProperty('sourceId');
    });

    it('is 403 on sourceB, whose match stays unseen', async () => {
      const agent = await harness.loginAs(harness.limited);
      expect((await agent.get(url(harness.sourceB))).status).toBe(403);
    });

    it('returns null when there is no match or the status is none', async () => {
      await harness.db.deleteAircraftFlightMatchAsync(harness.sourceA, NODE);
      const agent = await harness.loginAs(harness.limited);
      expect((await agent.get(url(harness.sourceA))).body).toEqual({ success: true, data: null });

      await seedMatch(harness.sourceA, 'aaaaaa', 'none');
      expect((await agent.get(url(harness.sourceA))).body.data).toBeNull();
    });

    it('returns null when matching is turned off', async () => {
      await harness.db.settings.setSetting('adsbMatchEnabled', 'false');
      const agent = await harness.loginAs(harness.limited);
      expect((await agent.get(url(harness.sourceA))).body.data).toBeNull();
    });

    it('rejects a bad nodeNum', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(url(harness.sourceA, 'abc'));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_NODE_NUM');
      expect((await agent.get(url(harness.sourceA, '4294967296'))).status).toBe(400);
    });

    describe('private position override', () => {
      beforeEach(async () => {
        await seedNode(harness.sourceA, true);
      });

      it('hides the match from a user without nodes_private:read', async () => {
        const agent = await harness.loginAs(harness.limited);
        const res = await agent.get(url(harness.sourceA));
        expect(res.status).toBe(200);
        expect(res.body.data).toBeNull();
      });

      it('shows it with nodes_private:read on this source', async () => {
        await harness.grant(harness.limited.id, 'nodes_private', 'read', harness.sourceA);
        const agent = await harness.loginAs(harness.limited);
        expect((await agent.get(url(harness.sourceA))).body.data?.hex).toBe('aaaaaa');
      });

      it('nodes_private:read on another source does not count', async () => {
        await harness.grant(harness.limited.id, 'nodes_private', 'read', harness.sourceB);
        const agent = await harness.loginAs(harness.limited);
        expect((await agent.get(url(harness.sourceA))).body.data).toBeNull();
      });

      it('admins always see it', async () => {
        const agent = await harness.loginAs(harness.admin);
        expect((await agent.get(url(harness.sourceA))).body.data?.hex).toBe('aaaaaa');
      });
    });
  });
});
