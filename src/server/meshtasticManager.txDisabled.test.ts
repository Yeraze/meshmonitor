/**
 * TX-disabled transmit guard (#4294 epic, Phase 1 WP1).
 *
 * `lora.txEnabled === false` is a hard radio kill switch reported by the
 * device's own config. `isTxEnabled()` reads it from the in-memory
 * `actualDeviceConfig` (default true when unknown/absent — fail-open so we
 * never block sends before the first config frame arrives). Each of the six
 * OTA send primitives throws `TxDisabledError` immediately after the
 * existing "not connected" check, before doing any other work — so these
 * tests only need `isConnected`/`transport` seeded, not a full send-path
 * mock, to prove the guard fires (and doesn't fire) at the right times.
 *
 * See docs/internal/dev-notes/TX_DISABLED_PHASE1_SPEC.md §2-4.
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

/** Seeds the minimal private state each primitive's early checks read. */
function makeReadyManager(): MeshtasticManager {
  const mgr = new MeshtasticManager('src-1', { host: '127.0.0.1', port: 4403 });
  (mgr as any).transport = { send: vi.fn().mockResolvedValue(undefined) };
  (mgr as any).isConnected = true;
  (mgr as any).localNodeInfo = {
    nodeNum: 0x0badbeef,
    nodeId: '!0badbeef',
    longName: 'Local Node',
    shortName: 'LOCL',
  };
  return mgr;
}

/**
 * The guard is the only thing under test here — downstream send logic isn't
 * fully mocked for every primitive, so a non-TxDisabledError failure past
 * the guard is an acceptable (and expected) outcome for the "TX enabled"
 * cases. What matters is that the guard itself never fires.
 */
async function expectNotBlockedByTxGuard(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    expect(isTxDisabledError(error)).toBe(false);
  }
}

