/**
 * Tests for favorites management (#3962 Phase 4.2a PR4 §4c).
 *
 * `FavoritesService` is tested against minimal fakes implementing only the
 * narrow public surface it depends on — a manager fake (mirroring the real
 * accessors: `sourceId`/`getFavoritesSupportCache`/`setFavoritesSupportCache`/
 * `parseFirmwareVersion`/`isTransportReady`/`isDeviceConnected`/
 * `getLocalNodeInfo`/`getSessionPasskey`/`requestRemoteSessionPasskey`/
 * `localNodeSettingKey`/`isAutoFavoritingNode`/`addAutoFavoritingNode`/
 * `removeAutoFavoritingNode`) and an `AdminTransactionService` fake
 * (`sendAdminCommand`/`sendAdminCommandAwaitAck`) — same style as
 * `nodeDbMaintenanceService.test.ts` / `adminTransactionService.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getSetting = vi.fn();
const getSettingForSource = vi.fn();
const setSourceSetting = vi.fn();
const getNode = vi.fn();
const setNodeFavorite = vi.fn();

vi.mock('../../services/database.js', () => ({
  default: {
    settings: {
      getSetting: (...args: unknown[]) => getSetting(...args),
      getSettingForSource: (...args: unknown[]) => getSettingForSource(...args),
      setSourceSetting: (...args: unknown[]) => setSourceSetting(...args),
    },
    nodes: {
      getNode: (...args: unknown[]) => getNode(...args),
      setNodeFavorite: (...args: unknown[]) => setNodeFavorite(...args),
    },
  },
}));

const createSetFavoriteNodeMessage = vi.fn();
const createRemoveFavoriteNodeMessage = vi.fn();

vi.mock('../protobufService.js', () => ({
  default: {
    createSetFavoriteNodeMessage: (...args: unknown[]) => createSetFavoriteNodeMessage(...args),
    createRemoveFavoriteNodeMessage: (...args: unknown[]) => createRemoveFavoriteNodeMessage(...args),
  },
}));

import { FavoritesService } from './favoritesService.js';

const ROUTER = 2; // DeviceRole.ROUTER — an AUTO_FAVORITE_LOCAL_ROLES + ZERO_HOP_RELAY_ROLES member

/** Minimal fake implementing only what FavoritesService touches on the manager. */
function makeFakeManager(overrides: Partial<{
  sourceId: string;
  favoritesSupportCache: { version: string; result: boolean } | null;
  transportReady: boolean;
  deviceConnected: boolean;
  localNodeInfo: { nodeNum: number; firmwareVersion?: string } | null;
  sessionPasskey: Uint8Array | null;
}> = {}) {
  const state = {
    sourceId: overrides.sourceId ?? 'src-1',
    favoritesSupportCache: overrides.favoritesSupportCache === undefined ? null : overrides.favoritesSupportCache,
    transportReady: overrides.transportReady ?? true,
    deviceConnected: overrides.deviceConnected ?? true,
    localNodeInfo: overrides.localNodeInfo === undefined ? { nodeNum: 111, firmwareVersion: '2.7.24' } : overrides.localNodeInfo,
    autoFavoritingNodes: new Set<number>(),
  };

  const parseFirmwareVersion = vi.fn((versionString: string) => {
    const match = versionString.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!match) return null;
    return { major: parseInt(match[1], 10), minor: parseInt(match[2], 10), patch: parseInt(match[3], 10) };
  });

  return {
    state,
    sourceId: state.sourceId,
    getFavoritesSupportCache: vi.fn(() => state.favoritesSupportCache),
    setFavoritesSupportCache: vi.fn((v: { version: string; result: boolean } | null) => { state.favoritesSupportCache = v; }),
    parseFirmwareVersion,
    isTransportReady: vi.fn(() => state.transportReady),
    isDeviceConnected: vi.fn(() => state.deviceConnected),
    getLocalNodeInfo: vi.fn(() => state.localNodeInfo),
    getSessionPasskey: vi.fn(() => overrides.sessionPasskey ?? null),
    requestRemoteSessionPasskey: vi.fn().mockResolvedValue(new Uint8Array([9, 9])),
    localNodeSettingKey: vi.fn((base: string) => base),
    isAutoFavoritingNode: vi.fn((n: number) => state.autoFavoritingNodes.has(n)),
    addAutoFavoritingNode: vi.fn((n: number) => state.autoFavoritingNodes.add(n)),
    removeAutoFavoritingNode: vi.fn((n: number) => state.autoFavoritingNodes.delete(n)),
  };
}

function makeFakeAdminTx() {
  return {
    sendAdminCommand: vi.fn().mockResolvedValue(undefined),
    sendAdminCommandAwaitAck: vi.fn().mockResolvedValue({ packetId: 1, acked: true, errorReason: 0, timedOut: false }),
  };
}

