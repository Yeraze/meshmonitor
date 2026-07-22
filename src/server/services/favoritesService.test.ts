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
