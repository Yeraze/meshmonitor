/**
 * `/commands setPositionConfig` and `setDeviceConfig`: the two broadcast
 * intervals, for the local node and a remote one.
 *
 * Runs the real encoder and reads the bytes handed to `sendAdminCommand`. A
 * stored 0 must go out as 0 (proto3 leaves a 0 scalar off the wire, and the
 * firmware's whole-struct replace then stores 0), with every other field of
 * the section still on the wire. Any other value under the floor is refused.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import protobuf from 'protobufjs';
import adminRoutes from './adminRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';
import { loadProtobufDefinitions, getProtobufRoot } from '../protobufLoader.js';

const LOCAL = 1;
const REMOTE = 999;
const PASSKEY = new Uint8Array([1, 2, 3, 4]);

/** Field numbers present on the wire in an encoded message. */
function wireFieldNumbers(buf: Uint8Array): number[] {
  const reader = protobuf.Reader.create(buf);
  const out: number[] = [];
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    out.push(tag >>> 3);
    reader.skipType(tag & 7);
  }
  return out;
}

/** The decoded Config section of a set_config admin message, and its raw field numbers. */
function sentSection(adminMessage: Uint8Array, section: 'position' | 'device') {
  const root = getProtobufRoot()!;
  const AdminMessage = root.lookupType('meshtastic.AdminMessage');
  const Config = root.lookupType('meshtastic.Config');
  const decoded = AdminMessage.decode(adminMessage) as unknown as { setConfig: Record<string, Record<string, unknown>> };
  const sectionType = root.lookupType(section === 'position' ? 'meshtastic.Config.PositionConfig' : 'meshtastic.Config.DeviceConfig');
  const sectionBytes = sectionType.encode(decoded.setConfig[section] as protobuf.Message).finish();
  return {
    values: decoded.setConfig[section],
    onWire: wireFieldNumbers(sectionBytes),
    fields: sectionType.fields,
    configField: Config.fields[section].id,
  };
}

describe('adminRoutes: broadcast interval floors', () => {
  let harness: RouteTestHarness;
  let sendAdminCommand: ReturnType<typeof vi.fn>;

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

  /** Send a command; for a remote node wait until the queued operation has run. */
  async function send(command: string, nodeNum: number, config: Record<string, unknown>) {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/commands').send({ command, sourceId: harness.sourceA, nodeNum, config });
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
    await sourceManagerRegistry.addManager(makeManager());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await sourceManagerRegistry.removeManager(harness.sourceA);
    await harness.cleanup();
  });

  const positionSection = {
    positionBroadcastSmartEnabled: true,
    gpsUpdateInterval: 120,
    positionFlags: 811,
    broadcastSmartMinimumDistance: 100,
    broadcastSmartMinimumIntervalSecs: 300,
    gpsMode: 1,
  };

  describe.each([
    ['local', LOCAL],
    ['remote', REMOTE],
  ])('setPositionConfig on the %s node', (_name, nodeNum) => {
    it('sends a stored 0 as 0 and keeps every other field on the wire', async () => {
      const res = await send('setPositionConfig', nodeNum, { ...positionSection, positionBroadcastSecs: 0 });

      expect(res.status).toBeLessThan(300);
      expect(sendAdminCommand).toHaveBeenCalledTimes(1);
      expect(sendAdminCommand.mock.calls[0][1]).toBe(nodeNum);
      const sent = sentSection(sendAdminCommand.mock.calls[0][0], 'position');
      expect(sent.values.positionBroadcastSecs).toBe(0);
      // proto3: the 0 is not on the wire, so the firmware's struct holds 0.
      expect(sent.onWire).not.toContain(sent.fields.positionBroadcastSecs.id);
      expect(sent.values).toMatchObject(positionSection);
      for (const key of Object.keys(positionSection)) {
        expect(sent.onWire, `${key} is on the wire`).toContain(sent.fields[key].id);
      }
    });

    it('sends an in-range value as typed', async () => {
      await send('setPositionConfig', nodeNum, { ...positionSection, positionBroadcastSecs: 600 });

      expect(sendAdminCommand).toHaveBeenCalledTimes(1);
      const sent = sentSection(sendAdminCommand.mock.calls[0][0], 'position');
      expect(sent.values.positionBroadcastSecs).toBe(600);
      expect(sent.onWire).toContain(sent.fields.positionBroadcastSecs.id);
    });

    it.each([1, 5, 31])('refuses %i and sends nothing', async (secs) => {
      const res = await send('setPositionConfig', nodeNum, { ...positionSection, positionBroadcastSecs: secs });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ success: false, code: 'POSITION_INTERVAL_BELOW_FLOOR' });
      expect(sendAdminCommand).not.toHaveBeenCalled();
    });
  });

  const deviceSection = { role: 2, rebroadcastMode: 1, tzdef: 'UTC0', ledHeartbeatDisabled: true, buzzerMode: 1 };

  describe.each([
    ['local', LOCAL],
    ['remote', REMOTE],
  ])('setDeviceConfig on the %s node', (_name, nodeNum) => {
    it('sends a stored 0 as 0 and keeps every other field on the wire', async () => {
      const res = await send('setDeviceConfig', nodeNum, { ...deviceSection, nodeInfoBroadcastSecs: 0 });

      expect(res.status).toBeLessThan(300);
      expect(sendAdminCommand).toHaveBeenCalledTimes(1);
      const sent = sentSection(sendAdminCommand.mock.calls[0][0], 'device');
      expect(sent.values.nodeInfoBroadcastSecs).toBe(0);
      expect(sent.onWire).not.toContain(sent.fields.nodeInfoBroadcastSecs.id);
      expect(sent.values).toMatchObject(deviceSection);
      for (const key of Object.keys(deviceSection)) {
        expect(sent.onWire, `${key} is on the wire`).toContain(sent.fields[key].id);
      }
    });

    it('sends an in-range value as typed', async () => {
      await send('setDeviceConfig', nodeNum, { ...deviceSection, nodeInfoBroadcastSecs: 10800 });

      const sent = sentSection(sendAdminCommand.mock.calls[0][0], 'device');
      expect(sent.values.nodeInfoBroadcastSecs).toBe(10800);
    });

    it.each([1, 900, 3599])('refuses %i and sends nothing', async (secs) => {
      const res = await send('setDeviceConfig', nodeNum, { ...deviceSection, nodeInfoBroadcastSecs: secs });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ success: false, code: 'NODE_INFO_INTERVAL_BELOW_FLOOR' });
      expect(sendAdminCommand).not.toHaveBeenCalled();
    });
  });
});