/**
 * checkAutoFavorite/autoFavoriteSweep call `this.mgr.supportsFavorites()` /
 * `this.mgr.sendFavoriteNode()` / `this.mgr.sendRemoveFavoriteNode()` (the
 * manager's public delegates) rather than their own sibling methods — see
 * favoritesService.ts's header comment. The real MeshtasticManager wires
 * those delegates back to the same FavoritesService instance; mirror that
 * circular wiring here so fakes behave like the real manager (and so a test
 * can still override `mgr.supportsFavorites` etc. afterward, exactly like
 * meshtasticManager.autoFavorite.perSource.test.ts does on the real manager).
 */
function wireCircular(mgr: ReturnType<typeof makeFakeManager>, svc: FavoritesService) {
  (mgr as any).supportsFavorites = vi.fn(() => svc.supportsFavorites());
  (mgr as any).sendFavoriteNode = vi.fn((n: number, d?: number) => svc.sendFavoriteNode(n, d));
  (mgr as any).sendRemoveFavoriteNode = vi.fn((n: number, d?: number) => svc.sendRemoveFavoriteNode(n, d));
}

beforeEach(() => {
  getSetting.mockReset();
  getSettingForSource.mockReset();
  setSourceSetting.mockReset().mockResolvedValue(undefined);
  getNode.mockReset();
  setNodeFavorite.mockReset().mockResolvedValue(undefined);
  createSetFavoriteNodeMessage.mockReset().mockReturnValue(new Uint8Array([1]));
  createRemoveFavoriteNodeMessage.mockReset().mockReturnValue(new Uint8Array([2]));
});

describe('FavoritesService.supportsFavorites — version-keyed cache (mirrors meshtasticManager.favoritesSupport.test.ts)', () => {
  it('returns true for 2.7.24 and populates the manager-owned cache', () => {
    const mgr = makeFakeManager();
    const svc = new FavoritesService(mgr as any, makeFakeAdminTx() as any);

    expect(svc.supportsFavorites()).toBe(true);
    expect(mgr.setFavoritesSupportCache).toHaveBeenCalledWith({ version: '2.7.24', result: true });
  });

  it('returns false for pre-2.7.0 firmware', () => {
    const mgr = makeFakeManager({ localNodeInfo: { nodeNum: 111, firmwareVersion: '2.6.9' } });
    const svc = new FavoritesService(mgr as any, makeFakeAdminTx() as any);
    expect(svc.supportsFavorites()).toBe(false);
  });

  it('returns false WITHOUT caching when firmware is unknown', () => {
    const mgr = makeFakeManager({ localNodeInfo: { nodeNum: 111, firmwareVersion: undefined } });
    const svc = new FavoritesService(mgr as any, makeFakeAdminTx() as any);
    expect(svc.supportsFavorites()).toBe(false);
    expect(mgr.setFavoritesSupportCache).not.toHaveBeenCalled();
  });

  it('serves from the manager-owned cache on a version hit (no re-parse)', () => {
    const mgr = makeFakeManager({ favoritesSupportCache: { version: '2.7.24', result: true } });
    const svc = new FavoritesService(mgr as any, makeFakeAdminTx() as any);

    expect(svc.supportsFavorites()).toBe(true);
    expect(mgr.parseFirmwareVersion).not.toHaveBeenCalled();
  });

  it('re-parses when the cached version differs from the live firmware version', () => {
    const mgr = makeFakeManager({ favoritesSupportCache: { version: '2.6.5', result: false } });
    const svc = new FavoritesService(mgr as any, makeFakeAdminTx() as any); // live firmware = 2.7.24
    expect(svc.supportsFavorites()).toBe(true);
    expect(mgr.parseFirmwareVersion).toHaveBeenCalledWith('2.7.24');
  });
});

