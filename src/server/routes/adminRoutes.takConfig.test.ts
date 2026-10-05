/**
 * TAK team + role through the admin routes (#5613): `/commands setTAKConfig`
 * and `/load-config` with `configType: 'tak'`, for local and remote nodes.
 *
 * Runs the real encoder and reads the bytes handed to `sendAdminCommand`.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import protobuf from 'protobufjs';
import adminRoutes from './adminRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';
import { loadProtobufDefinitions, getProtobufRoot } from '../protobufLoader.js';

const LOCAL = 1;
const REMOTE = 999;
const TAK_FIELD = 16;
const TAK_CONFIG_ADMIN_TYPE = 15;
const RED = 5;
const TEAM_LEAD = 2;
const PASSKEY = new Uint8Array([1, 2, 3, 4]);

function wireFields(buf: Uint8Array): Map<number, Uint8Array | number> {
  const reader = protobuf.Reader.create(buf);
  const out = new Map<number, Uint8Array | number>();
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    out.set(tag >>> 3, (tag & 7) === 2 ? reader.bytes() : reader.uint32());
  }
  return out;
}

/** team / role (and whether a passkey rode along) from an encoded admin packet. */
function sentTak(adminMessage: Uint8Array) {
  const AdminMessage = getProtobufRoot()!.lookupType('meshtastic.AdminMessage');
  const top = wireFields(adminMessage);
  const moduleConfig = wireFields(top.get(AdminMessage.fields.setModuleConfig.id) as Uint8Array);
  expect([...moduleConfig.keys()]).toEqual([TAK_FIELD]);
  const tak = wireFields(moduleConfig.get(TAK_FIELD) as Uint8Array);
  return {
    team: tak.get(1) ?? 0,
    role: tak.get(2) ?? 0,
    fieldCount: tak.size,
    hasPasskey: top.has(AdminMessage.fields.sessionPasskey.id),
  };
}

