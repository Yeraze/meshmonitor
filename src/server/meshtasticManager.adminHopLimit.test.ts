/**
 * `getConfiguredHopLimit()` — the local node's own `lora.hopLimit`, read from
 * the in-memory device config.
 *
 * Admin packets used to be built with a hardcoded `hopLimit: 3`, so a user who
 * raised their node's hop limit to reach a deeper mesh still had every remote
 * admin command expire 3 hops out. This accessor is what the admin send paths
 * read instead; it mirrors `isTxEnabled()`'s shape (in-memory config, no DB
 * access, safe per packet).
 *
 * The mock set below mirrors `meshtasticManager.txDisabled.test.ts` — enough to
 * construct a manager without touching a socket, a DB, or a real TCP port.
 */
import { describe, it, expect, vi } from 'vitest';

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
    messages: { insertMessage: vi.fn().mockResolvedValue(true) },
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
import { DEFAULT_HOP_LIMIT, MAX_HOP_LIMIT } from './constants/meshtastic.js';

function makeManager(lora?: Record<string, unknown>): MeshtasticManager {
  const mgr = new MeshtasticManager('src-1', { host: '127.0.0.1', port: 4403 });
  if (lora !== undefined) {
    (mgr as any).actualDeviceConfig = { lora };
  }
  return mgr;
}

describe('MeshtasticManager.getConfiguredHopLimit()', () => {
  it('falls back to the firmware default when no device config has arrived yet', () => {
    const mgr = makeManager();
    expect((mgr as any).actualDeviceConfig).toBeNull();
    expect(mgr.getConfiguredHopLimit()).toBe(DEFAULT_HOP_LIMIT);
  });

  it('falls back to the firmware default when lora config exists but hopLimit is absent', () => {
    // Proto3 omits an unset hop_limit, so the field reads back undefined.
    expect(makeManager({}).getConfiguredHopLimit()).toBe(DEFAULT_HOP_LIMIT);
  });

  it('returns the configured hop limit when the device reports one', () => {
    expect(makeManager({ hopLimit: 5 }).getConfiguredHopLimit()).toBe(5);
    expect(makeManager({ hopLimit: 7 }).getConfiguredHopLimit()).toBe(7);
  });

  it('passes an explicit 0 through', () => {
    // Reachable only if a decode ever surfaces a literal 0; a real device
    // configured to 0 omits the field (proto3) and lands on the default above.
    expect(makeManager({ hopLimit: 0 }).getConfiguredHopLimit()).toBe(0);
  });

  it('clamps a nonsense above-protocol value to the 3-bit max', () => {
    expect(makeManager({ hopLimit: 42 }).getConfiguredHopLimit()).toBe(MAX_HOP_LIMIT);
  });

  it('reflects a config update without needing a reconnect', () => {
    const mgr = makeManager({ hopLimit: 3 });
    expect(mgr.getConfiguredHopLimit()).toBe(3);
    (mgr as any).actualDeviceConfig = { lora: { hopLimit: 6 } };
    expect(mgr.getConfiguredHopLimit()).toBe(6);
  });
});
