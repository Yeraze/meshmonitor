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

  it('POST /import-config (local node) strips txEnabled from the decoded LoRa config before setLoRaConfig', async () => {
    const setLoRaConfig = vi.fn().mockResolvedValue(undefined);
    const beginEditSettings = vi.fn().mockResolvedValue(undefined);
    const commitEditSettings = vi.fn().mockResolvedValue(undefined);
    await sourceManagerRegistry.addManager(makeFakeManager({ setLoRaConfig, beginEditSettings, commitEditSettings }));

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
    expect(calledWith).not.toHaveProperty('txEnabled');
    expect(calledWith).toMatchObject({ hopLimit: 3, txPower: 20 });
  });
});
