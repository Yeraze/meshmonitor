/**
 * Verified remote config saves (#4487): `/commands` with `verify: true`, plus
 * the job list / cancel routes.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import adminRoutes from './adminRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';
import { adminVerifyJobService, MAX_RUNNING_PER_SOURCE } from '../services/adminVerifyJobService.js';
import { loadProtobufDefinitions } from '../protobufLoader.js';

const LOCAL_NODE_NUM = 1;
const REMOTE_NODE_NUM = 0x0badbeef;

describe('adminRoutes — verified saves (#4487)', () => {
  let harness: RouteTestHarness;
  let sendAdminCommand: ReturnType<typeof vi.fn>;

  function addManager(remoteConfig: unknown) {
    sendAdminCommand = vi.fn().mockResolvedValue(undefined);
    return sourceManagerRegistry.addManager({
      sourceId: harness.sourceA,
      sourceType: 'meshtastic_tcp',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue({ sourceId: harness.sourceA, sourceName: 'A', sourceType: 'meshtastic_tcp', connected: true }),
      getLocalNodeInfo: vi.fn().mockReturnValue({ nodeNum: LOCAL_NODE_NUM, nodeId: '!00000001' }),
      startDistanceDeleteScheduler: vi.fn().mockResolvedValue(undefined),
      stopDistanceDeleteScheduler: vi.fn(),
      isTxEnabled: vi.fn().mockReturnValue(true),
      getSessionPasskey: vi.fn().mockReturnValue(new Uint8Array([1, 2, 3])),
      sendAdminCommand,
      getRemoteNodeConfig: vi.fn().mockReturnValue(remoteConfig),
      requestRemoteConfig: vi.fn().mockResolvedValue(null),
    } as unknown as ISourceManager);
  }

  const neighborSave = (nodeNum = REMOTE_NODE_NUM) => ({
    command: 'setNeighborInfoConfig',
    nodeNum,
    sourceId: harness.sourceA,
    config: { enabled: true, updateInterval: 21600 },
    verify: true,
  });

  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', adminRoutes) });
    adminVerifyJobService.clear();
  });

  afterEach(async () => {
    adminVerifyJobService.clear();
    await sourceManagerRegistry.removeManager(harness.sourceA);
    await harness.cleanup();
  });

  it('starts a job, sends once, and lists it', async () => {
    await addManager({ deviceConfig: {}, moduleConfig: { neighborInfo: { enabled: false, updateInterval: 0 } } });
    const agent = await harness.loginAs(harness.admin);

    const res = await agent.post('/commands').send(neighborSave());
    expect(res.status).toBe(202);
    expect(typeof res.body.verifyJobId).toBe('string');
    await vi.waitFor(() => expect(sendAdminCommand).toHaveBeenCalledTimes(1));

    const list = await agent.get('/verify-jobs');
    expect(list.status).toBe(200);
    expect(list.body.data[0]).toMatchObject({
      id: res.body.verifyJobId,
      section: 'neighborInfo',
      destinationNodeNum: REMOTE_NODE_NUM,
      status: 'waiting',
      sends: 1,
    });

    const cancel = await agent.post(`/verify-jobs/${res.body.verifyJobId}/cancel`);
    expect(cancel.body.data.status).toBe('cancelled');
  });

  it('refuses a save with no loaded baseline', async () => {
    await addManager(null);
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/commands').send(neighborSave());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('VERIFY_NEEDS_BASELINE');
    expect(sendAdminCommand).not.toHaveBeenCalled();
  });

  it('refuses commands that cannot be read back', async () => {
    await addManager({ deviceConfig: {}, moduleConfig: {} });
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/commands').send({
      command: 'reboot', nodeNum: REMOTE_NODE_NUM, sourceId: harness.sourceA, verify: true,
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VERIFY_UNSUPPORTED');
    expect(sendAdminCommand).not.toHaveBeenCalled();
  });

  it(`returns 429 past ${MAX_RUNNING_PER_SOURCE} running jobs on a source`, async () => {
    await addManager({ deviceConfig: {}, moduleConfig: { neighborInfo: { enabled: false } } });
    const agent = await harness.loginAs(harness.admin);
    for (let i = 0; i < MAX_RUNNING_PER_SOURCE; i++) {
      expect((await agent.post('/commands').send(neighborSave(REMOTE_NODE_NUM + i + 1))).status).toBe(202);
    }
    const res = await agent.post('/commands').send(neighborSave(REMOTE_NODE_NUM + 99));
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('VERIFY_JOB_LIMIT');
  });

  it('is admin-only', async () => {
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.get('/verify-jobs')).status).toBe(403);
  });
});
