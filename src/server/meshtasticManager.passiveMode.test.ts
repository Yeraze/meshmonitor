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
// serverEventNotificationService is invoked from handleDisconnected
vi.mock('./services/serverEventNotificationService.js', () => ({
  serverEventNotificationService: {
    notifyNodeDisconnected: vi.fn().mockResolvedValue(undefined),
    notifyNodeConnected: vi.fn().mockResolvedValue(undefined),
  },
}));

import { MeshtasticManager } from './meshtasticManager.js';

/**
 * Passive Mode (#3122) regression tests.
 *
 * Passive Mode targets large/fragile TCP nodes where the standard
 * post-reconnect full sync + outbound config burst correlates with
 * remote-initiated socket closes. The manager should:
 *   1. Carry the passiveMode flag through constructor + configureSource.
 *   2. Preserve cached node/config state across handleDisconnected when
 *      passiveMode is on (clear it otherwise — that's the legacy default).
 */
describe('MeshtasticManager — Passive Mode (#3122)', () => {
  beforeEach(() => {
    VNConstructor.mockClear();
  });

  describe('config wiring', () => {
    it('defaults passiveMode to false when not specified', () => {
      const mgr = new MeshtasticManager('src-1', { host: '127.0.0.1', port: 4403 });
      expect((mgr as any).passiveMode).toBe(false);
    });

    it('reads passiveMode=true from constructor sourceConfig', () => {
      const mgr = new MeshtasticManager('src-1', {
        host: '127.0.0.1',
        port: 4403,
        passiveMode: true,
      } as any);
      expect((mgr as any).passiveMode).toBe(true);
    });

    it('configureSource() applies a passiveMode=true override', () => {
      const mgr = new MeshtasticManager('src-1', { host: '127.0.0.1', port: 4403 });
      expect((mgr as any).passiveMode).toBe(false);
      mgr.configureSource({ host: '127.0.0.1', port: 4403, passiveMode: true } as any);
      expect((mgr as any).passiveMode).toBe(true);
    });

    it('configureSource() coerces a missing passiveMode field to false', () => {
      const mgr = new MeshtasticManager('src-1', {
        host: '127.0.0.1',
        port: 4403,
        passiveMode: true,
      } as any);
      mgr.configureSource({ host: '127.0.0.1', port: 4403 });
      expect((mgr as any).passiveMode).toBe(false);
    });
  });

  describe('handleDisconnected() state retention', () => {
    const seedCache = (mgr: any) => {
      mgr.localNodeInfo = { nodeNum: 0xaabbccdd, nodeId: '!aabbccdd' };
      mgr.actualDeviceConfig = { device: { role: 0 } };
      mgr.actualModuleConfig = { mqtt: { enabled: false } };
      mgr.initConfigCache = [new Uint8Array([1, 2, 3])];
      mgr.configCaptureComplete = true;
      mgr.favoritesSupportCache = { cached: true };
    };

    it('clears all cached state when passiveMode is OFF (legacy behavior)', async () => {
      const mgr = new MeshtasticManager('src-1', { host: '127.0.0.1', port: 4403 });
      seedCache(mgr as any);

      await (mgr as any).handleDisconnected();

      expect((mgr as any).localNodeInfo).toBeNull();
      expect((mgr as any).actualDeviceConfig).toBeNull();
      expect((mgr as any).actualModuleConfig).toBeNull();
      expect((mgr as any).initConfigCache).toEqual([]);
      expect((mgr as any).configCaptureComplete).toBe(false);
      expect((mgr as any).favoritesSupportCache).toBeNull();
    });

    it('preserves cached node + config state when passiveMode is ON (no virtual node)', async () => {
      const mgr = new MeshtasticManager('src-1', {
        host: '127.0.0.1',
        port: 4403,
        passiveMode: true,
      } as any);
      seedCache(mgr as any);

      await (mgr as any).handleDisconnected();

      // The whole point: don't drop the snapshot just because the socket bounced.
      expect((mgr as any).localNodeInfo).toEqual({ nodeNum: 0xaabbccdd, nodeId: '!aabbccdd' });
      expect((mgr as any).actualDeviceConfig).toEqual({ device: { role: 0 } });
      expect((mgr as any).actualModuleConfig).toEqual({ mqtt: { enabled: false } });
      expect((mgr as any).initConfigCache).toHaveLength(1);
      // configCaptureComplete must stay true so a passive reconnect can skip
      // re-running config capture from scratch.
      expect((mgr as any).configCaptureComplete).toBe(true);
      // favoritesSupportCache is always invalidated — it's keyed on the live
      // connection and re-derives cheaply on reconnect.
      expect((mgr as any).favoritesSupportCache).toBeNull();
    });

    it('passiveMode still clears initConfigCache when a Virtual Node is attached', async () => {
      const mgr = new MeshtasticManager('src-1', {
        host: '127.0.0.1',
        port: 4403,
        passiveMode: true,
        virtualNode: { enabled: true, port: 4503, allowAdminCommands: false },
      } as any);
      seedCache(mgr as any);

      await (mgr as any).handleDisconnected();

      // localNodeInfo + config snapshots still preserved.
      expect((mgr as any).localNodeInfo).not.toBeNull();
      expect((mgr as any).actualDeviceConfig).not.toBeNull();
      // But VN clients need fresh replay data, so the init capture is dropped.
      expect((mgr as any).initConfigCache).toEqual([]);
      expect((mgr as any).configCaptureComplete).toBe(false);
    });

    it('records lastDisconnectAt on disconnect for the passive resync staleness check', async () => {
      const mgr = new MeshtasticManager('src-1', {
        host: '127.0.0.1',
        port: 4403,
        passiveMode: true,
      } as any);
      seedCache(mgr as any);

      const before = Date.now();
      await (mgr as any).handleDisconnected();
      const after = Date.now();

      const t = (mgr as any).lastDisconnectAt as number | null;
      expect(t).not.toBeNull();
      expect(t!).toBeGreaterThanOrEqual(before);
      expect(t!).toBeLessThanOrEqual(after);
    });
  });

  describe('staleness window default (#3122 feedback)', () => {
    // The reporter recommended 4h as the default — long enough to absorb
    // repeated transient drops on a large infrastructure node, short enough
    // that genuine config drift self-corrects.
    it('uses a 4-hour passive resync staleness window', () => {
      const stale = (MeshtasticManager as any).PASSIVE_RESYNC_STALE_MS;
      expect(stale).toBe(4 * 60 * 60 * 1000);
    });
  });

  describe('per-source staleness override (#3122 follow-up)', () => {
    // Convenience: invoke the private effective-resolver via casted access so
    // tests don't have to set up a full reconnect to observe the threshold.
    const effective = (mgr: any): number => mgr.effectivePassiveResyncStaleMs();

    it('returns the class default when no override is set', () => {
      const mgr = new MeshtasticManager('src-1', { host: '127.0.0.1', port: 4403, passiveMode: true } as any);
      expect(effective(mgr)).toBe(4 * 60 * 60 * 1000);
    });

    it('reads passiveResyncStaleMs from the constructor when provided', () => {
      const oneHour = 60 * 60 * 1000;
      const mgr = new MeshtasticManager('src-1', {
        host: '127.0.0.1',
        port: 4403,
        passiveMode: true,
        passiveResyncStaleMs: oneHour,
      } as any);
      expect(effective(mgr)).toBe(oneHour);
    });

    it('configureSource() applies a per-source staleness override', () => {
      const mgr = new MeshtasticManager('src-1', { host: '127.0.0.1', port: 4403, passiveMode: true } as any);
      const twentyFourHours = 24 * 60 * 60 * 1000;
      mgr.configureSource({
        host: '127.0.0.1',
        port: 4403,
        passiveMode: true,
        passiveResyncStaleMs: twentyFourHours,
      } as any);
      expect(effective(mgr)).toBe(twentyFourHours);
    });

    it('configureSource() clears the override when passiveResyncStaleMs is omitted', () => {
      const mgr = new MeshtasticManager('src-1', {
        host: '127.0.0.1',
        port: 4403,
        passiveMode: true,
        passiveResyncStaleMs: 60_000,
      } as any);
      expect(effective(mgr)).toBe(60_000);

      mgr.configureSource({ host: '127.0.0.1', port: 4403, passiveMode: true });

      expect((mgr as any).passiveResyncStaleMs).toBeNull();
      expect(effective(mgr)).toBe(4 * 60 * 60 * 1000);
    });

    it('falls back to default when override is below the 1-minute floor', () => {
      const mgr = new MeshtasticManager('src-1', {
        host: '127.0.0.1',
        port: 4403,
        passiveMode: true,
        passiveResyncStaleMs: 1000, // 1 second — too short, would resync on every flap
      } as any);
      expect(effective(mgr)).toBe(4 * 60 * 60 * 1000);
    });

    it('falls back to default when override exceeds the 7-day ceiling', () => {
      const mgr = new MeshtasticManager('src-1', {
        host: '127.0.0.1',
        port: 4403,
        passiveMode: true,
        passiveResyncStaleMs: 30 * 24 * 60 * 60 * 1000, // 30 days
      } as any);
      expect(effective(mgr)).toBe(4 * 60 * 60 * 1000);
    });

    it('accepts the boundary values (exactly 1 minute and exactly 7 days)', () => {
      const minMgr = new MeshtasticManager('src-min', {
        host: '127.0.0.1', port: 4403, passiveMode: true, passiveResyncStaleMs: 60_000,
      } as any);
      const maxMgr = new MeshtasticManager('src-max', {
        host: '127.0.0.1', port: 4403, passiveMode: true, passiveResyncStaleMs: 7 * 24 * 60 * 60 * 1000,
      } as any);
      expect(effective(minMgr)).toBe(60_000);
      expect(effective(maxMgr)).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it('ignores non-numeric / NaN overrides', () => {
      const mgr = new MeshtasticManager('src-1', {
        host: '127.0.0.1',
        port: 4403,
        passiveMode: true,
        passiveResyncStaleMs: NaN,
      } as any);
      expect(effective(mgr)).toBe(4 * 60 * 60 * 1000);
    });
  });
});
