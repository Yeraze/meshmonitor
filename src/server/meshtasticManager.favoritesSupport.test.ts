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

import { MeshtasticManager } from './meshtasticManager.js';

function makeManager(firmwareVersion: string | null | undefined) {
  const mgr = new MeshtasticManager('src-1', { host: '127.0.0.1', port: 4403 });
  (mgr as any).localNodeInfo = { nodeNum: 123, nodeId: '!0000007b', firmwareVersion };
  return mgr;
}

describe('MeshtasticManager.supportsFavorites — version-keyed cache', () => {
  it('returns true for 2.7.24', () => {
    expect(makeManager('2.7.24').supportsFavorites()).toBe(true);
  });

  it('returns true with a git-suffixed version (2.7.24.abc1234)', () => {
    expect(makeManager('2.7.24.abc1234').supportsFavorites()).toBe(true);
  });

  it('returns false for pre-2.7.0 firmware', () => {
    expect(makeManager('2.6.9').supportsFavorites()).toBe(false);
  });

  it('returns false when firmware is unknown WITHOUT caching it', () => {
    const mgr = makeManager(null);
    expect(mgr.supportsFavorites()).toBe(false);
    // The unknown-firmware false must not be cached, or it would stick.
    expect((mgr as any).favoritesSupportCache).toBeNull();
  });

  it('REGRESSION: recovers after firmware is populated via a non-metadata path', () => {
    // 1. Connect with unknown firmware; an early caller polls support → false.
    const mgr = makeManager(null);
    expect(mgr.supportsFavorites()).toBe(false);

    // 2. Firmware version arrives through a NodeInfo/node-rebuild path that does
    //    NOT clear favoritesSupportCache (the actual bug — issue: Auto Favorites
    //    warning on 2.7.24).
    (mgr as any).localNodeInfo.firmwareVersion = '2.7.24';

    // 3. Support must now reflect the real version, not a stale false.
    expect(mgr.supportsFavorites()).toBe(true);
  });

  it('recomputes when the firmware version changes across the 2.7.0 boundary', () => {
    const mgr = makeManager('2.6.5');
    expect(mgr.supportsFavorites()).toBe(false);

    // Upgrade in place without clearing the cache — version-keyed cache must notice.
    (mgr as any).localNodeInfo.firmwareVersion = '2.7.0';
    expect(mgr.supportsFavorites()).toBe(true);
  });

  it('caches by version (no recompute for the same version)', () => {
    const mgr = makeManager('2.7.24');
    const spy = vi.spyOn(mgr as any, 'parseFirmwareVersion');
    expect(mgr.supportsFavorites()).toBe(true);
    expect(mgr.supportsFavorites()).toBe(true);
    // Parsed once, then served from cache.
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