describe('FavoritesService.sendFavoriteNode / sendRemoveFavoriteNode — delegation', () => {
  it('throws without building/sending anything when the transport is not ready', async () => {
    const mgr = makeFakeManager({ transportReady: false });
    const adminTx = makeFakeAdminTx();
    const svc = new FavoritesService(mgr as any, adminTx as any);

    await expect(svc.sendFavoriteNode(5)).rejects.toThrow('Not connected to Meshtastic node');
    expect(adminTx.sendAdminCommand).not.toHaveBeenCalled();
  });

  it('throws FIRMWARE_NOT_SUPPORTED on unsupported firmware', async () => {
    const mgr = makeFakeManager({ localNodeInfo: { nodeNum: 111, firmwareVersion: '2.6.9' } });
    const adminTx = makeFakeAdminTx();
    const svc = new FavoritesService(mgr as any, adminTx as any);

    await expect(svc.sendFavoriteNode(5)).rejects.toThrow('FIRMWARE_NOT_SUPPORTED');
  });

  it('sends locally (no session passkey lookup) when destinationNodeNum is omitted', async () => {
    const mgr = makeFakeManager();
    const adminTx = makeFakeAdminTx();
    const svc = new FavoritesService(mgr as any, adminTx as any);

    await svc.sendFavoriteNode(5);
    expect(createSetFavoriteNodeMessage).toHaveBeenCalledWith(5, new Uint8Array());
    expect(adminTx.sendAdminCommand).toHaveBeenCalledWith(expect.any(Uint8Array), 111);
    expect(mgr.getSessionPasskey).not.toHaveBeenCalled();
  });

  it('uses a cached session passkey for a remote destination', async () => {
    const passkey = new Uint8Array([7, 7, 7]);
    const mgr = makeFakeManager({ sessionPasskey: passkey });
    const adminTx = makeFakeAdminTx();
    const svc = new FavoritesService(mgr as any, adminTx as any);

    await svc.sendFavoriteNode(5, 222);
    expect(createSetFavoriteNodeMessage).toHaveBeenCalledWith(5, passkey);
    expect(adminTx.sendAdminCommand).toHaveBeenCalledWith(expect.any(Uint8Array), 222);
    expect(mgr.requestRemoteSessionPasskey).not.toHaveBeenCalled();
  });

  it('requests a session passkey for a remote destination when none is cached', async () => {
    const mgr = makeFakeManager();
    const adminTx = makeFakeAdminTx();
    const svc = new FavoritesService(mgr as any, adminTx as any);

    await svc.sendFavoriteNode(5, 222);
    expect(mgr.requestRemoteSessionPasskey).toHaveBeenCalledWith(222);
  });

  it('throws when the remote session passkey request fails', async () => {
    const mgr = makeFakeManager();
    mgr.requestRemoteSessionPasskey.mockResolvedValue(null);
    const adminTx = makeFakeAdminTx();
    const svc = new FavoritesService(mgr as any, adminTx as any);

    await expect(svc.sendFavoriteNode(5, 222)).rejects.toThrow('Failed to obtain session passkey for remote node 222');
  });

  it('sendRemoveFavoriteNode builds a remove message and delegates to AdminTransactionService', async () => {
    const mgr = makeFakeManager();
    const adminTx = makeFakeAdminTx();
    const svc = new FavoritesService(mgr as any, adminTx as any);

    await svc.sendRemoveFavoriteNode(5);
    expect(createRemoveFavoriteNodeMessage).toHaveBeenCalledWith(5, new Uint8Array());
    expect(adminTx.sendAdminCommand).toHaveBeenCalledWith(expect.any(Uint8Array), 111);
  });
});

describe('FavoritesService.sendFavoriteNodeAwaitAck — delegation to AdminTransactionService', () => {
  it('throws FIRMWARE_NOT_SUPPORTED before touching AdminTransactionService', async () => {
    const mgr = makeFakeManager({ localNodeInfo: { nodeNum: 111, firmwareVersion: '2.6.9' } });
    const adminTx = makeFakeAdminTx();
    const svc = new FavoritesService(mgr as any, adminTx as any);

    await expect(svc.sendFavoriteNodeAwaitAck(5)).rejects.toThrow('FIRMWARE_NOT_SUPPORTED');
    expect(adminTx.sendAdminCommandAwaitAck).not.toHaveBeenCalled();
  });

  it('delegates to AdminTransactionService.sendAdminCommandAwaitAck and returns its ack shape (minus packetId)', async () => {
    const mgr = makeFakeManager();
    const adminTx = makeFakeAdminTx();
    adminTx.sendAdminCommandAwaitAck.mockResolvedValue({ packetId: 42, acked: false, errorReason: 5, timedOut: false });
    const svc = new FavoritesService(mgr as any, adminTx as any);

    const result = await svc.sendFavoriteNodeAwaitAck(5, 222, 1234);
    expect(adminTx.sendAdminCommandAwaitAck).toHaveBeenCalledWith(expect.any(Uint8Array), 222, 1234);
    expect(result).toEqual({ acked: false, errorReason: 5, timedOut: false });
  });
});

