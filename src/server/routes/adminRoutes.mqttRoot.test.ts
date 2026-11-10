/**
 * `/commands setMQTTConfig`: the server refuses a bad MQTT root, but only when
 * it changes (#6338), for the local node and a remote one. The previous root
 * comes from this source's cache of the target node; an unknown one counts as
 * a change. A refused save sends no admin packet.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import adminRoutes from './adminRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';
import { loadProtobufDefinitions } from '../protobufLoader.js';

const LOCAL = 1;
const REMOTE = 999;
const PASSKEY = new Uint8Array([1, 2, 3, 4]);

describe('adminRoutes: setMQTTConfig root check', () => {
  let harness: RouteTestHarness;
  let sendAdminCommand: ReturnType<typeof vi.fn>;
  let getActualModuleConfig: ReturnType<typeof vi.fn>;
  let getRemoteNodeConfig: ReturnType<typeof vi.fn>;

  function makeManager(): ISourceManager {
    return {
      sourceId: harness.sourceA,
      sourceType: 'meshtastic_tcp',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue({ sourceId: harness.sourceA, sourceName: 'A', sourceType: 'meshtastic_tcp', connected: true }),
      getLocalNodeInfo: vi.fn().mockReturnValue({ nodeNum: LOCAL, nodeId: '!00000001', longName: 'Local', shortName: 'LOC' }),
      getSessionPasskey: vi.fn().mockReturnValue(PASSKEY),
      getSessionPasskeyStatus: vi.fn().mockReturnValue({ hasPasskey: true }),
      requestRemoteSessionPasskey: vi.fn().mockResolvedValue(PASSKEY),
      sendAdminCommand,
      sendAdminCommandAwaitAck: vi.fn().mockResolvedValue({ acked: true, timedOut: false }),
      updateCachedDeviceConfig: vi.fn(),
      updateCachedModuleConfig: vi.fn(),
      getActualModuleConfig,
      getRemoteNodeConfig,
      startDistanceDeleteScheduler: vi.fn().mockResolvedValue(undefined),
      stopDistanceDeleteScheduler: vi.fn(),
      isTxEnabled: vi.fn().mockReturnValue(true),
    } as unknown as ISourceManager;
  }

  async function waitForSettled(agent: any, operationId: string, attempts = 80) {
    const { isTerminal } = await import('../services/adminOperationService.js');
    for (let i = 0; i < attempts; i++) {
      const res = await agent.get(`/operations/${operationId}`);
      const op = res.body?.data;
      if (op && isTerminal(op.status)) return op;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`operation ${operationId} never settled`);
  }

  async function send(nodeNum: number, config: Record<string, unknown>) {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/commands').send({ command: 'setMQTTConfig', sourceId: harness.sourceA, nodeNum, config });
    const operationId = res.body?.data?.operationId ?? res.body?.operationId;
    if (res.status === 202 && operationId) await waitForSettled(agent, operationId);
    return res;
  }

  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', adminRoutes) });
    sendAdminCommand = vi.fn().mockResolvedValue(undefined);
    getActualModuleConfig = vi.fn().mockReturnValue({ mqtt: { root: 'msh/US' } });
    getRemoteNodeConfig = vi.fn().mockReturnValue({ deviceConfig: {}, moduleConfig: { mqtt: { root: 'msh/EU' } }, lastUpdated: Date.now() });
    await sourceManagerRegistry.addManager(makeManager());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await sourceManagerRegistry.removeManager(harness.sourceA);
    await harness.cleanup();
  });

  describe.each([
    ['local', LOCAL],
    ['remote', REMOTE],
  ])('%s node', (_label, nodeNum) => {
    it.each([
      ['msh /US', 'WHITESPACE'],
      ['msh​', 'INVISIBLE'],
      ['msh/+', 'WILDCARD'],
      ['msh/US/', 'SLASH'],
      ['msh/US/2', 'ENDS_WITH_2'],
      ['a'.repeat(32), 'TOO_LONG'],
    ])('refuses %j (%s) and sends nothing', async (root, reason) => {
      const res = await send(nodeNum, { enabled: true, root });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ success: false, code: 'INVALID_MQTT_ROOT', field: 'root', reason });
      expect(sendAdminCommand).not.toHaveBeenCalled();
    });

    it.each(['', 'msh/US/FL'])('sends %j', async (root) => {
      const res = await send(nodeNum, { enabled: true, root });
      expect([200, 202]).toContain(res.status);
      expect(sendAdminCommand).toHaveBeenCalled();
    });

    it('lets an unrelated edit resend a bad root the node already holds', async () => {
      getActualModuleConfig.mockReturnValue({ mqtt: { root: 'msh/US ' } });
      getRemoteNodeConfig.mockReturnValue({ deviceConfig: {}, moduleConfig: { mqtt: { root: 'msh/US ' } }, lastUpdated: Date.now() });
      const res = await send(nodeNum, { root: 'msh/US ', mapReportingEnabled: true });
      expect([200, 202]).toContain(res.status);
      expect(sendAdminCommand).toHaveBeenCalled();
    });

    it('checks the root when the node config is not cached', async () => {
      getActualModuleConfig.mockReturnValue(null);
      getRemoteNodeConfig.mockReturnValue(null);
      const res = await send(nodeNum, { root: 'msh/#' });
      expect(res.status).toBe(400);
      expect(res.body.reason).toBe('WILDCARD');
      expect(sendAdminCommand).not.toHaveBeenCalled();
    });
  });

  it("compares a remote node's root with that node's cache, not the local node's", async () => {
    // The local node holds the bad root; the remote node does not.
    getActualModuleConfig.mockReturnValue({ mqtt: { root: 'msh/US ' } });
    const res = await send(REMOTE, { root: 'msh/US ' });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('WHITESPACE');
    expect(getRemoteNodeConfig).toHaveBeenCalledWith(REMOTE);
  });
});
