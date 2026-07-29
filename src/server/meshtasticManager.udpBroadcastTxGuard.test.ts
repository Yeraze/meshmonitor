/**
 * UDP-broadcast relay and the transmit guard (#4394).
 *
 * Firmware `Router::send()` calls `udpHandler->onSend(p)` gated ONLY on
 * `config.network.enabled_protocols & UDP_BROADCAST` — there is no
 * `tx_enabled` check on that path. So a node with the radio TX-disabled but
 * UDP Broadcast enabled still puts every outgoing packet on the local LAN,
 * where a peer with a working radio (e.g. a CLIENT_BASE) relays it onto the
 * mesh. Blocking those sends was wrong.
 *
 * The guard therefore keys off `canTransmit()`:
 *
 *   tx on,  udp off → allow
 *   tx on,  udp on  → allow
 *   tx off, udp on  → allow  (relayed by a LAN peer)
 *   tx off, udp off → block  (TX_DISABLED, the #4294 receive-only case)
 *
 * `isTxEnabled()` keeps its old, narrower meaning (raw `lora.txEnabled`)
 * because the config import/export/backup paths depend on it to preserve the
 * device's own setting — see #4294.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the VirtualNodeServer so tests never bind a real TCP port
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
import { isTxDisabledError } from './errors/txDisabledError.js';
import { NetworkProtocolFlags, isUdpBroadcastEnabled } from './constants/meshtastic.js';

const UDP = NetworkProtocolFlags.UDP_BROADCAST;

function makeManager(deviceConfig: any): MeshtasticManager {
  const mgr = new MeshtasticManager('src-1', { host: '127.0.0.1', port: 4403 });
  (mgr as any).transport = { send: vi.fn().mockResolvedValue(undefined) };
  (mgr as any).isConnected = true;
  (mgr as any).localNodeInfo = {
    nodeNum: 0x0badbeef,
    nodeId: '!0badbeef',
    longName: 'Local Node',
    shortName: 'LOCL',
  };
  (mgr as any).actualDeviceConfig = deviceConfig;
  return mgr;
}

/**
 * Downstream send logic isn't fully mocked, so any non-TxDisabledError failure
 * past the guard is fine — what matters is that the guard itself never fires.
 */
async function expectNotBlockedByTxGuard(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    expect(isTxDisabledError(error)).toBe(false);
  }
}

describe('isUdpBroadcastEnabled() — ProtocolFlags bit test (#4394)', () => {
  it('matches the config.proto flag value', () => {
    expect(NetworkProtocolFlags.NO_BROADCAST).toBe(0x0000);
    expect(NetworkProtocolFlags.UDP_BROADCAST).toBe(0x0001);
  });

  it('is false for the proto3 "field omitted" shapes', () => {
    expect(isUdpBroadcastEnabled(undefined)).toBe(false);
    expect(isUdpBroadcastEnabled(null)).toBe(false);
    expect(isUdpBroadcastEnabled(0)).toBe(false);
  });

  it('is true when the UDP_BROADCAST bit is set, alone or alongside others', () => {
    expect(isUdpBroadcastEnabled(1)).toBe(true);
    expect(isUdpBroadcastEnabled(3)).toBe(true);
    expect(isUdpBroadcastEnabled(0xffff)).toBe(true);
  });

  it('is false when other bits are set but UDP_BROADCAST is not', () => {
    expect(isUdpBroadcastEnabled(2)).toBe(false);
    expect(isUdpBroadcastEnabled(0xfffe)).toBe(false);
  });

  it('is false for non-numeric junk rather than throwing', () => {
    expect(isUdpBroadcastEnabled('nonsense')).toBe(false);
    expect(isUdpBroadcastEnabled({})).toBe(false);
  });
});