describe('adminRoutes — TAK config', () => {
  let harness: RouteTestHarness;
  let sendAdminCommand: ReturnType<typeof vi.fn>;

  function makeManager(overrides: Record<string, unknown> = {}): ISourceManager {
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
      startDistanceDeleteScheduler: vi.fn().mockResolvedValue(undefined),
      stopDistanceDeleteScheduler: vi.fn(),
      isTxEnabled: vi.fn().mockReturnValue(true),
      supportsTakConfig: vi.fn().mockReturnValue(true),
      ...overrides,
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

  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', adminRoutes) });
    sendAdminCommand = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await sourceManagerRegistry.removeManager(harness.sourceA);
    await harness.cleanup();
  });

  describe('POST /commands setTAKConfig', () => {
    async function save(nodeNum: number, config?: unknown) {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent
        .post('/commands')
        .send({ command: 'setTAKConfig', sourceId: harness.sourceA, nodeNum, ...(config !== undefined ? { config } : {}) });
      return { agent, res };
    }

    beforeEach(async () => {
      await sourceManagerRegistry.addManager(makeManager());
    });

    it('local node: sends one set_module_config with team and role', async () => {
      const { res } = await save(LOCAL, { team: RED, role: TEAM_LEAD });

      expect(res.status).toBe(200);
      expect(sendAdminCommand).toHaveBeenCalledTimes(1);
      expect(sendAdminCommand.mock.calls[0][1]).toBe(LOCAL);
      expect(sentTak(sendAdminCommand.mock.calls[0][0])).toEqual({
        team: RED, role: TEAM_LEAD, fieldCount: 2, hasPasskey: false,
      });
    });

    it('sends only team and role: extra keys never reach the encoder', async () => {
      await save(LOCAL, { team: RED, role: TEAM_LEAD, enabled: true, junk: 'x' });
      expect(sentTak(sendAdminCommand.mock.calls[0][0]).fieldCount).toBe(2);
    });

    it('accepts proto enum names and sends their numbers', async () => {
      await save(LOCAL, { team: 'Red', role: 'TeamLead' });
      expect(sentTak(sendAdminCommand.mock.calls[0][0])).toMatchObject({ team: RED, role: TEAM_LEAD });
    });

    it('resetting to defaults still sends the (empty) tak variant', async () => {
      const { res } = await save(LOCAL, { team: 0, role: 0 });
      expect(res.status).toBe(200);
      expect(sentTak(sendAdminCommand.mock.calls[0][0])).toMatchObject({ team: 0, role: 0, fieldCount: 0 });
    });

    it('remote node: one packet, with the session passkey', async () => {
      const { agent, res } = await save(REMOTE, { team: RED, role: TEAM_LEAD });

      expect(res.status).toBe(202);
      const op = await waitForSettled(agent, res.body.operationId);
      expect(op.status).toBe('succeeded');
      expect(sendAdminCommand).toHaveBeenCalledTimes(1);
      expect(sendAdminCommand.mock.calls[0][1]).toBe(REMOTE);
      expect(sentTak(sendAdminCommand.mock.calls[0][0])).toEqual({
        team: RED, role: TEAM_LEAD, fieldCount: 2, hasPasskey: true,
      });
    });

    it.each([
      [{ team: 15, role: 0 }],
      [{ team: 0, role: 9 }],
      [{ team: 'Chartreuse' }],
      [{ role: 'ROUTER' }],
    ])('refuses %j with INVALID_TAK_CONFIG and sends nothing', async (config) => {
      const { res } = await save(LOCAL, config);

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ success: false, code: 'INVALID_TAK_CONFIG' });
      expect(sendAdminCommand).not.toHaveBeenCalled();
    });

    it('refuses a missing config', async () => {
      const { res } = await save(LOCAL);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ success: false, code: 'MISSING_CONFIG' });
      expect(sendAdminCommand).not.toHaveBeenCalled();
    });

    it('is admin only', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent
        .post('/commands')
        .send({ command: 'setTAKConfig', sourceId: harness.sourceA, nodeNum: LOCAL, config: { team: RED, role: TEAM_LEAD } });

      expect(res.status).toBe(403);
      expect(sendAdminCommand).not.toHaveBeenCalled();
    });
  });

  describe('POST /load-config configType=tak', () => {
    async function load(nodeNum: number) {
      const agent = await harness.loginAs(harness.admin);
      return agent.post('/load-config').send({ configType: 'tak', sourceId: harness.sourceA, nodeNum });
    }

    it('local node: answers with numbers', async () => {
      await sourceManagerRegistry.addManager(makeManager({
        getCurrentConfig: vi.fn().mockReturnValue({ deviceConfig: {}, moduleConfig: { tak: { team: RED, role: TEAM_LEAD } } }),
      }));

      const res = await load(LOCAL);
      expect(res.status).toBe(200);
      expect(res.body.config).toEqual({ team: RED, role: TEAM_LEAD });
    });

    it('local node: enum names in the cached config come back as numbers', async () => {
      await sourceManagerRegistry.addManager(makeManager({
        getCurrentConfig: vi.fn().mockReturnValue({ deviceConfig: {}, moduleConfig: { tak: { team: 'Red', role: 'TeamLead' } } }),
      }));

      const res = await load(LOCAL);
      expect(res.body.config).toEqual({ team: RED, role: TEAM_LEAD });
    });

    it('local node: an all-default section answers 0 / 0, not { enabled: false }', async () => {
      const requestModuleConfig = vi.fn().mockResolvedValue(undefined);
      await sourceManagerRegistry.addManager(makeManager({
        // An empty object is what the manager stores for an all-default reply.
        getCurrentConfig: vi.fn().mockReturnValue({ deviceConfig: {}, moduleConfig: { tak: {} } }),
        requestModuleConfig,
      }));

      const res = await load(LOCAL);
      expect(res.status).toBe(200);
      expect(res.body.config).toEqual({ team: 0, role: 0 });
      expect(requestModuleConfig).not.toHaveBeenCalled();
    });

    it('local node: asks the device with module type 15 when nothing is cached', async () => {
      const requestModuleConfig = vi.fn().mockResolvedValue(undefined);
      await sourceManagerRegistry.addManager(makeManager({
        getCurrentConfig: vi.fn().mockReturnValue({ deviceConfig: {}, moduleConfig: {} }),
        requestModuleConfig,
      }));

      const res = await load(LOCAL);
      expect(requestModuleConfig).toHaveBeenCalledWith(TAK_CONFIG_ADMIN_TYPE);
      expect(res.status).toBe(200);
      expect(res.body.config).toEqual({ team: 0, role: 0 });
    });

    it('local node on firmware older than 2.8.0: 404 TAK_CONFIG_UNSUPPORTED, not fake defaults', async () => {
      await sourceManagerRegistry.addManager(makeManager({
        getCurrentConfig: vi.fn().mockReturnValue({ deviceConfig: {}, moduleConfig: { tak: {} } }),
        supportsTakConfig: vi.fn().mockReturnValue(false),
      }));

      const res = await load(LOCAL);
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ success: false, code: 'TAK_CONFIG_UNSUPPORTED' });
    });

    it('remote node: requests module type 15 and answers with numbers', async () => {
      const requestRemoteConfig = vi.fn().mockResolvedValue({ team: RED, role: TEAM_LEAD });
      await sourceManagerRegistry.addManager(makeManager({ requestRemoteConfig }));

      const res = await load(REMOTE);
      expect(requestRemoteConfig).toHaveBeenCalledWith(REMOTE, TAK_CONFIG_ADMIN_TYPE, true);
      expect(res.status).toBe(200);
      expect(res.body.config).toEqual({ team: RED, role: TEAM_LEAD });
    });

    it('remote node: an all-default reply (empty object) answers 0 / 0', async () => {
      const requestRemoteConfig = vi.fn().mockResolvedValue({});
      await sourceManagerRegistry.addManager(makeManager({ requestRemoteConfig }));

      const res = await load(REMOTE);
      expect(res.status).toBe(200);
      expect(res.body.config).toEqual({ team: 0, role: 0 });
    });

    it('remote node: no reply is a 404, so the UI marks the section unsupported', async () => {
      const requestRemoteConfig = vi.fn().mockResolvedValue(null);
      await sourceManagerRegistry.addManager(makeManager({ requestRemoteConfig }));

      const res = await load(REMOTE);
      expect(res.status).toBe(404);
    });
  });
});
