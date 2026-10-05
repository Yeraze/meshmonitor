/**
 * One-shot device actions on `/commands` and `/reboot` (#5614, #5615):
 * DFU, shutdown, the two factory resets, and the existing reboot.
 *
 * Covered per command: admin only; DFU and the resets are refused for a remote
 * node BY THE SERVER; a remote shutdown is allowed; nothing is ever sent twice;
 * every command leaves an audit entry naming who, which node and which command.
 *
 * Runs the real encoder and reads the bytes handed to `sendAdminCommand`.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import protobuf from 'protobufjs';
import adminRoutes, { ONE_SHOT_DEVICE_ACTIONS, LOCAL_ONLY_DEVICE_ACTIONS } from './adminRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';
import databaseService from '../../services/database.js';
import { loadProtobufDefinitions } from '../protobufLoader.js';

const LOCAL = 1;
const REMOTE = 999;

const ENTER_DFU_MODE_REQUEST = 21;
const FACTORY_RESET_DEVICE = 94;
const SHUTDOWN_SECONDS = 98;
const FACTORY_RESET_CONFIG = 99;
const SESSION_PASSKEY = 101;

const PASSKEY = new Uint8Array([1, 2, 3, 4]);

/** Top-level field numbers of an encoded AdminMessage, with varint values. */
function wireFields(buf: Uint8Array): Map<number, number | Uint8Array> {
  const reader = protobuf.Reader.create(buf);
  const out = new Map<number, number | Uint8Array>();
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    out.set(tag >>> 3, (tag & 7) === 2 ? reader.bytes() : reader.int32());
  }
  return out;
}

const NEW_COMMANDS = [
  ['enterDfuMode', ENTER_DFU_MODE_REQUEST, 'admin_enter_dfu_mode'],
  ['shutdown', SHUTDOWN_SECONDS, 'admin_shutdown'],
  ['factoryResetConfig', FACTORY_RESET_CONFIG, 'admin_factory_reset_config'],
  ['factoryResetDevice', FACTORY_RESET_DEVICE, 'admin_factory_reset_device'],
] as const;

const LOCAL_ONLY = NEW_COMMANDS.filter(([command]) => command !== 'shutdown');

