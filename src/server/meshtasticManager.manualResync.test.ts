import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
    },
    getAllTraceroutesForRecalculationAsync: vi.fn().mockResolvedValue([]),
    sources: { getSource: vi.fn().mockResolvedValue(null) },
    nodes: {
      getNode: vi.fn().mockResolvedValue(null),
      upsertNode: vi.fn().mockResolvedValue(undefined),
      getActiveNodes: vi.fn().mockResolvedValue([]),
      getAllNodes: vi.fn().mockResolvedValue([]),
    },
    recordTracerouteRequestAsync: vi.fn().mockResolvedValue(undefined),
  };
  return { default: shared, databaseService: shared };
});

vi.mock('./meshtasticProtobufService.js', () => {
  const svc = {
    createNodeInfo: vi.fn().mockResolvedValue(new Uint8Array()),
    createFromRadioWithPacket: vi.fn().mockResolvedValue(new Uint8Array()),
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

/**
 * Manual Resync (#3122 follow-up) — operator-initiated full config refresh.
 *
 * The reporter asked for a way to force a fresh sync even when Passive Mode
 * would otherwise skip it. The implementation must guard against the failure
 * mode of "single click turns into a sync loop" via single-flight + cooldown
 * + watchdog + post-recovery suppress.
 */
describe('MeshtasticManager — manual resync (#3122 follow-up)', () => {
  const seedConnectedManager = (passiveMode = true) => {
    const mgr = new MeshtasticManager('src-1', {
      host: '127.0.0.1',
      port: 4403,
      passiveMode,
    } as any) as any;
    mgr.isConnected = true;
    // Stub the private sendWantConfigId so we don't try to encode protobufs
    mgr.sendWantConfigId = vi.fn().mockResolvedValue(undefined);
    // Seed a cache so passive-mode recovery has something to reuse
    mgr.localNodeInfo = { nodeNum: 0xaabb, nodeId: '!0000aabb' };
    mgr.actualDeviceConfig = { device: { role: 0 } };
    mgr.actualModuleConfig = {};
    mgr.lastDisconnectAt = Date.now() - 1000;
    return mgr;
  };

  beforeEach(() => {
    VNConstructor.mockClear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('happy path', () => {
    it('sends want_config_id and reports inFlight=true', async () => {
      const mgr = seedConnectedManager();

      const result = await mgr.requestManualResync();

      expect(mgr.sendWantConfigId).toHaveBeenCalledOnce();
      expect(result.started).toBe(true);
      expect(result.inFlight).toBe(true);
      expect(result.cooldownExpiresAt).toBeGreaterThan(Date.now());
    });

    it('latches suppressNextAutoSync so a post-sync disconnect does not trigger another full sync', async () => {
      const mgr = seedConnectedManager();
      await mgr.requestManualResync();
      expect(mgr.suppressNextAutoSync).toBe(true);
    });

    it('marks configCaptureComplete=false / isCapturingInitConfig=true so streamed config refreshes the cache', async () => {
      const mgr = seedConnectedManager();
      mgr.configCaptureComplete = true;
      mgr.isCapturingInitConfig = false;

      await mgr.requestManualResync();

      expect(mgr.configCaptureComplete).toBe(false);
      expect(mgr.isCapturingInitConfig).toBe(true);
    });

    it('clears in-flight via clearManualResyncInFlight when the watchdog fires', async () => {
      const mgr = seedConnectedManager();
      await mgr.requestManualResync();
      expect(mgr.manualResyncInFlight).toBe(true);

      // Fast-forward past the watchdog timeout (120s).
      await vi.advanceTimersByTimeAsync(125_000);

      expect(mgr.manualResyncInFlight).toBe(false);
    });
  });

  describe('guards', () => {
    it('rejects a second request while one is in flight', async () => {
      const mgr = seedConnectedManager();
      await mgr.requestManualResync();

      const second = await mgr.requestManualResync();

      expect(second.started).toBe(false);
      expect(second.reason).toBe('in-flight');
      // First call sent it; second call must not have.
      expect(mgr.sendWantConfigId).toHaveBeenCalledOnce();
    });

    it('rejects a follow-up request within the 30s cooldown window', async () => {
      const mgr = seedConnectedManager();
      await mgr.requestManualResync();
      // Simulate that the first resync's configCaptureComplete fired so the
      // in-flight latch cleared — but we're still inside the cooldown.
      mgr.clearManualResyncInFlight('configComplete');

      const second = await mgr.requestManualResync();
      expect(second.started).toBe(false);
      expect(second.reason).toBe('cooldown');
      expect(mgr.sendWantConfigId).toHaveBeenCalledOnce();
    });

    it('allows a new request after the cooldown expires', async () => {
      const mgr = seedConnectedManager();
      await mgr.requestManualResync();
      mgr.clearManualResyncInFlight('configComplete');

      // Fast-forward past the 30s cooldown.
      await vi.advanceTimersByTimeAsync(31_000);

      const second = await mgr.requestManualResync();
      expect(second.started).toBe(true);
      expect(mgr.sendWantConfigId).toHaveBeenCalledTimes(2);
    });

    it('rejects when the source is not connected', async () => {
      const mgr = seedConnectedManager();
      mgr.isConnected = false;

      const result = await mgr.requestManualResync();
      expect(result.started).toBe(false);
      expect(result.reason).toBe('not-connected');
      expect(mgr.sendWantConfigId).not.toHaveBeenCalled();
    });

    it('clears in-flight and suppress flag if sendWantConfigId throws', async () => {
      const mgr = seedConnectedManager();
      mgr.sendWantConfigId = vi.fn().mockRejectedValue(new Error('transport gone'));

      const result = await mgr.requestManualResync();

      expect(result.started).toBe(false);
      expect(result.reason).toBe('send-failed');
      expect(mgr.manualResyncInFlight).toBe(false);
      expect(mgr.suppressNextAutoSync).toBe(false);
    });
  });

  describe('getManualResyncState()', () => {
    it('returns inFlight=false, cooldownExpiresAt=0 before any resync', () => {
      const mgr = seedConnectedManager();
      expect(mgr.getManualResyncState()).toEqual({ inFlight: false, cooldownExpiresAt: 0 });
    });

    it('reflects in-flight + cooldownExpiresAt after a successful start', async () => {
      const mgr = seedConnectedManager();
      const before = Date.now();
      await mgr.requestManualResync();
      const state = mgr.getManualResyncState();

      expect(state.inFlight).toBe(true);
      expect(state.cooldownExpiresAt).toBeGreaterThanOrEqual(before + 30_000);
    });
  });
});