describe('MeshtasticManager — TX-disabled transmit guard (#4294 WP1)', () => {
  beforeEach(() => {
    VNConstructor.mockClear();
  });

  describe('isTxEnabled()', () => {
    it('defaults to true when no device config has arrived yet', () => {
      const mgr = new MeshtasticManager('src-1', { host: '127.0.0.1', port: 4403 });
      expect((mgr as any).actualDeviceConfig).toBeNull();
      expect(mgr.isTxEnabled()).toBe(true);
    });

    it('returns true when lora.txEnabled is undefined (Proto3 default)', () => {
      const mgr = new MeshtasticManager('src-1', { host: '127.0.0.1', port: 4403 });
      (mgr as any).actualDeviceConfig = { lora: {} };
      expect(mgr.isTxEnabled()).toBe(true);
    });

    it('returns true when lora.txEnabled is explicitly true', () => {
      const mgr = new MeshtasticManager('src-1', { host: '127.0.0.1', port: 4403 });
      (mgr as any).actualDeviceConfig = { lora: { txEnabled: true } };
      expect(mgr.isTxEnabled()).toBe(true);
    });

    it('returns false when lora.txEnabled is explicitly false', () => {
      const mgr = new MeshtasticManager('src-1', { host: '127.0.0.1', port: 4403 });
      (mgr as any).actualDeviceConfig = { lora: { txEnabled: false } };
      expect(mgr.isTxEnabled()).toBe(false);
    });
  });

  describe('primitive guards — throw TxDisabledError when TX is off', () => {
    it('sendTextMessage', async () => {
      const mgr = makeReadyManager();
      (mgr as any).actualDeviceConfig = { lora: { txEnabled: false } };
      await expect(mgr.sendTextMessage('hi', 0)).rejects.toMatchObject({ isTxDisabledError: true, code: 'TX_DISABLED' });
    });

    it('sendTraceroute', async () => {
      const mgr = makeReadyManager();
      (mgr as any).actualDeviceConfig = { lora: { txEnabled: false } };
      await expect(mgr.sendTraceroute(0x11111111, 0)).rejects.toMatchObject({ isTxDisabledError: true });
    });

    it('sendPositionRequest', async () => {
      const mgr = makeReadyManager();
      (mgr as any).actualDeviceConfig = { lora: { txEnabled: false } };
      await expect(mgr.sendPositionRequest(0x11111111, 0)).rejects.toMatchObject({ isTxDisabledError: true });
    });

    it('sendNodeInfoRequest', async () => {
      const mgr = makeReadyManager();
      (mgr as any).actualDeviceConfig = { lora: { txEnabled: false } };
      await expect(mgr.sendNodeInfoRequest(0x11111111, 0)).rejects.toMatchObject({ isTxDisabledError: true });
    });

    it('sendNeighborInfoRequest', async () => {
      const mgr = makeReadyManager();
      (mgr as any).actualDeviceConfig = { lora: { txEnabled: false } };
      await expect(mgr.sendNeighborInfoRequest(0x11111111, 0)).rejects.toMatchObject({ isTxDisabledError: true });
    });

    it('sendTelemetryRequest', async () => {
      const mgr = makeReadyManager();
      (mgr as any).actualDeviceConfig = { lora: { txEnabled: false } };
      await expect(mgr.sendTelemetryRequest(0x11111111, 0)).rejects.toMatchObject({ isTxDisabledError: true });
    });

    it('guard fires before the "not connected" checks matter — still requires isConnected/transport first', async () => {
      const mgr = new MeshtasticManager('src-1', { host: '127.0.0.1', port: 4403 });
      // Not connected at all — should get the pre-existing connection error, not TxDisabledError.
      (mgr as any).actualDeviceConfig = { lora: { txEnabled: false } };
      await expect(mgr.sendTextMessage('hi', 0)).rejects.toThrow('Not connected to Meshtastic node');
    });
  });

  describe('primitive guards — do not block when TX is enabled or unknown', () => {
    it('sendTextMessage — txEnabled true', async () => {
      const mgr = makeReadyManager();
      (mgr as any).actualDeviceConfig = { lora: { txEnabled: true } };
      await expectNotBlockedByTxGuard(() => mgr.sendTextMessage('hi', 0));
    });

    it('sendTextMessage — txEnabled undefined (config not yet known)', async () => {
      const mgr = makeReadyManager();
      await expectNotBlockedByTxGuard(() => mgr.sendTextMessage('hi', 0));
    });

    it('sendTraceroute — txEnabled true', async () => {
      const mgr = makeReadyManager();
      (mgr as any).actualDeviceConfig = { lora: { txEnabled: true } };
      await expectNotBlockedByTxGuard(() => mgr.sendTraceroute(0x11111111, 0));
    });

    it('sendPositionRequest — txEnabled undefined', async () => {
      const mgr = makeReadyManager();
      await expectNotBlockedByTxGuard(() => mgr.sendPositionRequest(0x11111111, 0));
    });

    it('sendNodeInfoRequest — txEnabled true', async () => {
      const mgr = makeReadyManager();
      (mgr as any).actualDeviceConfig = { lora: { txEnabled: true } };
      await expectNotBlockedByTxGuard(() => mgr.sendNodeInfoRequest(0x11111111, 0));
    });

    it('sendNeighborInfoRequest — txEnabled undefined', async () => {
      const mgr = makeReadyManager();
      await expectNotBlockedByTxGuard(() => mgr.sendNeighborInfoRequest(0x11111111, 0));
    });

    it('sendTelemetryRequest — txEnabled true', async () => {
      const mgr = makeReadyManager();
      (mgr as any).actualDeviceConfig = { lora: { txEnabled: true } };
      await expectNotBlockedByTxGuard(() => mgr.sendTelemetryRequest(0x11111111, 0));
    });
  });

  describe('config-merge state-change logging (§2)', () => {
    it('flips isTxEnabled() as actualDeviceConfig.lora.txEnabled changes across merges', () => {
      const mgr = new MeshtasticManager('src-1', { host: '127.0.0.1', port: 4403 });
      expect(mgr.isTxEnabled()).toBe(true);

      // Simulate the merge point's assignment directly (the FromRadio parsing
      // path itself is covered elsewhere; this asserts the accessor tracks
      // the merged field, which is what the state-change log branches on).
      (mgr as any).actualDeviceConfig = { ...(mgr as any).actualDeviceConfig, lora: { txEnabled: false } };
      expect(mgr.isTxEnabled()).toBe(false);

      (mgr as any).actualDeviceConfig = { ...(mgr as any).actualDeviceConfig, lora: { txEnabled: true } };
      expect(mgr.isTxEnabled()).toBe(true);
    });
  });
});