describe('FavoritesService.checkAutoFavorite', () => {
  function enable() {
    getSettingForSource.mockImplementation(async (_src: string, key: string) => {
      if (key === 'autoFavoriteEnabled') return 'true';
      if (key === 'autoFavoriteNodes') return '[]';
      return null;
    });
    getSetting.mockResolvedValue(null); // no persisted localNodeNum override
  }

  it('no-ops when auto-favorite is disabled', async () => {
    getSettingForSource.mockResolvedValue(null);
    getSetting.mockResolvedValue(null);
    const mgr = makeFakeManager();
    const svc = new FavoritesService(mgr as any, makeFakeAdminTx() as any);
    wireCircular(mgr, svc);

    await svc.checkAutoFavorite(5, '!00000005');
    expect(getNode).not.toHaveBeenCalled();
  });

  it('no-ops when firmware does not support favorites', async () => {
    enable();
    const mgr = makeFakeManager({ localNodeInfo: { nodeNum: 111, firmwareVersion: '2.6.9' } });
    const svc = new FavoritesService(mgr as any, makeFakeAdminTx() as any);
    wireCircular(mgr, svc);

    await svc.checkAutoFavorite(5, '!00000005');
    expect(getNode).not.toHaveBeenCalled();
  });

  it('skips a node already being auto-favorited (re-entrancy guard)', async () => {
    enable();
    const mgr = makeFakeManager();
    mgr.isAutoFavoritingNode.mockReturnValue(true);
    const svc = new FavoritesService(mgr as any, makeFakeAdminTx() as any);
    wireCircular(mgr, svc);

    await svc.checkAutoFavorite(5, '!00000005');
    expect(getNode).not.toHaveBeenCalled();
  });

  it('auto-favorites an eligible 0-hop node: marks in DB, syncs to device, tracks it, then clears the in-flight marker', async () => {
    enable();
    getNode.mockImplementation(async (nodeNum: number) => {
      if (nodeNum === 111) return { role: ROUTER }; // local node
      if (nodeNum === 5) return { role: ROUTER, hopsAway: 0, viaMqtt: false, isFavorite: false, favoriteLocked: false };
      return null;
    });
    const mgr = makeFakeManager();
    const adminTx = makeFakeAdminTx();
    const svc = new FavoritesService(mgr as any, adminTx as any);
    wireCircular(mgr, svc);

    await svc.checkAutoFavorite(5, '!00000005');

    expect(mgr.addAutoFavoritingNode).toHaveBeenCalledWith(5);
    expect(setNodeFavorite).toHaveBeenCalledWith(5, true, 'src-1', false);
    expect(adminTx.sendAdminCommand).toHaveBeenCalled(); // via sendFavoriteNode
    expect(setSourceSetting).toHaveBeenCalledWith('src-1', 'autoFavoriteNodes', JSON.stringify([5]));
    // finally-block cleanup always runs, success or failure.
    expect(mgr.removeAutoFavoritingNode).toHaveBeenCalledWith(5);
  });

  it('still marks in DB and updates tracking even when the device sync fails', async () => {
    enable();
    getNode.mockImplementation(async (nodeNum: number) => {
      if (nodeNum === 111) return { role: ROUTER };
      if (nodeNum === 5) return { role: ROUTER, hopsAway: 0, viaMqtt: false, isFavorite: false, favoriteLocked: false };
      return null;
    });
    const mgr = makeFakeManager();
    const adminTx = makeFakeAdminTx();
    adminTx.sendAdminCommand.mockRejectedValue(new Error('device unreachable'));
    const svc = new FavoritesService(mgr as any, adminTx as any);
    wireCircular(mgr, svc);

    await svc.checkAutoFavorite(5, '!00000005');

    expect(setNodeFavorite).toHaveBeenCalledWith(5, true, 'src-1', false);
    expect(setSourceSetting).toHaveBeenCalledWith('src-1', 'autoFavoriteNodes', JSON.stringify([5]));
    expect(mgr.removeAutoFavoritingNode).toHaveBeenCalledWith(5);
  });

  it('skips a target with favoriteLocked=true', async () => {
    enable();
    getNode.mockImplementation(async (nodeNum: number) => {
      if (nodeNum === 111) return { role: ROUTER };
      if (nodeNum === 5) return { role: ROUTER, hopsAway: 0, favoriteLocked: true };
      return null;
    });
    const mgr = makeFakeManager();
    const adminTx = makeFakeAdminTx();
    const svc = new FavoritesService(mgr as any, adminTx as any);
    wireCircular(mgr, svc);

    await svc.checkAutoFavorite(5, '!00000005');
    expect(setNodeFavorite).not.toHaveBeenCalled();
    expect(adminTx.sendAdminCommand).not.toHaveBeenCalled();
  });
});

