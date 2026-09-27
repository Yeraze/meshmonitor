/**
 * Automation-originated send tagging (#5414) — the manager side.
 *
 * An automation send records the id actually put on the wire (the id the
 * protobuf builder stamped on the MeshPacket) against this source's local node,
 * so an MQTT bridge with `dropAutomationUplinks` can recognise the uplinked
 * copy. A manual send records nothing.
 *
 * Mocks mirror meshtasticManager.textHopLimit.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { VNConstructor } = vi.hoisted(() => ({
  VNConstructor: vi.fn(function (this: any, _opts: any) {
    this.start = vi.fn().mockResolvedValue(undefined);
    this.stop = vi.fn().mockResolvedValue(undefined);
    this.broadcastToClients = vi.fn().mockResolvedValue(undefined);
    this.isRunning = () => true;
    this.getClientCount = () => 0;
  }),
}));
vi.mock('./virtualNodeServer.js', () => ({
  VirtualNodeServer: VNConstructor,
}));

vi.mock('./tcpTransport.js', () => ({
  TcpTransport: class {
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn().mockResolvedValue(undefined);
    send = vi.fn().mockResolvedValue(undefined);
    on = vi.fn();
    off = vi.fn();
    isConnected = () => true;
    setStaleConnectionTimeout = vi.fn();
    setConnectTimeout = vi.fn();
    setReconnectTiming = vi.fn();
  },
}));

vi.mock('../services/database.js', () => {
  const shared = {
    waitForReady: vi.fn().mockResolvedValue(undefined),
    settings: {
      getSetting: vi.fn().mockResolvedValue(null),
      setSetting: vi.fn().mockResolvedValue(undefined),
      getSettingForSource: vi.fn().mockResolvedValue(null),
    },
    getAllTraceroutesForRecalculationAsync: vi.fn().mockResolvedValue([]),
    sources: { getSource: vi.fn().mockResolvedValue(null) },
    nodes: {
      getNode: vi.fn().mockResolvedValue(null),
      upsertNode: vi.fn().mockResolvedValue(undefined),
      getActiveNodes: vi.fn().mockResolvedValue([]),
      getAllNodes: vi.fn().mockResolvedValue([]),
    },
    messages: {
      insertMessage: vi.fn().mockResolvedValue(true),
    },
    messageEvents: { recordEvent: vi.fn().mockResolvedValue(undefined) },
    recordTracerouteRequestAsync: vi.fn().mockResolvedValue(undefined),
    markMessageAsReadAsync: vi.fn().mockResolvedValue(true),
  };
  return { default: shared, databaseService: shared };
});

vi.mock('./meshtasticProtobufService.js', () => {
  const svc = {
    createNodeInfo: vi.fn().mockResolvedValue(new Uint8Array()),
    createFromRadioWithPacket: vi.fn().mockResolvedValue(new Uint8Array()),
    createFromRadioTextMessage: vi.fn().mockResolvedValue(null),
    createTextMessage: vi.fn(() => ({ data: new Uint8Array([1, 2, 3]), messageId: 0x5151 })),
    createTracerouteMessage: vi.fn(() => new Uint8Array([9, 9])),
    createNodeInfoRequestMessage: vi.fn(() => ({ data: new Uint8Array([7]), packetId: 0x6161, requestId: 0x6161 })),
    getPortNumName: (n: number) => `PORT_${n}`,
    normalizePortNum: (n: any) => (typeof n === 'number' ? n : 0),
    processPayload: vi.fn(),
  };
  return { default: svc, meshtasticProtobufService: svc };
});
vi.mock('./services/packetLogService.js', () => ({
  default: { isEnabled: vi.fn().mockResolvedValue(false), logPacket: vi.fn() },
  packetLogService: { isEnabled: vi.fn().mockResolvedValue(false), logPacket: vi.fn() },
}));
vi.mock('./services/channelDecryptionService.js', () => ({
  channelDecryptionService: { isEnabled: () => false, tryDecrypt: vi.fn() },
}));
vi.mock('./services/serverEventNotificationService.js', () => ({
  serverEventNotificationService: {
    notifyNodeDisconnected: vi.fn().mockResolvedValue(undefined),
    notifyNodeConnected: vi.fn().mockResolvedValue(undefined),
  },
}));

import { MeshtasticManager } from './meshtasticManager.js';
import meshtasticProtobufService from './meshtasticProtobufService.js';
import { automationPacketTracker } from './utils/automationPacketTracker.js';

const LOCAL = 0x0badbeef;

function makeReadyManager(sourceId = 'src-1', nodeNum = LOCAL): MeshtasticManager {
  const mgr = new MeshtasticManager(sourceId, { host: '127.0.0.1', port: 4403 });
  (mgr as any).transport = { send: vi.fn().mockResolvedValue(undefined) };
  (mgr as any).isConnected = true;
  (mgr as any).localNodeInfo = {
    nodeNum,
    nodeId: `!${nodeNum.toString(16).padStart(8, '0')}`,
    longName: 'Local Node',
    shortName: 'LOCL',
  };
  return mgr;
}

const createTracerouteMessage = meshtasticProtobufService.createTracerouteMessage as unknown as ReturnType<typeof vi.fn>;

describe('MeshtasticManager automation origin tagging (#5414)', () => {
  beforeEach(() => {
    automationPacketTracker.clear();
    createTracerouteMessage.mockClear();
  });

  it('an automation text send tags the wire id against the local node', async () => {
    const mgr = makeReadyManager();
    const id = await mgr.sendTextMessage('ack', 0, undefined, undefined, undefined, undefined, undefined, { origin: 'automation' });
    expect(id).toBe(0x5151);
    expect(automationPacketTracker.isAutomationPacket(LOCAL, 0x5151)).toBe(true);
  });

  it('a manual text send (no origin) tags nothing', async () => {
    const mgr = makeReadyManager();
    await mgr.sendTextMessage('hello', 0);
    expect(automationPacketTracker.isAutomationPacket(LOCAL, 0x5151)).toBe(false);
    expect(automationPacketTracker.size('src-1')).toBe(0);
  });

  it("an explicit origin: 'manual' tags nothing", async () => {
    const mgr = makeReadyManager();
    await mgr.sendTextMessage('hello', 0, undefined, undefined, undefined, undefined, undefined, { origin: 'manual' });
    expect(automationPacketTracker.size('src-1')).toBe(0);
  });

  it('the queue carries the automation tag through to the send', async () => {
    const mgr = makeReadyManager();
    const send = vi.spyOn(mgr, 'sendTextMessage');
    const enqueue = vi.spyOn(mgr.messageQueue, 'enqueue').mockReturnValue('q1');
    (mgr as any).enqueueAutomation('auto reply', 0, undefined, undefined, undefined, 2, 1);
    expect(enqueue).toHaveBeenCalledWith(
      'auto reply', 0, undefined, undefined, undefined, 2, 1, undefined, undefined, 'automation',
    );
    // The queue's send callback forwards the entry's origin to sendTextMessage.
    const callback = (mgr.messageQueue as any).sendCallback as (...a: unknown[]) => Promise<number>;
    await callback('auto reply', 0, undefined, 2, undefined, undefined, 'automation');
    expect(send).toHaveBeenLastCalledWith(
      'auto reply', 2, undefined, undefined, undefined, undefined, undefined,
      { hopLimitOverride: undefined, origin: 'automation' },
    );
    expect(automationPacketTracker.isAutomationPacket(LOCAL, 0x5151)).toBe(true);
  });

  it('a manual queued send (v1 API) stays untagged', async () => {
    const mgr = makeReadyManager();
    const send = vi.spyOn(mgr, 'sendTextMessage');
    const callback = (mgr.messageQueue as any).sendCallback as (...a: unknown[]) => Promise<number>;
    await callback('hi', 0, undefined, 2);
    expect(send).toHaveBeenLastCalledWith('hi', 2, undefined, undefined, undefined, undefined, undefined, undefined);
    expect(automationPacketTracker.size('src-1')).toBe(0);
  });

  it('an automated traceroute gets its own id so it can be recognised', async () => {
    const mgr = makeReadyManager();
    await mgr.sendTraceroute(0x11111111, 0, { origin: 'automation' });
    const id = createTracerouteMessage.mock.calls.at(-1)?.[3] as number;
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
    expect(automationPacketTracker.isAutomationPacket(LOCAL, id)).toBe(true);
  });

  it('a manual traceroute leaves the id to the firmware', async () => {
    const mgr = makeReadyManager();
    await mgr.sendTraceroute(0x11111111, 0);
    expect(createTracerouteMessage.mock.calls.at(-1)?.[3]).toBeUndefined();
    expect(automationPacketTracker.size('src-1')).toBe(0);
  });

  it('an automated NodeInfo request tags the builder-assigned packet id', async () => {
    const mgr = makeReadyManager();
    await mgr.sendNodeInfoRequest(0x22222222, 0, { origin: 'automation' });
    expect(automationPacketTracker.isAutomationPacket(LOCAL, 0x6161)).toBe(true);
  });

  it('tags per source: source B does not claim source A\'s automation send', async () => {
    const a = makeReadyManager('src-a', 0xaaaa0001);
    await a.sendTextMessage('ack', 0, undefined, undefined, undefined, undefined, undefined, { origin: 'automation' });
    expect(automationPacketTracker.size('src-a')).toBe(1);
    expect(automationPacketTracker.size('src-b')).toBe(0);
    // Same id from B's node is not A's automation send.
    expect(automationPacketTracker.isAutomationPacket(0xbbbb0002, 0x5151)).toBe(false);
  });
});