describe('MeshtasticManager — canTransmit() truth table (#4394)', () => {
  beforeEach(() => {
    VNConstructor.mockClear();
  });

  it('tx on, udp off → can transmit', () => {
    const mgr = makeManager({ lora: { txEnabled: true }, network: { enabledProtocols: 0 } });
    expect(mgr.isTxEnabled()).toBe(true);
    expect(mgr.isUdpBroadcastRelayEnabled()).toBe(false);
    expect(mgr.canTransmit()).toBe(true);
  });

  it('tx on, udp on → can transmit', () => {
    const mgr = makeManager({ lora: { txEnabled: true }, network: { enabledProtocols: UDP } });
    expect(mgr.isUdpBroadcastRelayEnabled()).toBe(true);
    expect(mgr.canTransmit()).toBe(true);
  });

  it('tx off, udp on → can transmit (a LAN peer relays for us)', () => {
    const mgr = makeManager({ lora: { txEnabled: false }, network: { enabledProtocols: UDP } });
    expect(mgr.isTxEnabled()).toBe(false);
    expect(mgr.isUdpBroadcastRelayEnabled()).toBe(true);
    expect(mgr.canTransmit()).toBe(true);
  });

  it('tx off, udp off → cannot transmit', () => {
    const mgr = makeManager({ lora: { txEnabled: false }, network: { enabledProtocols: 0 } });
    expect(mgr.canTransmit()).toBe(false);
  });

  it('tx off with NO network config at all → treated as udp off, cannot transmit', () => {
    const mgr = makeManager({ lora: { txEnabled: false } });
    expect(mgr.isUdpBroadcastRelayEnabled()).toBe(false);
    expect(mgr.canTransmit()).toBe(false);
  });

  it('tx off with network config present but enabledProtocols omitted → cannot transmit', () => {
    const mgr = makeManager({ lora: { txEnabled: false }, network: {} });
    expect(mgr.canTransmit()).toBe(false);
  });

  it('no device config at all → fail-open, can transmit', () => {
    const mgr = new MeshtasticManager('src-1', { host: '127.0.0.1', port: 4403 });
    expect((mgr as any).actualDeviceConfig).toBeNull();
    expect(mgr.canTransmit()).toBe(true);
  });

  it('keeps isTxEnabled() reporting the RAW radio flag so config import/export still preserves it (#4294)', () => {
    const mgr = makeManager({ lora: { txEnabled: false }, network: { enabledProtocols: UDP } });
    // The radio truly cannot transmit — only canTransmit() may say otherwise.
    expect(mgr.isTxEnabled()).toBe(false);
  });
});

describe('MeshtasticManager — transmit primitives honor the UDP relay path (#4394)', () => {
  beforeEach(() => {
    VNConstructor.mockClear();
  });

  const blocked = { lora: { txEnabled: false }, network: { enabledProtocols: 0 } };
  const relayed = { lora: { txEnabled: false }, network: { enabledProtocols: UDP } };

  it('sendTextMessage throws TX_DISABLED when tx off and udp off', async () => {
    const mgr = makeManager(blocked);
    await expect(mgr.sendTextMessage('hi', 0)).rejects.toMatchObject({
      isTxDisabledError: true,
      code: 'TX_DISABLED',
    });
  });

  it('sendTextMessage is NOT blocked when tx off but udp broadcast is on', async () => {
    const mgr = makeManager(relayed);
    await expectNotBlockedByTxGuard(() => mgr.sendTextMessage('hi', 0));
  });

  it('sendTraceroute is NOT blocked when tx off but udp broadcast is on', async () => {
    const mgr = makeManager(relayed);
    await expectNotBlockedByTxGuard(() => mgr.sendTraceroute(0x11111111, 0));
  });

  it('sendTraceroute is still blocked when tx off and udp off', async () => {
    const mgr = makeManager(blocked);
    await expect(mgr.sendTraceroute(0x11111111, 0)).rejects.toMatchObject({ isTxDisabledError: true });
  });

  it('sendPositionRequest is NOT blocked when tx off but udp broadcast is on', async () => {
    const mgr = makeManager(relayed);
    await expectNotBlockedByTxGuard(() => mgr.sendPositionRequest(0x11111111, 0));
  });

  it('sendNodeInfoRequest is NOT blocked when tx off but udp broadcast is on', async () => {
    const mgr = makeManager(relayed);
    await expectNotBlockedByTxGuard(() => mgr.sendNodeInfoRequest(0x11111111, 0));
  });
});
