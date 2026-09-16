/**
 * sendTextMessage hop-limit override (#5121) — the manager-level rules.
 *
 * The override is capped at this node's own `lora.hop_limit`, so an automated
 * send can only ever shorten reach. A zero-hop send carries no ACK request, so
 * the stored row is `wantAck: false` and already `delivered` on handoff instead
 * of sitting at `pending` forever.
 *
 * Mocks mirror meshtasticManager.txDisabled.test.ts.
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

// Stub the TCP transport so constructing a manager never touches a real socket
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
    createTextMessage: vi.fn(() => ({ data: new Uint8Array([1, 2, 3]), messageId: 12345 })),
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
import databaseService from '../services/database.js';

function makeReadyManager(lora?: Record<string, unknown>): MeshtasticManager {
  const mgr = new MeshtasticManager('src-1', { host: '127.0.0.1', port: 4403 });
  (mgr as any).transport = { send: vi.fn().mockResolvedValue(undefined) };
  (mgr as any).isConnected = true;
  (mgr as any).localNodeInfo = {
    nodeNum: 0x0badbeef,
    nodeId: '!0badbeef',
    longName: 'Local Node',
    shortName: 'LOCL',
  };
  if (lora) (mgr as any).actualDeviceConfig = { lora };
  return mgr;
}

const createTextMessage = meshtasticProtobufService.createTextMessage as unknown as ReturnType<typeof vi.fn>;
const insertMessage = (databaseService as any).messages.insertMessage as ReturnType<typeof vi.fn>;

/** The hopLimit argument createTextMessage was called with (7th positional). */
function builtHopLimit(): number | undefined {
  return createTextMessage.mock.calls.at(-1)?.[6];
}

describe('MeshtasticManager.sendTextMessage hop-limit override (#5121)', () => {
  beforeEach(() => {
    createTextMessage.mockClear();
    insertMessage.mockClear();
  });

  it('leaves hop_limit unset without an override', async () => {
    const mgr = makeReadyManager({ hopLimit: 3 });
    await mgr.sendTextMessage('hi', 0);
    expect(builtHopLimit()).toBeUndefined();
  });

  it('applies an override below the node hop limit', async () => {
    const mgr = makeReadyManager({ hopLimit: 5 });
    await mgr.sendTextMessage('hi', 0, undefined, undefined, undefined, undefined, undefined, { hopLimitOverride: 2 });
    expect(builtHopLimit()).toBe(2);
  });

  it('caps an override above the node hop limit — never extends reach', async () => {
    const mgr = makeReadyManager({ hopLimit: 3 });
    await mgr.sendTextMessage('hi', 0, undefined, undefined, undefined, undefined, undefined, { hopLimitOverride: 7 });
    expect(builtHopLimit()).toBe(3);
  });

  it('caps at the firmware default when the node config has not arrived', async () => {
    const mgr = makeReadyManager();
    await mgr.sendTextMessage('hi', 0, undefined, undefined, undefined, undefined, undefined, { hopLimitOverride: 6 });
    expect(builtHopLimit()).toBe(3);
  });

  it('stores an ordinary send as pending with an ACK requested', async () => {
    const mgr = makeReadyManager({ hopLimit: 3 });
    await mgr.sendTextMessage('hi', 0);
    const row = insertMessage.mock.calls.at(-1)?.[0];
    expect(row).toMatchObject({ wantAck: true, deliveryState: 'pending' });
  });

  it('stores a zero-hop send as delivered with no ACK requested', async () => {
    const mgr = makeReadyManager({ hopLimit: 3 });
    await mgr.sendTextMessage('hi', 0, 0x1234, undefined, undefined, undefined, undefined, { hopLimitOverride: 0 });
    expect(builtHopLimit()).toBe(0);
    const row = insertMessage.mock.calls.at(-1)?.[0];
    expect(row).toMatchObject({ wantAck: false, deliveryState: 'delivered' });
  });
});
