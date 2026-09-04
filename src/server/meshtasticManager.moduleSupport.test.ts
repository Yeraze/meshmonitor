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
  describe('supportsTrafficManagement (>= 2.8.0)', () => {
    // Traffic Management is develop/2.8-only (meshtastic/firmware PR #9358).
    // The released v2.7.26 tag does not contain the module or AdminModule handler.
    it('returns false for 2.7.26 (released without the firmware module)', () => {
      expect((makeManager('2.7.26') as any).supportsTrafficManagement()).toBe(false);
    });

    it('returns false with a 2.7.26 git suffix', () => {
      expect((makeManager('2.7.26.abc1234') as any).supportsTrafficManagement()).toBe(false);
    });

    it('returns false for later 2.7.x builds', () => {
      expect((makeManager('2.7.99') as any).supportsTrafficManagement()).toBe(false);
    });

    it('returns true for the exact threshold 2.8.0', () => {
      expect((makeManager('2.8.0') as any).supportsTrafficManagement()).toBe(true);
    });

    it('returns false when firmware version is unknown', () => {
      expect((makeManager(undefined) as any).supportsTrafficManagement()).toBe(false);
    });
  });

  describe('supportsStatusMessage (>= 2.7.20)', () => {
    it('returns true for 2.7.24', () => {
      expect((makeManager('2.7.24') as any).supportsStatusMessage()).toBe(true);
    });

    it('returns true for the exact threshold 2.7.20', () => {
      expect((makeManager('2.7.20') as any).supportsStatusMessage()).toBe(true);
    });

    it('returns false for 2.7.19 (handler first shipped in 2.7.20)', () => {
      expect((makeManager('2.7.19') as any).supportsStatusMessage()).toBe(false);
    });

    it('returns false for 2.7.18', () => {
      expect((makeManager('2.7.18') as any).supportsStatusMessage()).toBe(false);
    });
  });

  describe('supportsRangeTest (removed in 2.8 - inverse gate, #5031)', () => {
    // Range Test is the one module gated by an UPPER bound: it was removed
    // outright in firmware 2.8 (confirmed by garth, a Meshtastic maintainer),
    // so support means "older than 2.8.0".
    it('returns true for 2.7.26', () => {
      expect((makeManager('2.7.26') as any).supportsRangeTest()).toBe(true);
    });

    it('returns true for the last 2.7.x builds', () => {
      expect((makeManager('2.7.99') as any).supportsRangeTest()).toBe(true);
    });

    it('returns false at the exact removal threshold 2.8.0', () => {
      expect((makeManager('2.8.0') as any).supportsRangeTest()).toBe(false);
    });

    it('returns false for 2.8.x with a commit-hash suffix', () => {
      expect((makeManager('2.8.4.abc1234') as any).supportsRangeTest()).toBe(false);
    });

    it('returns false for a 2.8.0 pre-release suffix', () => {
      expect((makeManager('2.8.0-alpha.1') as any).supportsRangeTest()).toBe(false);
    });

    it('returns false for a future major (3.0.0)', () => {
      expect((makeManager('3.0.0') as any).supportsRangeTest()).toBe(false);
    });

    it('fails OPEN when the firmware version is unknown', () => {
      // Unknown version must NOT disable the UI - that would look like a bug.
      expect((makeManager(undefined) as any).supportsRangeTest()).toBe(true);
    });

    it('fails OPEN when the firmware version is unparseable', () => {
      expect((makeManager('unknown') as any).supportsRangeTest()).toBe(true);
      expect((makeManager('v2.8.0') as any).supportsRangeTest()).toBe(true);
      expect((makeManager('') as any).supportsRangeTest()).toBe(true);
    });
  });

  describe('parseFirmwareVersion edge cases', () => {
    const parse = (v: string) => (makeManager(undefined) as any).parseFirmwareVersion(v);

    it('parses a plain three-part version', () => {
      expect(parse('2.7.11')).toEqual({ major: 2, minor: 7, patch: 11 });
    });

    it('parses a version with a trailing commit-hash segment', () => {
      expect(parse('2.8.0.abcdef1')).toEqual({ major: 2, minor: 8, patch: 0 });
    });

    it('parses a pre-release suffixed version', () => {
      expect(parse('2.8.0-alpha.1')).toEqual({ major: 2, minor: 8, patch: 0 });
    });

    it('parses multi-digit components without truncation', () => {
      expect(parse('10.11.12')).toEqual({ major: 10, minor: 11, patch: 12 });
    });

    it('returns null for a v-prefixed or otherwise unparseable string', () => {
      expect(parse('v2.8.0')).toBeNull();
      expect(parse('2.8')).toBeNull();
      expect(parse('')).toBeNull();
      expect(parse('unknown')).toBeNull();
    });
  });

  describe('getCurrentConfig().supportedModules', () => {
    // Regression: a 2.7.24 device that has never had Traffic Management or
    // StatusMessage configured sends an all-default config. Proto3 omits an
    // all-default sub-message, so actualModuleConfig has no trafficManagement /
    // statusmessage key. Support MUST still be reported based on firmware version.
    it('reports trafficManagement unsupported but statusmessage supported on 2.7.26 with empty config', () => {
      const mgr = makeManager('2.7.26');
      (mgr as any).actualModuleConfig = {}; // no trafficManagement / statusmessage keys (Proto3 omitted)

      const { supportedModules } = mgr.getCurrentConfig();

      expect(supportedModules.trafficManagement).toBe(false);
      expect(supportedModules.statusmessage).toBe(true);
      // Range Test still exists on 2.7.x (#5031).
      expect(supportedModules.rangeTest).toBe(true);
    });

    it('reports rangeTest unsupported on 2.8.0, where the module was removed (#5031)', () => {
      const mgr = makeManager('2.8.0');
      (mgr as any).actualModuleConfig = {};

      const { supportedModules } = mgr.getCurrentConfig();

      expect(supportedModules.rangeTest).toBe(false);
      expect(supportedModules.trafficManagement).toBe(true);
    });

    it('reports rangeTest supported when the firmware version is unknown (fail open, #5031)', () => {
      const mgr = makeManager(undefined);
      (mgr as any).actualModuleConfig = {};

      const { supportedModules } = mgr.getCurrentConfig();

      expect(supportedModules.rangeTest).toBe(true);
    });

    it('reports trafficManagement unsupported on 2.7.25 — the issue #3491 case', () => {
      // 2.7.25 decodes the admin message but has no firmware handler, so a save
      // would silently not persist. MeshMonitor must NOT advertise it as editable.
      const mgr = makeManager('2.7.25');
      (mgr as any).actualModuleConfig = {};

      const { supportedModules } = mgr.getCurrentConfig();

      expect(supportedModules.trafficManagement).toBe(false);
      expect(supportedModules.statusmessage).toBe(true); // >= 2.7.20
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

      expect(supportedModules.trafficManagement).toBe(false); // needs >= 2.8.0
      expect(supportedModules.statusmessage).toBe(true); // needs >= 2.7.20
    });
  });
});
