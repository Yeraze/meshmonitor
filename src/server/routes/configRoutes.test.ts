/**
 * Config Routes Integration Tests
 *
 * Converted from a hand-rolled mirror app (a duplicate `app.get('/api/config', ...)`
 * that never imported configRoutes.ts) to the real router via the route-test
 * harness, per CLAUDE.md: "changed route tests MUST use the harness." This is
 * part of #3502 PR1 — GET /config, GET /config/current, and the POST /config/*
 * setters moved out of server.ts into configRoutes.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import configRoutes from './configRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';
import { TxDisabledError } from '../errors/txDisabledError.js';

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

  describe('POST /lora — txEnabled passthrough (#4294)', () => {
    // configRoutes resolves the manager via resolveSourceManager(), which reads
    // the real sourceManagerRegistry. Register a minimal fake manager for
    // harness.sourceA so we can assert on the exact payload forwarded to
    // setLoRaConfig, instead of hitting the unconfigured fallbackManager (which
    // always 500s with "Not connected").
    let setLoRaConfig: ReturnType<typeof vi.fn>;
    let requestModuleConfig: ReturnType<typeof vi.fn>;
    let isTxEnabled: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      setLoRaConfig = vi.fn().mockResolvedValue(undefined);
      requestModuleConfig = vi.fn().mockResolvedValue(undefined);
      // Fail-open default, matching the real MeshtasticManager.isTxEnabled()
      // (true until config has arrived / when the caller's payload already
      // carries an explicit txEnabled). Individual tests override this to
      // exercise the omitted-field backfill.
      isTxEnabled = vi.fn().mockReturnValue(true);
      const fakeManager: ISourceManager & { setLoRaConfig: typeof setLoRaConfig; requestModuleConfig: typeof requestModuleConfig; isTxEnabled: typeof isTxEnabled } = {
        sourceId: harness.sourceA,
        sourceType: 'meshtastic_tcp',
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        getStatus: vi.fn().mockReturnValue({ sourceId: harness.sourceA, sourceName: 'Source A', sourceType: 'meshtastic_tcp', connected: true }),
        getLocalNodeInfo: vi.fn().mockReturnValue(null),
        startDistanceDeleteScheduler: vi.fn().mockResolvedValue(undefined),
        stopDistanceDeleteScheduler: vi.fn(),
        setLoRaConfig,
        requestModuleConfig,
        isTxEnabled,
      } as unknown as ISourceManager & { setLoRaConfig: typeof setLoRaConfig; requestModuleConfig: typeof requestModuleConfig; isTxEnabled: typeof isTxEnabled };
      await sourceManagerRegistry.addManager(fakeManager);
      await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceA);
    });

    afterEach(async () => {
      await sourceManagerRegistry.removeManager(harness.sourceA);
    });

    it('passes txEnabled:false through to setLoRaConfig instead of forcing true', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/lora').send({ sourceId: harness.sourceA, txEnabled: false, hopLimit: 3 });

      expect(res.status).toBe(200);
      expect(setLoRaConfig).toHaveBeenCalledWith(expect.objectContaining({ txEnabled: false, hopLimit: 3 }));
    });

    it('passes txEnabled:true through unchanged when the caller sets it', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/lora').send({ sourceId: harness.sourceA, txEnabled: true });

      expect(res.status).toBe(200);
      expect(setLoRaConfig).toHaveBeenCalledWith(expect.objectContaining({ txEnabled: true }));
    });

    // Regression for the whole-struct-replace / proto3 missing-bool hazard:
    // setLoRaConfig sends the device the ENTIRE LoRaConfig, and an omitted
    // bool decodes as false on the radio. When the caller's body doesn't
    // include txEnabled at all (e.g. saving hopLimit from a form with no TX
    // toggle), the route MUST backfill from the device's current state
    // rather than send the field omitted/undefined.
    it('backfills txEnabled from the device state when the caller omits it (radio-kill regression)', async () => {
      isTxEnabled.mockReturnValue(false);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/lora').send({ sourceId: harness.sourceA, hopLimit: 3 });

      expect(res.status).toBe(200);
      expect(setLoRaConfig).toHaveBeenCalledWith(expect.objectContaining({ txEnabled: false, hopLimit: 3 }));
    });

    it('backfills txEnabled:true from the device state when the caller omits it and TX is currently on', async () => {
      isTxEnabled.mockReturnValue(true);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/lora').send({ sourceId: harness.sourceA, hopLimit: 5 });

      expect(res.status).toBe(200);
      expect(setLoRaConfig).toHaveBeenCalledWith(expect.objectContaining({ txEnabled: true, hopLimit: 5 }));
    });
  });

  describe('POST /module/request — TX_DISABLED mapping (#4294)', () => {
    it('returns 409 TX_DISABLED when the remote target has transmit disabled', async () => {
      const requestModuleConfig = vi.fn().mockRejectedValue(new TxDisabledError());
      const fakeManager = {
        sourceId: harness.sourceA,
        sourceType: 'meshtastic_tcp',
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        getStatus: vi.fn().mockReturnValue({ sourceId: harness.sourceA, sourceName: 'Source A', sourceType: 'meshtastic_tcp', connected: true }),
        getLocalNodeInfo: vi.fn().mockReturnValue(null),
        startDistanceDeleteScheduler: vi.fn().mockResolvedValue(undefined),
        stopDistanceDeleteScheduler: vi.fn(),
        requestModuleConfig,
      } as unknown as ISourceManager;
      await sourceManagerRegistry.addManager(fakeManager);
      await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceA);

      try {
        const agent = await harness.loginAs(harness.limited);
        const res = await agent.post('/module/request').send({ sourceId: harness.sourceA, configType: 5 });

        expect(res.status).toBe(409);
        expect(res.body.success).toBe(false);
        expect(res.body.code).toBe('TX_DISABLED');
      } finally {
        await sourceManagerRegistry.removeManager(harness.sourceA);
      }
    });
  });
});