describe('FavoritesService.autoFavoriteSweep — re-entrancy guard', () => {
  it('a second concurrent call is a no-op while the first is still in flight', async () => {
    getSettingForSource.mockImplementation(async (_src: string, key: string) => {
      if (key === 'autoFavoriteEnabled') return 'true';
      if (key === 'autoFavoriteNodes') return '[]';
      return null;
    });
    const mgr = makeFakeManager();
    const svc = new FavoritesService(mgr as any, makeFakeAdminTx() as any);

    const p1 = svc.autoFavoriteSweep();
    const p2 = svc.autoFavoriteSweep(); // must return immediately, guard still held by p1
    await Promise.all([p1, p2]);

    // Empty tracking list short-circuits after exactly one settings read per
    // call if NOT guarded — the guard means the second call does nothing at
    // all, so getSettingForSource('autoFavoriteNodes') fires only once.
    const trackingListReads = getSettingForSource.mock.calls.filter(([, key]) => key === 'autoFavoriteNodes').length;
    expect(trackingListReads).toBe(1);
  });

  it('runs again (guard released) on a subsequent call after the first completes', async () => {
    getSettingForSource.mockImplementation(async (_src: string, key: string) => {
      if (key === 'autoFavoriteEnabled') return 'true';
      if (key === 'autoFavoriteNodes') return '[]';
      return null;
    });
    const mgr = makeFakeManager();
    const svc = new FavoritesService(mgr as any, makeFakeAdminTx() as any);

    await svc.autoFavoriteSweep();
    await svc.autoFavoriteSweep();

    const trackingListReads = getSettingForSource.mock.calls.filter(([, key]) => key === 'autoFavoriteNodes').length;
    expect(trackingListReads).toBe(2);
  });

  it('cleans up (unfavorites) all tracked nodes when the feature has been disabled, skipping locked ones', async () => {
    getSettingForSource.mockImplementation(async (_src: string, key: string) => {
      if (key === 'autoFavoriteEnabled') return 'false';
      if (key === 'autoFavoriteNodes') return JSON.stringify([5, 6]);
      return null;
    });
    getNode.mockImplementation(async (nodeNum: number) => {
      if (nodeNum === 5) return { favoriteLocked: false };
      if (nodeNum === 6) return { favoriteLocked: true };
      return null;
    });
    const mgr = makeFakeManager();
    const adminTx = makeFakeAdminTx();
    const svc = new FavoritesService(mgr as any, adminTx as any);
    wireCircular(mgr, svc);

    await svc.autoFavoriteSweep();

    expect(setNodeFavorite).toHaveBeenCalledWith(5, false, 'src-1', false);
    expect(setNodeFavorite).not.toHaveBeenCalledWith(6, false, 'src-1', false); // locked, skipped
    expect(adminTx.sendAdminCommand).toHaveBeenCalledTimes(1); // only for node 5
    expect(setSourceSetting).toHaveBeenCalledWith('src-1', 'autoFavoriteNodes', '[]');
  });

  it('removes a stale (not-heard-recently) tracked node and updates the remaining list', async () => {
    getSettingForSource.mockImplementation(async (_src: string, key: string) => {
      if (key === 'autoFavoriteEnabled') return 'true';
      if (key === 'autoFavoriteNodes') return JSON.stringify([5]);
      if (key === 'autoFavoriteStaleHours') return '72';
      return null;
    });
    getSetting.mockResolvedValue(null);
    getNode.mockImplementation(async (nodeNum: number) => {
      if (nodeNum === 5) {
        return {
          nodeId: '!00000005',
          favoriteLocked: false,
          lastHeard: 1, // truthy but ancient epoch second -> stale (note: `node.lastHeard && ...` treats 0 as "unknown", not "stale")
          hopsAway: 0,
          viaMqtt: false,
        };
      }
      return null;
    });
    const mgr = makeFakeManager();
    const adminTx = makeFakeAdminTx();
    const svc = new FavoritesService(mgr as any, adminTx as any);
    wireCircular(mgr, svc);

    await svc.autoFavoriteSweep();

    expect(setNodeFavorite).toHaveBeenCalledWith(5, false, 'src-1', false);
    expect(adminTx.sendAdminCommand).toHaveBeenCalled(); // sendRemoveFavoriteNode -> AdminTransactionService
    expect(setSourceSetting).toHaveBeenCalledWith('src-1', 'autoFavoriteNodes', JSON.stringify([]));
  });
});

// ─── Likely-aircraft Auto-Favorite exclusion (#5364/#5365 Phase 1 WP3) ───────
//
// `checkAutoFavorite`'s add-side gate + `autoFavoriteSweep`'s two-strike
// removal (D19, spec §4.11). A "healthy" tracked node (0-hop, RF, recently
// heard, not locked) is used as the baseline so ONLY the aircraft path can
// drive `shouldRemove` — every other sweep reason is deliberately absent.

