/**
 * Admin Routes Integration Tests
 *
 * All 17 handlers moved out of server.ts as part of #3502 PR2 were previously
 * covered by zero real tests (server.test.ts hand-rolls a duplicate mini-app
 * that never imports adminRoutes.ts). This is the first real coverage of the
 * requireAdmin() gate plus one representative body-handling endpoint, via the
 * route-test harness (createRouteTestApp).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import adminRoutes from './adminRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';
import { TxDisabledError } from '../errors/txDisabledError.js';
import protobufService from '../protobufService.js';

// channelUrlService is dynamically imported inside export-config/import-config —
// mock it so those handlers don't need a real base64url-encoded channel blob.
vi.mock('../services/channelUrlService.js', () => ({
  default: {
    decodeUrl: vi.fn(),
    encodeUrl: vi.fn().mockReturnValue('meshtastic://mock-url'),
  },
}));

describe('adminRoutes — requireAdmin() gate', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/', adminRoutes),
    });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('GET /suppressed-ghosts → 403 for a logged-in non-admin user', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/suppressed-ghosts');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'FORBIDDEN_ADMIN' });
  });

  it('GET /suppressed-ghosts → 401 for an anonymous caller', async () => {
    const agent = await harness.loginAs(null);
    const res = await agent.get('/suppressed-ghosts');
    expect(res.status).toBe(401);
  });

  it('GET /suppressed-ghosts → 200 for an admin', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/suppressed-ghosts');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });
    expect(Array.isArray(res.body.suppressedNodes)).toBe(true);
  });
});

describe('adminRoutes — PUT /auto-favorite-targets/:nodeNum (body-handling)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/', adminRoutes),
    });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('403s for a non-admin caller (write blocked before body is even read)', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent
      .put('/auto-favorite-targets/12345')
      .send({ sourceId: harness.sourceA, enabled: true });
    expect(res.status).toBe(403);
  });

  it('400s when sourceId is missing from the body', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.put('/auto-favorite-targets/12345').send({ enabled: true });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining('sourceId') });
  });

  it('saves the config for an admin and GET reflects it back', async () => {
    const agent = await harness.loginAs(harness.admin);

    const putRes = await agent.put('/auto-favorite-targets/12345').send({
      sourceId: harness.sourceA,
      enabled: true,
      useNeighborInfo: false,
      intervalHours: 6,
      eligibleRoles: [2, 11],
    });
    expect(putRes.status).toBe(200);
    expect(putRes.body).toEqual({ success: true });

    const getRes = await agent
      .get('/auto-favorite-targets/12345')
      .query({ sourceId: harness.sourceA });
    expect(getRes.status).toBe(200);
    expect(getRes.body).toMatchObject({
      configured: true,
      sourceId: harness.sourceA,
      targetNodeNum: 12345,
      enabled: true,
      useNeighborInfo: false,
      intervalHours: 6,
      eligibleRoles: [2, 11],
    });
  });
});

describe('adminRoutes — TX-disabled mapping + txEnabled preservation (#4294)', () => {
  let harness: RouteTestHarness;

  // Minimal ISourceManager stub registered under harness.sourceA so
  // resolveSourceManager() finds it instead of the unconfigured fallbackManager.
  function makeFakeManager(overrides: Record<string, unknown>): ISourceManager {
    return {
      sourceId: harness.sourceA,
      sourceType: 'meshtastic_tcp',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue({ sourceId: harness.sourceA, sourceName: 'Source A', sourceType: 'meshtastic_tcp', connected: true }),
      getLocalNodeInfo: vi.fn().mockReturnValue({ nodeNum: 1, nodeId: '!00000001', longName: 'Local', shortName: 'LOC' }),
      startDistanceDeleteScheduler: vi.fn().mockResolvedValue(undefined),
      stopDistanceDeleteScheduler: vi.fn(),
      // Fail-open default, matching the real MeshtasticManager.isTxEnabled().
      isTxEnabled: vi.fn().mockReturnValue(true),
      // No cached remote-config snapshot by default (matches a manager that
      // has never run requestRemoteConfig(LORA_CONFIG) for this node).
      getRemoteNodeConfig: vi.fn().mockReturnValue(null),
      ...overrides,
    } as unknown as ISourceManager;
  }

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/', adminRoutes),
    });
  });

  afterEach(async () => {
    await sourceManagerRegistry.removeManager(harness.sourceA);
    await harness.cleanup();
  });

  it('POST /reboot returns 409 TX_DISABLED when the remote target has transmit disabled', async () => {
    const sendRebootCommand = vi.fn().mockRejectedValue(new TxDisabledError());
    await sourceManagerRegistry.addManager(makeFakeManager({ sendRebootCommand }));

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/reboot').send({ sourceId: harness.sourceA, nodeNum: 999 });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('TX_DISABLED');
  });

  it('POST /set-time returns 409 TX_DISABLED when the remote target has transmit disabled', async () => {
    const sendSetTimeCommand = vi.fn().mockRejectedValue(new TxDisabledError());
    await sourceManagerRegistry.addManager(makeFakeManager({ sendSetTimeCommand }));

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/set-time').send({ sourceId: harness.sourceA, nodeNum: 999 });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('TX_DISABLED');
  });

  it('POST /export-config emits the device actual txEnabled instead of forcing true', async () => {
    const getDeviceConfig = vi.fn().mockResolvedValue({
      lora: { usePreset: true, modemPreset: 0, bandwidth: 0, spreadFactor: 0, codingRate: 0,
        frequencyOffset: 0, region: 1, hopLimit: 3, txEnabled: false, txPower: 0,
        channelNum: 0, sx126xRxBoostedGain: false, configOkToMqtt: false },
    });
    await sourceManagerRegistry.addManager(makeFakeManager({ getDeviceConfig }));
    await harness.db.channels.upsertChannel(
      { id: 0, name: 'Primary', psk: 'AQ==', uplinkEnabled: false, downlinkEnabled: false, positionPrecision: 32 },
      harness.sourceA,
    );

    const channelUrlService = (await import('../services/channelUrlService.js')).default;

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/export-config').send({
      sourceId: harness.sourceA,
      channelIds: [0],
      includeLoraConfig: true,
    });

    expect(res.status).toBe(200);
    expect(channelUrlService.encodeUrl).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ txEnabled: false }),
    );
  });

  // setLoRaConfig sends the device the ENTIRE LoRaConfig struct (whole-message
  // replace, not a patch), and proto3 decodes an omitted bool as false — so
  // the decoded URL's txEnabled must be overridden with the device's actual
  // current value (backfilled via isTxEnabled()), never stripped/omitted.
  // Stripping the key here would have silently sent txEnabled=false to a
  // TX-enabled device (#4294 regression this test locks in).
  it('POST /import-config (local node) overrides the decoded txEnabled with the device actual value before setLoRaConfig', async () => {
    const setLoRaConfig = vi.fn().mockResolvedValue(undefined);
    const beginEditSettings = vi.fn().mockResolvedValue(undefined);
    const commitEditSettings = vi.fn().mockResolvedValue(undefined);
    const isTxEnabled = vi.fn().mockReturnValue(false);
    await sourceManagerRegistry.addManager(makeFakeManager({ setLoRaConfig, beginEditSettings, commitEditSettings, isTxEnabled }));

    const channelUrlService = (await import('../services/channelUrlService.js')).default;
    (channelUrlService.decodeUrl as any).mockReturnValue({
      channels: undefined,
      loraConfig: { hopLimit: 3, txEnabled: true, txPower: 20 },
    });

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/import-config').send({
      sourceId: harness.sourceA,
      nodeNum: 1, // local node — matches getLocalNodeInfo().nodeNum above
      url: 'meshtastic://mock',
    });

    expect(res.status).toBe(200);
    expect(setLoRaConfig).toHaveBeenCalledTimes(1);
    const [calledWith] = setLoRaConfig.mock.calls[0];
    // Device's actual current txEnabled (false) wins over the decoded URL's
    // value (true).
    expect(calledWith).toMatchObject({ hopLimit: 3, txPower: 20, txEnabled: false });
  });

  it('POST /import-config (local node) backfills txEnabled:true when the device currently has transmit enabled', async () => {
    const setLoRaConfig = vi.fn().mockResolvedValue(undefined);
    const beginEditSettings = vi.fn().mockResolvedValue(undefined);
    const commitEditSettings = vi.fn().mockResolvedValue(undefined);
    const isTxEnabled = vi.fn().mockReturnValue(true);
    await sourceManagerRegistry.addManager(makeFakeManager({ setLoRaConfig, beginEditSettings, commitEditSettings, isTxEnabled }));

    const channelUrlService = (await import('../services/channelUrlService.js')).default;
    (channelUrlService.decodeUrl as any).mockReturnValue({
      channels: undefined,
      loraConfig: { hopLimit: 3 },
    });

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/import-config').send({
      sourceId: harness.sourceA,
      nodeNum: 1,
      url: 'meshtastic://mock',
    });

    expect(res.status).toBe(200);
    const [calledWith] = setLoRaConfig.mock.calls[0];
    expect(calledWith).toMatchObject({ hopLimit: 3, txEnabled: true });
  });

  describe('POST /import-config (remote node) — txEnabled preserve (#4315)', () => {
    // The remote branch fetches the remote node's LIVE LoRa config first
    // (requestRemoteConfig, LORA_CONFIG=5) and reuses its actual txEnabled,
    // interpreted with isTxEnabled()-style semantics (disabled only when
    // explicitly false). It falls back — when the live fetch throws or returns
    // nothing — to a cached remote-config snapshot (getRemoteNodeConfig), then
    // the decoded URL's own txEnabled, and finally to true (fail-open).
    // createSetLoRaConfigMessage is real (not mocked) — spy on it to inspect
    // the exact config object it received before protobuf-encoding, since
    // sendAdminCommand only sees opaque encoded bytes.

    it('uses the live remote LoRa config txEnabled, overriding the decoded value', async () => {
      const sendAdminCommand = vi.fn().mockResolvedValue(undefined);
      const getSessionPasskey = vi.fn().mockReturnValue(new Uint8Array([1, 2, 3, 4]));
      // Live fetch reports the remote device currently has TX disabled.
      const requestRemoteConfig = vi.fn().mockResolvedValue({ txEnabled: false });
      // Cached snapshot disagrees (true) — the live value must win over it.
      const getRemoteNodeConfig = vi.fn().mockReturnValue({
        deviceConfig: { lora: { txEnabled: true } },
        moduleConfig: {},
        lastUpdated: 0,
      });
      await sourceManagerRegistry.addManager(makeFakeManager({ sendAdminCommand, getSessionPasskey, requestRemoteConfig, getRemoteNodeConfig }));

      const spy = vi.spyOn(protobufService, 'createSetLoRaConfigMessage');
      const channelUrlService = (await import('../services/channelUrlService.js')).default;
      (channelUrlService.decodeUrl as any).mockReturnValue({
        channels: undefined,
        loraConfig: { hopLimit: 3, txEnabled: true },
      });

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/import-config').send({
        sourceId: harness.sourceA,
        nodeNum: 999, // remote — does not match getLocalNodeInfo().nodeNum (1)
        url: 'meshtastic://mock',
      });

      expect(res.status).toBe(202); // remote import is now async (#4482)
      expect(requestRemoteConfig).toHaveBeenCalledWith(999, 5, false);
      // The send happens in the background now — wait for it.
      await vi.waitFor(() => expect(spy).toHaveBeenCalledWith(expect.objectContaining({ hopLimit: 3, txEnabled: false }), expect.anything()));
      spy.mockRestore();
    });

    it('treats a live config with an omitted txEnabled as enabled (fail-open, matches isTxEnabled)', async () => {
      const sendAdminCommand = vi.fn().mockResolvedValue(undefined);
      const getSessionPasskey = vi.fn().mockReturnValue(new Uint8Array([1, 2, 3, 4]));
      // proto3 omits a false bool, but a device with TX enabled likewise omits
      // nothing meaningful here — the live config comes back without txEnabled.
      const requestRemoteConfig = vi.fn().mockResolvedValue({ hopLimit: 3 });
      await sourceManagerRegistry.addManager(makeFakeManager({ sendAdminCommand, getSessionPasskey, requestRemoteConfig }));

      const spy = vi.spyOn(protobufService, 'createSetLoRaConfigMessage');
      const channelUrlService = (await import('../services/channelUrlService.js')).default;
      (channelUrlService.decodeUrl as any).mockReturnValue({
        channels: undefined,
        loraConfig: { hopLimit: 3, txEnabled: false },
      });

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/import-config').send({
        sourceId: harness.sourceA,
        nodeNum: 999,
        url: 'meshtastic://mock',
      });

      expect(res.status).toBe(202); // remote import is now async (#4482)
      expect(requestRemoteConfig).toHaveBeenCalledWith(999, 5, false);
      // The send happens in the background now — wait for it.
      await vi.waitFor(() => expect(spy).toHaveBeenCalledWith(expect.objectContaining({ hopLimit: 3, txEnabled: true }), expect.anything()));
      spy.mockRestore();
    });

    it('interprets a cached snapshot with omitted txEnabled as enabled (matches the live-path semantics)', async () => {
      const sendAdminCommand = vi.fn().mockResolvedValue(undefined);
      const getSessionPasskey = vi.fn().mockReturnValue(new Uint8Array([1, 2, 3, 4]));
      // Live fetch unavailable; cached snapshot has a lora object but no
      // txEnabled field — same as a proto3-omitted/default read. It must be
      // treated as enabled (!== false), not deferred to the decoded URL value.
      const requestRemoteConfig = vi.fn().mockResolvedValue(null);
      const getRemoteNodeConfig = vi.fn().mockReturnValue({
        deviceConfig: { lora: { hopLimit: 3 } },
        moduleConfig: {},
        lastUpdated: 0,
      });
      await sourceManagerRegistry.addManager(makeFakeManager({ sendAdminCommand, getSessionPasskey, requestRemoteConfig, getRemoteNodeConfig }));

      const spy = vi.spyOn(protobufService, 'createSetLoRaConfigMessage');
      const channelUrlService = (await import('../services/channelUrlService.js')).default;
      (channelUrlService.decodeUrl as any).mockReturnValue({
        channels: undefined,
        loraConfig: { hopLimit: 3, txEnabled: false }, // would win if the cache were ignored
      });

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/import-config').send({
        sourceId: harness.sourceA,
        nodeNum: 999,
        url: 'meshtastic://mock',
      });

      expect(res.status).toBe(202); // remote import is now async (#4482)
      // The send happens in the background now — wait for it.
      await vi.waitFor(() => expect(spy).toHaveBeenCalledWith(expect.objectContaining({ hopLimit: 3, txEnabled: true }), expect.anything()));
      spy.mockRestore();
    });

    it('falls back to the cached remote-config snapshot when the live fetch throws', async () => {
      const sendAdminCommand = vi.fn().mockResolvedValue(undefined);
      const getSessionPasskey = vi.fn().mockReturnValue(new Uint8Array([1, 2, 3, 4]));
      const requestRemoteConfig = vi.fn().mockRejectedValue(new Error('remote config timeout'));
      const getRemoteNodeConfig = vi.fn().mockReturnValue({
        deviceConfig: { lora: { txEnabled: false } },
        moduleConfig: {},
        lastUpdated: 0,
      });
      await sourceManagerRegistry.addManager(makeFakeManager({ sendAdminCommand, getSessionPasskey, requestRemoteConfig, getRemoteNodeConfig }));

      const spy = vi.spyOn(protobufService, 'createSetLoRaConfigMessage');
      const channelUrlService = (await import('../services/channelUrlService.js')).default;
      (channelUrlService.decodeUrl as any).mockReturnValue({
        channels: undefined,
        loraConfig: { hopLimit: 3, txEnabled: true },
      });

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/import-config').send({
        sourceId: harness.sourceA,
        nodeNum: 999,
        url: 'meshtastic://mock',
      });

      expect(res.status).toBe(202); // remote import is now async (#4482)
      // The send happens in the background now — wait for it.
      await vi.waitFor(() => expect(spy).toHaveBeenCalledWith(expect.objectContaining({ hopLimit: 3, txEnabled: false }), expect.anything()));
      spy.mockRestore();
    });

    it('falls back to the decoded URL txEnabled when the live fetch returns nothing and no cached config exists', async () => {
      const sendAdminCommand = vi.fn().mockResolvedValue(undefined);
      const getSessionPasskey = vi.fn().mockReturnValue(new Uint8Array([1, 2, 3, 4]));
      const requestRemoteConfig = vi.fn().mockResolvedValue(null);
      const getRemoteNodeConfig = vi.fn().mockReturnValue(null);
      await sourceManagerRegistry.addManager(makeFakeManager({ sendAdminCommand, getSessionPasskey, requestRemoteConfig, getRemoteNodeConfig }));

      const spy = vi.spyOn(protobufService, 'createSetLoRaConfigMessage');
      const channelUrlService = (await import('../services/channelUrlService.js')).default;
      (channelUrlService.decodeUrl as any).mockReturnValue({
        channels: undefined,
        loraConfig: { hopLimit: 3, txEnabled: false },
      });

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/import-config').send({
        sourceId: harness.sourceA,
        nodeNum: 999,
        url: 'meshtastic://mock',
      });

      expect(res.status).toBe(202); // remote import is now async (#4482)
      // The send happens in the background now — wait for it.
      await vi.waitFor(() => expect(spy).toHaveBeenCalledWith(expect.objectContaining({ hopLimit: 3, txEnabled: false }), expect.anything()));
      spy.mockRestore();
    });

    it('falls back to true (fail-open) when the live fetch, cached config, and decoded txEnabled are all absent', async () => {
      const sendAdminCommand = vi.fn().mockResolvedValue(undefined);
      const getSessionPasskey = vi.fn().mockReturnValue(new Uint8Array([1, 2, 3, 4]));
      const requestRemoteConfig = vi.fn().mockResolvedValue(null);
      const getRemoteNodeConfig = vi.fn().mockReturnValue(null);
      await sourceManagerRegistry.addManager(makeFakeManager({ sendAdminCommand, getSessionPasskey, requestRemoteConfig, getRemoteNodeConfig }));

      const spy = vi.spyOn(protobufService, 'createSetLoRaConfigMessage');
      const channelUrlService = (await import('../services/channelUrlService.js')).default;
      (channelUrlService.decodeUrl as any).mockReturnValue({
        channels: undefined,
        loraConfig: { hopLimit: 3 },
      });

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/import-config').send({
        sourceId: harness.sourceA,
        nodeNum: 999,
        url: 'meshtastic://mock',
      });

      expect(res.status).toBe(202); // remote import is now async (#4482)
      // The send happens in the background now — wait for it.
      await vi.waitFor(() => expect(spy).toHaveBeenCalledWith(expect.objectContaining({ hopLimit: 3, txEnabled: true }), expect.anything()));
      spy.mockRestore();
    });
  });
});

describe('adminRoutes — setSecurityConfig private key (#4632)', () => {
  let harness: RouteTestHarness;
  // A real X25519 pair, so the derived public key can be asserted exactly.
  let pair: { priv: string; pub: string };

  function makeManager(overrides: Record<string, unknown>): ISourceManager {
    return {
      sourceId: harness.sourceA,
      sourceType: 'meshtastic_tcp',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue({ sourceId: harness.sourceA, sourceName: 'A', sourceType: 'meshtastic_tcp', connected: true }),
      getLocalNodeInfo: vi.fn().mockReturnValue({ nodeNum: 1, nodeId: '!00000001', longName: 'Local', shortName: 'LOC' }),
      getSecurityKeys: vi.fn().mockReturnValue({ publicKey: 'OLDPUBLICKEYbase64AAAAAAAAAAAAAAAAAAAAAAAAA=', privateKey: 'OLDPRIVATEKEYbase64AAAAAAAAAAAAAAAAAAAAAAAA=' }),
      getSessionPasskey: vi.fn().mockReturnValue(new Uint8Array([1, 2, 3, 4])),
      getSessionPasskeyStatus: vi.fn().mockReturnValue({ hasPasskey: true }),
      sendAdminCommand: vi.fn().mockResolvedValue(undefined),
      sendAdminCommandAwaitAck: vi.fn().mockResolvedValue({ acked: true, timedOut: false }),
      updateCachedDeviceConfig: vi.fn(),
      startDistanceDeleteScheduler: vi.fn().mockResolvedValue(undefined),
      stopDistanceDeleteScheduler: vi.fn(),
      isTxEnabled: vi.fn().mockReturnValue(true),
      ...overrides,
    } as unknown as ISourceManager;
  }

  beforeEach(async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const kp = generateKeyPairSync('x25519');
    pair = {
      priv: kp.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('base64'),
      pub: kp.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'),
    };
    harness = await createRouteTestApp({ mount: (app) => app.use('/', adminRoutes) });
    vi.spyOn(protobufService, 'createSetSecurityConfigMessage').mockReturnValue(new Uint8Array([0]));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await sourceManagerRegistry.removeManager(harness.sourceA);
    await harness.cleanup();
  });

  it('rejects an invalid private key with 400, before touching the device', async () => {
    const sendAdminCommand = vi.fn().mockResolvedValue(undefined);
    await sourceManagerRegistry.addManager(makeManager({ sendAdminCommand }));
    const agent = await harness.loginAs(harness.admin);

    const res = await agent.post('/commands').send({
      command: 'setSecurityConfig',
      sourceId: harness.sourceA,
      nodeNum: 1,
      config: { isManaged: false, serialEnabled: true, debugLogApiEnabled: false, adminChannelEnabled: false, privateKey: 'not-a-valid-key' },
    });

    expect(res.status).toBe(400);
    expect(sendAdminCommand).not.toHaveBeenCalled();
    expect(protobufService.createSetSecurityConfigMessage).not.toHaveBeenCalled();
  });

  it('refuses a private key aimed at a remote node with 400', async () => {
    await sourceManagerRegistry.addManager(makeManager({}));
    const agent = await harness.loginAs(harness.admin);

    const res = await agent.post('/commands').send({
      command: 'setSecurityConfig',
      sourceId: harness.sourceA,
      nodeNum: 999, // not the local node (1)
      config: { isManaged: false, serialEnabled: true, debugLogApiEnabled: false, adminChannelEnabled: false, privateKey: pair.priv },
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/local node/i);
  });

  it('sends the new private key with its DERIVED public key, not the stale one', async () => {
    await sourceManagerRegistry.addManager(makeManager({}));
    const agent = await harness.loginAs(harness.admin);

    const res = await agent.post('/commands').send({
      command: 'setSecurityConfig',
      sourceId: harness.sourceA,
      nodeNum: 1, // local node
      config: { isManaged: false, serialEnabled: true, debugLogApiEnabled: false, adminChannelEnabled: false, privateKey: pair.priv },
    });

    expect(res.status).toBe(200);
    const sentConfig = (protobufService.createSetSecurityConfigMessage as unknown as import('vitest').Mock).mock.calls[0][0];
    expect(sentConfig.privateKey).toBe(pair.priv);
    // The matching public key, derived — never the stored OLD one.
    expect(sentConfig.publicKey).toBe(pair.pub);
    expect(sentConfig.publicKey).not.toMatch(/^OLDPUBLIC/);
  });

  it('preserves both keys unchanged when no private key is supplied', async () => {
    await sourceManagerRegistry.addManager(makeManager({}));
    const agent = await harness.loginAs(harness.admin);

    const res = await agent.post('/commands').send({
      command: 'setSecurityConfig',
      sourceId: harness.sourceA,
      nodeNum: 1,
      config: { isManaged: true, serialEnabled: true, debugLogApiEnabled: false, adminChannelEnabled: false },
    });

    expect(res.status).toBe(200);
    const sentConfig = (protobufService.createSetSecurityConfigMessage as unknown as import('vitest').Mock).mock.calls[0][0];
    expect(sentConfig.publicKey).toMatch(/^OLDPUBLIC/);
    expect(sentConfig.privateKey).toMatch(/^OLDPRIVATE/);
  });
});
