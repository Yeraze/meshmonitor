/**
 * firmwareUpdateRoutes — OTA is per-source (#5424 follow-up).
 *
 * The OTA wizard frees the node's single TCP slot, flashes it, and reconnects.
 * Before this fix every step resolved the PRIMARY Meshtastic manager, so an
 * update started from a non-primary source's Configuration page disconnected
 * the wrong node. These tests pin the route side: the request's sourceId is
 * validated and handed to the service, non-Meshtastic sources are refused, and
 * wizard actions from a different source's page are refused.
 *
 * Real `createRouteTestApp` harness (real session + real requireAdmin against
 * the in-memory DB). The source manager registry and the firmware service are
 * mocked: the registry because no radio is connected in tests, the service
 * because its steps spawn the meshtastic CLI. Service-side reconnect targeting
 * is covered in firmwareUpdateService.perSource.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import firmwareUpdateRoutes from './firmwareUpdateRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const { registry, managers, service } = vi.hoisted(() => {
  const managers = new Map<string, any>();
  const registry = {
    getManager: (id: string) => managers.get(id),
    getAllManagers: () => Array.from(managers.values()),
    getPrimaryMeshtasticSourceId: () => 'rt-source-a',
  };
  const service = {
    getStatus: vi.fn(),
    getChannel: vi.fn().mockResolvedValue('stable'),
    getCustomUrl: vi.fn().mockResolvedValue(null),
    getStagedUpload: vi.fn().mockReturnValue(null),
    findReleaseByVersion: vi.fn(),
    startPreflight: vi.fn(),
    cancelUpdate: vi.fn().mockResolvedValue(undefined),
    completeUpdate: vi.fn().mockResolvedValue(undefined),
    retryFlash: vi.fn(),
    getTempDir: vi.fn().mockReturnValue('/tmp/fw'),
    executeFlash: vi.fn().mockResolvedValue(undefined),
    isStepRunning: vi.fn().mockReturnValue(false),
    hasFlashIncompleteMarker: vi.fn().mockReturnValue(false),
    disconnectFromNode: vi.fn().mockResolvedValue(undefined),
    executeBackup: vi.fn().mockResolvedValue('/tmp/backup.yaml'),
  };
  return { registry, managers, service };
});

vi.mock('../sourceManagerRegistry.js', () => ({ sourceManagerRegistry: registry }));
vi.mock('../services/firmwareUpdateService.js', () => ({ firmwareUpdateService: service }));

const SRC_A = 'rt-source-a';
const SRC_B = 'rt-source-b';
const MQTT = 'rt-fw-mqtt';
const OFFLINE = 'rt-fw-offline';
const HOST_A = '10.0.0.1';
const HOST_B = '10.0.0.2';

const IDLE = { state: 'idle', step: null, message: '', logs: [] };

function fakeMeshtastic() {
  return { sourceType: 'meshtastic_tcp', isLocalNodeBridged: vi.fn().mockReturnValue(false) };
}

function updateBody(extra: Record<string, unknown> = {}) {
  return {
    targetVersion: '2.7.20',
    gatewayIp: HOST_B,
    hwModel: 43,
    currentVersion: '2.7.19',
    ...extra,
  };
}

describe('firmwareUpdateRoutes — per-source OTA (#5424 follow-up)', () => {
  let harness: RouteTestHarness;
  let mgrA: ReturnType<typeof fakeMeshtastic>;
  let mgrB: ReturnType<typeof fakeMeshtastic>;

  beforeEach(async () => {
    vi.clearAllMocks();
    harness = await createRouteTestApp({
      mount: (app) => app.use('/api/firmware', firmwareUpdateRoutes),
    });
    await harness.db.sources.updateSource(SRC_A, { config: { host: HOST_A, port: 4403 } });
    await harness.db.sources.updateSource(SRC_B, { config: { host: HOST_B, port: 4403 } });
    await harness.db.sources.deleteSource(MQTT).catch(() => {});
    await harness.db.sources.deleteSource(OFFLINE).catch(() => {});
    await harness.db.sources.createSource({ id: MQTT, name: 'Broker', type: 'mqtt_broker', config: {}, enabled: true });
    await harness.db.sources.createSource({
      id: OFFLINE, name: 'Offline', type: 'meshtastic_tcp', config: { host: '10.0.0.9' }, enabled: true,
    });

    mgrA = fakeMeshtastic();
    mgrB = fakeMeshtastic();
    managers.clear();
    managers.set(SRC_A, mgrA);
    managers.set(SRC_B, mgrB);
    managers.set(MQTT, { sourceType: 'mqtt_broker' });

    service.getStatus.mockReturnValue(IDLE);
    service.findReleaseByVersion.mockReturnValue({ version: '2.7.20', tagName: 'v2.7.20', assets: [] });
  });

  afterEach(async () => {
    await harness.db.sources.deleteSource(MQTT).catch(() => {});
    await harness.db.sources.deleteSource(OFFLINE).catch(() => {});
    await harness.cleanup();
  });

  describe('POST /update', () => {
    it("starts the update against source B's manager and records sourceId B", async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/api/firmware/update').send(updateBody({ sourceId: SRC_B }));

      expect(res.status).toBe(200);
      expect(service.startPreflight).toHaveBeenCalledWith(
        expect.objectContaining({ sourceId: SRC_B, gatewayIp: HOST_B }),
      );
      // The bridged-node guard read B's device, never the primary's.
      expect(mgrB.isLocalNodeBridged).toHaveBeenCalled();
      expect(mgrA.isLocalNodeBridged).not.toHaveBeenCalled();
    });

    it('refuses a missing sourceId when more than one Meshtastic source exists', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/api/firmware/update').send(updateBody());

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SOURCE_ID_REQUIRED');
      expect(service.startPreflight).not.toHaveBeenCalled();
    });

    it('accepts a missing sourceId on a single-source install (legacy fallback to the primary)', async () => {
      managers.delete(SRC_B);
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/api/firmware/update').send(updateBody({ gatewayIp: HOST_A }));

      expect(res.status).toBe(200);
      expect(mgrA.isLocalNodeBridged).toHaveBeenCalled();
      expect(service.startPreflight).toHaveBeenCalledWith(expect.objectContaining({ sourceId: undefined }));
    });

    it('refuses an unknown sourceId', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/api/firmware/update').send(updateBody({ sourceId: 'no-such-source' }));

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('SOURCE_NOT_FOUND');
      expect(service.startPreflight).not.toHaveBeenCalled();
    });

    it('refuses a non-Meshtastic (MQTT) source', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/api/firmware/update').send(updateBody({ sourceId: MQTT }));

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SOURCE_NOT_MESHTASTIC');
      expect(service.startPreflight).not.toHaveBeenCalled();
    });

    it('refuses a Meshtastic TCP source that is not connected', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/api/firmware/update').send(updateBody({ sourceId: OFFLINE, gatewayIp: '10.0.0.9' }));

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SOURCE_NOT_CONNECTED');
      expect(service.startPreflight).not.toHaveBeenCalled();
    });

    it("refuses a gateway that is not the source's own node", async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/api/firmware/update').send(updateBody({ sourceId: SRC_B, gatewayIp: HOST_A }));

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('OTA_GATEWAY_MISMATCH');
      expect(service.startPreflight).not.toHaveBeenCalled();
    });

    it('refuses while another source has an update running, and names that source', async () => {
      service.getStatus.mockReturnValue({ state: 'awaiting-confirm', step: 'backup', message: '', logs: [], sourceId: SRC_A });
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/api/firmware/update').send(updateBody({ sourceId: SRC_B }));

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('OTA_IN_PROGRESS');
      expect(res.body.activeSourceId).toBe(SRC_A);
      expect(res.body.error).toContain('Source A');
      expect(service.startPreflight).not.toHaveBeenCalled();
    });

    it('stays admin-only', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/api/firmware/update').send(updateBody({ sourceId: SRC_B }));

      expect(res.status).toBe(403);
      expect(service.startPreflight).not.toHaveBeenCalled();
    });
  });

  describe('wizard actions on a running update', () => {
    const runningOnB = {
      state: 'error', step: 'flash', message: '', logs: [], sourceId: SRC_B,
      matchedFile: 'firmware.bin',
      preflightInfo: { gatewayIp: HOST_B, currentVersion: '2.7.19', targetVersion: '2.7.20', hwModel: 'x', boardName: 'x', platform: 'esp32s3' },
    };

    beforeEach(() => {
      service.getStatus.mockReturnValue(runningOnB);
    });

    it.each([
      ['/update/cancel', () => service.cancelUpdate],
      ['/update/done', () => service.completeUpdate],
      ['/update/retry', () => service.retryFlash],
    ])('%s from another source is refused with OTA_SOURCE_MISMATCH', async (path, fn) => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post(`/api/firmware${path}`).send({ sourceId: SRC_A });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('OTA_SOURCE_MISMATCH');
      expect(res.body.activeSourceId).toBe(SRC_B);
      expect(fn()).not.toHaveBeenCalled();
    });

    it.each([
      ['/update/cancel', () => service.cancelUpdate],
      ['/update/done', () => service.completeUpdate],
      ['/update/retry', () => service.retryFlash],
    ])('%s from the owning source reaches the service', async (path, fn) => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post(`/api/firmware${path}`).send({ sourceId: SRC_B });

      expect(res.status).toBe(200);
      expect(fn()).toHaveBeenCalled();
    });

    it('/update/confirm from another source is refused', async () => {
      service.getStatus.mockReturnValue({ ...runningOnB, state: 'awaiting-confirm', step: 'preflight' });
      const agent = await harness.loginAs(harness.admin);
      const res = await agent
        .post('/api/firmware/update/confirm')
        .send({ sourceId: SRC_A, gatewayIp: HOST_B, nodeId: '!abcd' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('OTA_SOURCE_MISMATCH');
      expect(service.disconnectFromNode).not.toHaveBeenCalled();
    });
  });
});