describe('adminRoutes — one-shot device actions', () => {
  let harness: RouteTestHarness;
  let sendAdminCommand: ReturnType<typeof vi.fn>;
  let sendAdminCommandAwaitAck: ReturnType<typeof vi.fn>;
  let sendRebootCommand: ReturnType<typeof vi.fn>;

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
      sendAdminCommandAwaitAck,
      sendRebootCommand,
      updateCachedDeviceConfig: vi.fn(),
      startDistanceDeleteScheduler: vi.fn().mockResolvedValue(undefined),
      stopDistanceDeleteScheduler: vi.fn(),
      isTxEnabled: vi.fn().mockReturnValue(true),
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

  async function post(command: string, nodeNum: number, extra: Record<string, unknown> = {}) {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/commands').send({ command, sourceId: harness.sourceA, nodeNum, ...extra });
    return { agent, res };
  }

  /** This test's audit rows for one action (users are unique per harness). */
  async function auditRows(action: string) {
    const { logs } = await databaseService.getAuditLogsAsync({ action, userId: harness.admin.id });
    return logs.map((row) => ({ ...row, parsed: JSON.parse(row.details) }));
  }

  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', adminRoutes) });
    sendAdminCommand = vi.fn().mockResolvedValue(undefined);
    sendAdminCommandAwaitAck = vi.fn().mockResolvedValue({ acked: false, timedOut: true, errorReason: null });
    sendRebootCommand = vi.fn().mockResolvedValue(undefined);
    await sourceManagerRegistry.addManager(makeManager());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await sourceManagerRegistry.removeManager(harness.sourceA);
    await harness.cleanup();
  });

  it('the one-shot and local-only sets hold exactly these commands', () => {
    expect(Object.keys(ONE_SHOT_DEVICE_ACTIONS).sort()).toEqual(
      ['enterDfuMode', 'factoryResetConfig', 'factoryResetDevice', 'reboot', 'shutdown'],
    );
    expect([...LOCAL_ONLY_DEVICE_ACTIONS].sort()).toEqual(
      ['enterDfuMode', 'factoryResetConfig', 'factoryResetDevice'],
    );
  });

  describe.each(NEW_COMMANDS)('%s', (command, field, auditAction) => {
    it('local node: sends one packet with the right field and answers in the envelope', async () => {
      const { res } = await post(command, LOCAL);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.message).toContain(command);

      expect(sendAdminCommand).toHaveBeenCalledTimes(1);
      expect(sendAdminCommandAwaitAck).not.toHaveBeenCalled();
      const [bytes, dest] = sendAdminCommand.mock.calls[0];
      expect(dest).toBe(LOCAL);
      // Local admin carries no session passkey: the command field stands alone.
      expect([...wireFields(bytes as Uint8Array).keys()]).toEqual([field]);
    });

    it('writes an audit entry: who, which node, which command', async () => {
      await post(command, LOCAL);

      const rows = await auditRows(auditAction);
      expect(rows).toHaveLength(1);
      expect(rows[0].userId ?? rows[0].user_id).toBe(harness.admin.id);
      expect(rows[0].resource).toBe('admin');
      expect(rows[0].parsed).toMatchObject({
        command,
        sourceId: harness.sourceA,
        nodeNum: LOCAL,
        nodeId: '!00000001',
        target: 'local',
      });
    });

    it('is admin only: a non-admin gets 403 and nothing is sent or audited', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/commands').send({ command, sourceId: harness.sourceA, nodeNum: LOCAL });

      expect(res.status).toBe(403);
      expect(sendAdminCommand).not.toHaveBeenCalled();
      const { logs } = await databaseService.getAuditLogsAsync({ action: auditAction, userId: harness.limited.id });
      expect(logs).toHaveLength(0);
    });

    it('is refused without a session', async () => {
      const agent = await harness.loginAs(null);
      const res = await agent.post('/commands').send({ command, sourceId: harness.sourceA, nodeNum: LOCAL });

      expect([401, 403]).toContain(res.status);
      expect(sendAdminCommand).not.toHaveBeenCalled();
    });
  });

  describe.each(LOCAL_ONLY)('%s — local node only', (command, _field, auditAction) => {
    it('the server refuses a remote target, sends nothing and audits nothing', async () => {
      const { res } = await post(command, REMOTE);

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ success: false, code: 'LOCAL_NODE_ONLY' });
      expect(sendAdminCommand).not.toHaveBeenCalled();
      expect(sendAdminCommandAwaitAck).not.toHaveBeenCalled();
      expect(await auditRows(auditAction)).toHaveLength(0);
    });
  });

  describe('shutdown', () => {
    it('defaults to a 5 second delay', async () => {
      await post('shutdown', LOCAL);
      expect(wireFields(sendAdminCommand.mock.calls[0][0]).get(SHUTDOWN_SECONDS)).toBe(5);
      expect((await auditRows('admin_shutdown'))[0].parsed.seconds).toBe(5);
    });

    it('sends the delay it is given', async () => {
      await post('shutdown', LOCAL, { seconds: 30 });
      expect(wireFields(sendAdminCommand.mock.calls[0][0]).get(SHUTDOWN_SECONDS)).toBe(30);
    });

    it.each([[-1], [1.5], ['soon']])('refuses seconds=%s (a negative value would cancel)', async (seconds) => {
      const { res } = await post('shutdown', LOCAL, { seconds });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ success: false, code: 'INVALID_SECONDS' });
      expect(sendAdminCommand).not.toHaveBeenCalled();
    });

    it('remote node: allowed, sent once with the session passkey, audited as remote', async () => {
      const { agent, res } = await post('shutdown', REMOTE);

      expect(res.status).toBe(202);
      const op = await waitForSettled(agent, res.body.operationId);
      expect(op.status).toBe('succeeded');

      expect(sendAdminCommand).toHaveBeenCalledTimes(1);
      const [bytes, dest] = sendAdminCommand.mock.calls[0];
      expect(dest).toBe(REMOTE);
      const fields = wireFields(bytes as Uint8Array);
      expect(fields.get(SHUTDOWN_SECONDS)).toBe(5);
      expect(Buffer.from(fields.get(SESSION_PASSKEY) as Uint8Array)).toEqual(Buffer.from(PASSKEY));

      const rows = await auditRows('admin_shutdown');
      expect(rows).toHaveLength(1);
      expect(rows[0].parsed).toMatchObject({ command: 'shutdown', nodeNum: REMOTE, target: 'remote' });
    });

    it('remote node: never retried, whatever retryAttempts or the setting says', async () => {
      await databaseService.settings.setSetting('adminRetryAttempts', '5');
      try {
        const { agent, res } = await post('shutdown', REMOTE, { retryAttempts: 5 });
        const op = await waitForSettled(agent, res.body.operationId);

        expect(op.status).toBe('succeeded');
        expect(op.result).toMatchObject({ attempts: 1, maxAttempts: 1 });
        expect(sendAdminCommand).toHaveBeenCalledTimes(1);
        // No ACK wait means no timeout to retry on.
        expect(sendAdminCommandAwaitAck).not.toHaveBeenCalled();
      } finally {
        await databaseService.settings.setSetting('adminRetryAttempts', '1');
      }
    });
  });

  describe('reboot (existing command, now audited)', () => {
    it('/commands reboot: keeps its bare response shape and writes an audit entry', async () => {
      const { res } = await post('reboot', LOCAL, { seconds: 7 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('reboot');
      expect(res.body.data).toBeUndefined();

      const rows = await auditRows('admin_reboot');
      expect(rows).toHaveLength(1);
      expect(rows[0].parsed).toMatchObject({ command: 'reboot', nodeNum: LOCAL, target: 'local', seconds: 7 });
    });

    it('/commands reboot to a remote node: one send, no retry, audited as remote', async () => {
      const { agent, res } = await post('reboot', REMOTE, { retryAttempts: 5 });
      const op = await waitForSettled(agent, res.body.operationId);

      expect(op.result).toMatchObject({ attempts: 1, maxAttempts: 1 });
      expect(sendAdminCommand).toHaveBeenCalledTimes(1);
      expect((await auditRows('admin_reboot'))[0].parsed).toMatchObject({ nodeNum: REMOTE, target: 'remote' });
    });

    it('POST /reboot writes an audit entry', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/reboot').send({ sourceId: harness.sourceA, nodeNum: REMOTE, seconds: 5 });

      expect(res.status).toBe(200);
      expect(sendRebootCommand).toHaveBeenCalledWith(REMOTE, 5);
      const rows = await auditRows('admin_reboot');
      expect(rows).toHaveLength(1);
      expect(rows[0].parsed).toMatchObject({ command: 'reboot', nodeNum: REMOTE, target: 'remote', seconds: 5 });
    });

    it('POST /reboot reports a failed send in the error envelope', async () => {
      sendRebootCommand.mockRejectedValueOnce(new Error('Not connected to Meshtastic node'));
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/reboot').send({ sourceId: harness.sourceA, nodeNum: LOCAL });

      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ success: false, code: 'REBOOT_FAILED' });
    });
  });
});
