import { describe, it, expect, vi } from 'vitest';

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

// Prevent the constructor's async position-recalc path from touching the DB
vi.mock('../services/database.js', () => {
  const shared = {
    waitForReady: vi.fn().mockResolvedValue(undefined),
    settings: {
      getSetting: vi.fn().mockResolvedValue(null),
      setSetting: vi.fn().mockResolvedValue(undefined),
    },
    getAllTraceroutesForRecalculationAsync: vi.fn().mockResolvedValue([]),
    sources: {
      getSource: vi.fn().mockResolvedValue(null),
    },
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

import { MeshtasticManager } from './meshtasticManager.js';

function makeManager(firmwareVersion: string | undefined) {
  const mgr = new MeshtasticManager('src-1', { host: '127.0.0.1', port: 4403 });
  (mgr as any).localNodeInfo = {
    nodeNum: 123,
    nodeId: '!0000007b',
    firmwareVersion,
  };
  return mgr;
}

describe('MeshtasticManager — module support gating (firmware version, not config presence)', () => {
  describe('supportsTrafficManagement (>= 2.7.22)', () => {
    it('returns true for 2.7.24', () => {
      expect((makeManager('2.7.24') as any).supportsTrafficManagement()).toBe(true);
    });

    it('returns true for the exact threshold 2.7.22', () => {
      expect((makeManager('2.7.22') as any).supportsTrafficManagement()).toBe(true);
    });

    it('returns true with a git suffix (2.7.22.abc1234)', () => {
      expect((makeManager('2.7.22.abc1234') as any).supportsTrafficManagement()).toBe(true);
    });

    it('returns false for 2.7.21', () => {
      expect((makeManager('2.7.21') as any).supportsTrafficManagement()).toBe(false);
    });

    it('returns false when firmware version is unknown', () => {
      expect((makeManager(undefined) as any).supportsTrafficManagement()).toBe(false);
    });
  });

  describe('supportsStatusMessage (>= 2.7.19)', () => {
    it('returns true for 2.7.24', () => {
      expect((makeManager('2.7.24') as any).supportsStatusMessage()).toBe(true);
    });

    it('returns true for the exact threshold 2.7.19', () => {
      expect((makeManager('2.7.19') as any).supportsStatusMessage()).toBe(true);
    });

    it('returns false for 2.7.18', () => {
      expect((makeManager('2.7.18') as any).supportsStatusMessage()).toBe(false);
    });
  });

  describe('getCurrentConfig().supportedModules', () => {
    // Regression: a 2.7.24 device that has never had Traffic Management or
    // StatusMessage configured sends an all-default config. Proto3 omits an
    // all-default sub-message, so actualModuleConfig has no trafficManagement /
    // statusmessage key. Support MUST still be reported based on firmware version.
    it('reports trafficManagement and statusmessage supported on 2.7.24 with empty module config', () => {
      const mgr = makeManager('2.7.24');
      (mgr as any).actualModuleConfig = {}; // no trafficManagement / statusmessage keys (Proto3 omitted)

      const { supportedModules } = mgr.getCurrentConfig();

      expect(supportedModules.trafficManagement).toBe(true);
      expect(supportedModules.statusmessage).toBe(true);
    });

    it('reports neither supported on older firmware (2.7.10) even if a config object is present', () => {
      const mgr = makeManager('2.7.10');
      // Even if a stale/spurious config object were present, old firmware is unsupported.
      (mgr as any).actualModuleConfig = { trafficManagement: { enabled: true }, statusmessage: {} };

      const { supportedModules } = mgr.getCurrentConfig();

      expect(supportedModules.trafficManagement).toBe(false);
      expect(supportedModules.statusmessage).toBe(false);
    });

    it('reports trafficManagement unsupported but statusmessage supported on 2.7.20', () => {
      const mgr = makeManager('2.7.20');
      (mgr as any).actualModuleConfig = {};

      const { supportedModules } = mgr.getCurrentConfig();

      expect(supportedModules.trafficManagement).toBe(false); // needs 2.7.22
      expect(supportedModules.statusmessage).toBe(true); // needs 2.7.19
    });
  });
});
