/**
 * Config Routes Integration Tests
 *
 * Converted from a hand-rolled mirror app (a duplicate `app.get('/api/config', ...)`
 * that never imported configRoutes.ts) to the real router via the route-test
 * harness, per CLAUDE.md: "changed route tests MUST use the harness." This is
 * part of #3502 PR1 — GET /config, GET /config/current, and the POST /config/*
 * setters moved out of server.ts into configRoutes.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import configRoutes from './configRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

describe('configRoutes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/', configRoutes),
    });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  describe('GET / (public /api/config, optionalAuth)', () => {
    it('returns the base config shape for an anonymous caller', async () => {
      const agent = await harness.loginAs(null);
      const res = await agent.get('/');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('meshtasticTcpPort');
      expect(res.body).toHaveProperty('baseUrl');
      // Anonymous callers must not see the node IP.
      expect(res.body).not.toHaveProperty('meshtasticNodeIp');
    });

    it('includes localNodeInfo for an authenticated caller once localNodeNum is set', async () => {
      await harness.db.nodes.upsertNode(
        {
          nodeNum: 2732916556,
          nodeId: '!a2e175b8',
          longName: 'Test Node',
          shortName: 'TEST',
          firmwareVersion: '2.3.0',
          rebootCount: 5,
          lastHeard: Math.floor(Date.now() / 1000),
        },
        harness.sourceA,
      );
      await harness.db.settings.setSourceSetting(harness.sourceA, 'localNodeNum', '2732916556');

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/').query({ sourceId: harness.sourceA });

      expect(res.status).toBe(200);
      expect(res.body.localNodeInfo).toEqual({
        nodeId: '!a2e175b8',
        longName: 'Test Node',
        shortName: 'TEST',
      });
      expect(res.body.deviceMetadata).toEqual({
        firmwareVersion: '2.3.0',
        rebootCount: 5,
      });
    });

    it('handles a missing localNodeNum gracefully', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/').query({ sourceId: harness.sourceB });

      expect(res.status).toBe(200);
      expect(res.body.localNodeInfo).toBeUndefined();
      expect(res.body.deviceMetadata).toBeUndefined();
    });
  });

  describe('GET /current (configuration:read gate)', () => {
    it('403s without configuration:read', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get('/current');
      expect(res.status).toBe(403);
    });

    it('200s for admin (bypasses the permission gate)', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/current');
      expect(res.status).toBe(200);
    });

    it('200s with configuration:read granted', async () => {
      // 'configuration' is a sourcey resource (SOURCEY_RESOURCES). This route's
      // requirePermission() call has no sourceIdFrom option, so it always checks
      // with sourceId=undefined — the "union across sources" branch, which only
      // matches grants that carry a (non-null) sourceId. A global (sourceId=null)
      // grant would never satisfy a sourcey resource here.
      await harness.grant(harness.limited.id, 'configuration', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get('/current');
      expect(res.status).toBe(200);
    });
  });

  describe('POST /device (configuration:write gate)', () => {
    it('403s without configuration:write', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/device').send({ nodeAddress: '1.2.3.4' });
      expect(res.status).toBe(403);
    });

    it('passes the permission gate with configuration:write granted (fails downstream — no live device in tests)', async () => {
      // Same sourcey-union nuance as GET /current above.
      await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/device').send({ nodeAddress: '1.2.3.4' });
      // Not 403: the grant let the request past requirePermission. The handler
      // itself then 500s because there is no live Meshtastic transport in this
      // test process (setDeviceConfig throws "Not connected to Meshtastic node").
      expect(res.status).not.toBe(403);
      expect(res.status).toBe(500);
    });

    it('passes the permission gate for admin without an explicit grant', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/device').send({ nodeAddress: '1.2.3.4' });
      expect(res.status).not.toBe(403);
      expect(res.status).toBe(500);
    });
  });
});