describe('FavoritesService — likely-aircraft exclusion: checkAutoFavorite gate', () => {
  function enableAutoFavorite(overrides: Record<string, string | null> = {}) {
    const settings: Record<string, string | null> = {
      autoFavoriteEnabled: 'true',
      autoFavoriteNodes: '[]',
      aircraftDetectionEnabled: 'true',
      autoFavoriteExcludeAircraft: 'true',
      ...overrides,
    };
    getSettingForSource.mockImplementation(async (_src: string, key: string) => settings[key] ?? null);
    getSetting.mockResolvedValue(null);
  }

  function eligibleAircraftTarget(overrides: Record<string, unknown> = {}) {
    return {
      role: ROUTER, hopsAway: 0, viaMqtt: false, isFavorite: false, favoriteLocked: false,
      likelyAircraft: true,
      ...overrides,
    };
  }

  it('skips a flagged target when the exclusion is active (both switches on, the default)', async () => {
    enableAutoFavorite();
    getNode.mockImplementation(async (nodeNum: number) => {
      if (nodeNum === 111) return { role: ROUTER };
      if (nodeNum === 5) return eligibleAircraftTarget();
      return null;
    });
    const mgr = makeFakeManager();
    const svc = new FavoritesService(mgr as any, makeFakeAdminTx() as any);
    wireCircular(mgr, svc);

    await svc.checkAutoFavorite(5, '!00000005');

    expect(setNodeFavorite).not.toHaveBeenCalled();
    expect(mgr.addAutoFavoritingNode).not.toHaveBeenCalled();
  });

  it('favorites a flagged target when autoFavoriteExcludeAircraft is off', async () => {
    enableAutoFavorite({ autoFavoriteExcludeAircraft: 'false' });
    getNode.mockImplementation(async (nodeNum: number) => {
      if (nodeNum === 111) return { role: ROUTER };
      if (nodeNum === 5) return eligibleAircraftTarget();
      return null;
    });
    const mgr = makeFakeManager();
    const svc = new FavoritesService(mgr as any, makeFakeAdminTx() as any);
    wireCircular(mgr, svc);

    await svc.checkAutoFavorite(5, '!00000005');

    expect(setNodeFavorite).toHaveBeenCalledWith(5, true, 'src-1', false);
  });

  it('favorites a flagged target when aircraftDetectionEnabled is off', async () => {
    enableAutoFavorite({ aircraftDetectionEnabled: 'false' });
    getNode.mockImplementation(async (nodeNum: number) => {
      if (nodeNum === 111) return { role: ROUTER };
      if (nodeNum === 5) return eligibleAircraftTarget();
      return null;
    });
    const mgr = makeFakeManager();
    const svc = new FavoritesService(mgr as any, makeFakeAdminTx() as any);
    wireCircular(mgr, svc);

    await svc.checkAutoFavorite(5, '!00000005');

    expect(setNodeFavorite).toHaveBeenCalledWith(5, true, 'src-1', false);
  });

  it('favorites a non-flagged target normally (exclusion active but likelyAircraft is not true)', async () => {
    enableAutoFavorite();
    getNode.mockImplementation(async (nodeNum: number) => {
      if (nodeNum === 111) return { role: ROUTER };
      if (nodeNum === 5) return eligibleAircraftTarget({ likelyAircraft: null });
      return null;
    });
    const mgr = makeFakeManager();
    const svc = new FavoritesService(mgr as any, makeFakeAdminTx() as any);
    wireCircular(mgr, svc);

    await svc.checkAutoFavorite(5, '!00000005');

    expect(setNodeFavorite).toHaveBeenCalledWith(5, true, 'src-1', false);
  });
});

describe('FavoritesService — likely-aircraft exclusion: autoFavoriteSweep two-strike removal (D19)', () => {
  const NODE = 7000000001;
  const T0 = 1_700_000_000_000; // arbitrary fixed epoch ms
  const GAP_45MIN = 45 * 60_000;

  /** A healthy 0-hop RF node so only the aircraft path can drive removal. */
  function healthyTrackedNode(overrides: Record<string, unknown> = {}) {
    return {
      nodeNum: NODE,
      nodeId: '!'+NODE.toString(16).padStart(8, '0'),
      longName: 'Plane?',
      favoriteLocked: false,
      hopsAway: 0,
      viaMqtt: false,
      lastHeard: Math.floor(Date.now() / 1000),
      likelyAircraft: true,
      aircraftBasis: 'agl',
      heightAboveGround: 3000,
      altitude: 3500,
      ...overrides,
    };
  }

  /** Stateful settings store shared by getSettingForSource/setSourceSetting for one test. */
  function makeStore(overrides: Record<string, string | null> = {}) {
    const store: Record<string, string | null> = {
      autoFavoriteEnabled: 'true',
      autoFavoriteNodes: JSON.stringify([NODE]),
      autoFavoriteStaleHours: '72',
      aircraftDetectionEnabled: 'true',
      autoFavoriteExcludeAircraft: 'true',
      autoFavoriteAircraftStrikes: '{}',
      ...overrides,
    };
    getSettingForSource.mockImplementation(async (_src: string, key: string) => store[key] ?? null);
    setSourceSetting.mockImplementation(async (_src: string, key: string, value: string) => { store[key] = value; });
    getSetting.mockResolvedValue(null);
    return store;
  }

  function makeSweepSvc(nodeOverrides: Record<string, unknown> = {}) {
    getNode.mockImplementation(async (nodeNum: number) => {
      if (nodeNum === NODE) return healthyTrackedNode(nodeOverrides);
      return null;
    });
    const mgr = makeFakeManager();
    const adminTx = makeFakeAdminTx();
    const svc = new FavoritesService(mgr as any, adminTx as any);
    wireCircular(mgr, svc);
    return { svc, mgr, adminTx };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('(a) flagged once → kept, one strike persisted', async () => {
    const store = makeStore();
    const { svc } = makeSweepSvc();

    await svc.autoFavoriteSweep();

    expect(setNodeFavorite).not.toHaveBeenCalledWith(NODE, false, 'src-1', false);
    expect(JSON.parse(store.autoFavoriteAircraftStrikes!)).toEqual({ [String(NODE)]: { count: 1, lastAt: T0 } });
  });

  it('(b) flagged at T and T+60min → removed at the second sweep, reason names the aircraft', async () => {
    const store = makeStore();
    const { svc } = makeSweepSvc();

    await svc.autoFavoriteSweep(); // T: strike 1, kept
    expect(setNodeFavorite).not.toHaveBeenCalledWith(NODE, false, 'src-1', false);

    vi.setSystemTime(T0 + 60 * 60_000);
    await svc.autoFavoriteSweep(); // T+60min: strike 2, removed

    expect(setNodeFavorite).toHaveBeenCalledWith(NODE, false, 'src-1', false);
    expect(JSON.parse(store.autoFavoriteNodes!)).toEqual([]);
    expect(JSON.parse(store.autoFavoriteAircraftStrikes!)).toEqual({});
  });

  it('(c) restart in between: fresh service instance still removes at T+60min (strike survives)', async () => {
    makeStore();
    const first = makeSweepSvc();
    await first.svc.autoFavoriteSweep(); // T: strike 1 on instance A

    vi.setSystemTime(T0 + 60 * 60_000);
    // A brand-new FavoritesService instance — same settings store (same mocks) — simulates a restart.
    const second = makeSweepSvc();
    await second.svc.autoFavoriteSweep(); // T+60min: strike 2 on instance B, removed

    expect(setNodeFavorite).toHaveBeenCalledWith(NODE, false, 'src-1', false);
  });

  it('(d) a settings save in between (POST drops the strikes key) does not reset the streak', async () => {
    const store = makeStore();
    const { svc } = makeSweepSvc();
    await svc.autoFavoriteSweep(); // T: strike 1

    // Simulate the settings route: a POST body containing `autoFavoriteAircraftStrikes`
    // is dropped server-side (not in VALID_SETTINGS_KEYS) — nothing calls
    // setSourceSetting for that key, so the store value is untouched.
    expect(JSON.parse(store.autoFavoriteAircraftStrikes!)).toEqual({ [String(NODE)]: { count: 1, lastAt: T0 } });

    vi.setSystemTime(T0 + 60 * 60_000);
    await svc.autoFavoriteSweep(); // T+60min: strike 2, removed

    expect(setNodeFavorite).toHaveBeenCalledWith(NODE, false, 'src-1', false);
  });

  it('(e) flagged at T, cleared at T+60min, flagged again at T+120min → kept (streak reset by the clear)', async () => {
    makeStore();
    getNode.mockImplementation(async (nodeNum: number) => {
      if (nodeNum !== NODE) return null;
      const now = Date.now();
      if (now === T0 + 60 * 60_000) return healthyTrackedNode({ likelyAircraft: false, aircraftBasis: null });
      return healthyTrackedNode();
    });
    const mgr = makeFakeManager();
    const svc = new FavoritesService(mgr as any, makeFakeAdminTx() as any);
    wireCircular(mgr, svc);

    await svc.autoFavoriteSweep(); // T: strike 1
    vi.setSystemTime(T0 + 60 * 60_000);
    await svc.autoFavoriteSweep(); // T+60min: not flagged, strike cleared
    vi.setSystemTime(T0 + 120 * 60_000);
    await svc.autoFavoriteSweep(); // T+120min: flagged again, back to strike 1

    expect(setNodeFavorite).not.toHaveBeenCalledWith(NODE, false, 'src-1', false);
  });

  it('(f) a boot/reconnect sweep 1 minute after the first does not add a second strike', async () => {
    const store = makeStore();
    const { svc } = makeSweepSvc();
    await svc.autoFavoriteSweep(); // T: strike 1

    vi.setSystemTime(T0 + 60_000); // 1 minute later — well under the 45-min gap
    await svc.autoFavoriteSweep();

    expect(JSON.parse(store.autoFavoriteAircraftStrikes!)).toEqual({ [String(NODE)]: { count: 1, lastAt: T0 } });
    expect(setNodeFavorite).not.toHaveBeenCalledWith(NODE, false, 'src-1', false);
  });

  it('(g) a favoriteLocked flagged node is never struck and never removed', async () => {
    const store = makeStore();
    getNode.mockImplementation(async (nodeNum: number) => {
      if (nodeNum === NODE) return healthyTrackedNode({ favoriteLocked: true });
      return null;
    });
    const mgr = makeFakeManager();
    const svc = new FavoritesService(mgr as any, makeFakeAdminTx() as any);
    wireCircular(mgr, svc);

    await svc.autoFavoriteSweep();
    vi.setSystemTime(T0 + GAP_45MIN);
    await svc.autoFavoriteSweep();

    expect(setNodeFavorite).not.toHaveBeenCalled();
    expect(JSON.parse(store.autoFavoriteAircraftStrikes!)).toEqual({});
  });

  it('(h) a user favourite NOT in autoFavoriteNodes with the flag is untouched — the sweep only iterates the tracked list', async () => {
    const OTHER = 7000000003;
    const store = makeStore(); // autoFavoriteNodes = [NODE] only; OTHER is a manual/user favourite
    getNode.mockImplementation(async (nodeNum: number) => {
      if (nodeNum === NODE) return healthyTrackedNode({ likelyAircraft: false, aircraftBasis: null }); // keep NODE inert this sweep
      if (nodeNum === OTHER) return healthyTrackedNode({ nodeNum: OTHER, likelyAircraft: true }); // never visited
      return null;
    });
    const mgr = makeFakeManager();
    const svc = new FavoritesService(mgr as any, makeFakeAdminTx() as any);
    wireCircular(mgr, svc);

    await svc.autoFavoriteSweep();

    expect(getNode).not.toHaveBeenCalledWith(OTHER, 'src-1');
    expect(setNodeFavorite).not.toHaveBeenCalledWith(OTHER, false, 'src-1', false);
    expect(JSON.parse(store.autoFavoriteAircraftStrikes!)[String(OTHER)]).toBeUndefined();
  });

  it('(i) switching the exclusion off clears all strikes at the next sweep; switching back on needs two fresh sweeps', async () => {
    const store = makeStore();
    const { svc } = makeSweepSvc();
    await svc.autoFavoriteSweep(); // T: strike 1
    expect(JSON.parse(store.autoFavoriteAircraftStrikes!)).toEqual({ [String(NODE)]: { count: 1, lastAt: T0 } });

    store.autoFavoriteExcludeAircraft = 'false';
    vi.setSystemTime(T0 + GAP_45MIN);
    await svc.autoFavoriteSweep(); // exclusion off → flagged=false for every node → strike deleted
    expect(JSON.parse(store.autoFavoriteAircraftStrikes!)).toEqual({});
    expect(setNodeFavorite).not.toHaveBeenCalledWith(NODE, false, 'src-1', false);

    store.autoFavoriteExcludeAircraft = 'true';
    vi.setSystemTime(T0 + 2 * GAP_45MIN);
    await svc.autoFavoriteSweep(); // fresh strike 1 (not yet 2)
    expect(JSON.parse(store.autoFavoriteAircraftStrikes!)).toEqual({ [String(NODE)]: { count: 1, lastAt: T0 + 2 * GAP_45MIN } });
    expect(setNodeFavorite).not.toHaveBeenCalledWith(NODE, false, 'src-1', false);

    vi.setSystemTime(T0 + 3 * GAP_45MIN);
    await svc.autoFavoriteSweep(); // second fresh sweep → removed
    expect(setNodeFavorite).toHaveBeenCalledWith(NODE, false, 'src-1', false);
  });

  it('(j) Auto-Favorite disabled resets strikes to {} alongside the tracking list', async () => {
    const store = makeStore();
    const { svc } = makeSweepSvc();
    await svc.autoFavoriteSweep(); // T: strike 1
    expect(JSON.parse(store.autoFavoriteAircraftStrikes!)).toEqual({ [String(NODE)]: { count: 1, lastAt: T0 } });

    store.autoFavoriteEnabled = 'false';
    vi.setSystemTime(T0 + GAP_45MIN);
    await svc.autoFavoriteSweep();

    expect(store.autoFavoriteAircraftStrikes).toBe('{}');
    expect(store.autoFavoriteNodes).toBe('[]');
  });

  it('(k) strike keys for nodes that left the provenance list are pruned', async () => {
    const OTHER = 7000000002;
    const store = makeStore({ autoFavoriteNodes: JSON.stringify([NODE, OTHER]) });
    getNode.mockImplementation(async (nodeNum: number) => {
      if (nodeNum === NODE) return healthyTrackedNode();
      if (nodeNum === OTHER) return healthyTrackedNode({ nodeNum: OTHER, likelyAircraft: false, aircraftBasis: null, lastHeard: 1 }); // stale → removed this sweep
      return null;
    });
    const mgr = makeFakeManager();
    const svc = new FavoritesService(mgr as any, makeFakeAdminTx() as any);
    wireCircular(mgr, svc);

    await svc.autoFavoriteSweep(); // NODE gets strike 1; OTHER is stale and removed this sweep

    expect(setNodeFavorite).toHaveBeenCalledWith(OTHER, false, 'src-1', false);
    const strikes = JSON.parse(store.autoFavoriteAircraftStrikes!);
    expect(strikes).toEqual({ [String(NODE)]: { count: 1, lastAt: T0 } });
    expect(strikes[String(OTHER)]).toBeUndefined();
  });
});
