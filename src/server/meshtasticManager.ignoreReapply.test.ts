import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Auto-reapply of the ignore flag to the LOCAL connected node (#2601).
 *
 * A Meshtastic device's on-board ignore list is small; when its node database
 * fills up it drops ignores and reports the node as un-ignored on the next
 * NodeInfo. MeshMonitor's per-source ignore list is authoritative, so
 * processNodeInfoProtobuf must (a) keep the flag ignored in our DB and (b)
 * re-push the ignore to the locally-connected node — a local admin command with
 * no destination, so it never touches the mesh. A cooldown coalesces bursts when
 * a device can't durably hold the ignore.
 */

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
vi.mock('./virtualNodeServer.js', () => ({ VirtualNodeServer: VNConstructor }));

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

// Per-source blocklist mirror lives here; tests drive `blocklist`. Hoisted so the
// vi.mock factory below (also hoisted) can close over them.
const { blocklist, upsertNode, isIgnoredCached } = vi.hoisted(() => {
  const blocklist = new Set<number>();
  return {
    blocklist,
    upsertNode: vi.fn().mockResolvedValue(undefined),
    isIgnoredCached: vi.fn((nodeNum: number, _sourceId: string) => blocklist.has(nodeNum)),
  };
});

vi.mock('../services/database.js', () => {
  const shared = {
    waitForReady: vi.fn().mockResolvedValue(undefined),
    settings: {
      getSetting: vi.fn().mockResolvedValue(null),
      getSettingForSource: vi.fn().mockResolvedValue(null),
      setSetting: vi.fn().mockResolvedValue(undefined),
    },
    sources: { getSource: vi.fn().mockResolvedValue(null) },
    nodes: {
      getNode: vi.fn().mockResolvedValue(null),
      upsertNode,
      getActiveNodes: vi.fn().mockResolvedValue([]),
      getAllNodes: vi.fn().mockResolvedValue([]),
    },
    ignoredNodes: { isIgnoredCached },
  };
  return { default: shared, databaseService: shared };
});

vi.mock('./meshtasticProtobufService.js', () => {
  const svc = {
    getPortNumName: (n: number) => `PORT_${n}`,
    normalizePortNum: (n: any) => (typeof n === 'number' ? n : 0),
    convertCoordinates: (latI: number, lonI: number) => ({ latitude: latI / 1e7, longitude: lonI / 1e7 }),
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

describe('MeshtasticManager — re-apply ignore to local node (#2601)', () => {
  const NODE = 0x1234abcd;

  const seedManager = () => {
    const mgr = new MeshtasticManager('src-1', { host: '127.0.0.1', port: 4403 } as any) as any;
    mgr.isConnected = true;
    // Different from NODE so the local-node name branch is skipped.
    mgr.localNodeInfo = { nodeNum: 0xaabb, nodeId: '!0000aabb' };
    // Stub the device admin push so no real transport/protobuf is exercised.
    mgr.sendIgnoredNode = vi.fn().mockResolvedValue(undefined);
    return mgr;
  };

  beforeEach(() => {
    blocklist.clear();
    upsertNode.mockClear();
    isIgnoredCached.mockClear();
  });

  it('re-pushes the ignore to the local node when the device reports un-ignored', async () => {
    blocklist.add(NODE);
    const mgr = seedManager();

    await mgr.processNodeInfoProtobuf({ num: NODE, isIgnored: false });

    // Local admin command (no destination arg) — no mesh traffic.
    expect(mgr.sendIgnoredNode).toHaveBeenCalledTimes(1);
    expect(mgr.sendIgnoredNode).toHaveBeenCalledWith(NODE);
    // DB flag kept ignored regardless of what the device said.
    const persisted = upsertNode.mock.calls.at(-1)?.[0];
    expect(persisted.isIgnored).toBe(true);
  });

  it('does not push for a node that is not on the blocklist', async () => {
    const mgr = seedManager();

    await mgr.processNodeInfoProtobuf({ num: NODE, isIgnored: false });

    expect(mgr.sendIgnoredNode).not.toHaveBeenCalled();
    const persisted = upsertNode.mock.calls.at(-1)?.[0];
    expect(persisted.isIgnored).toBe(false);
  });

  it('does not push when the device already reports the node as ignored', async () => {
    blocklist.add(NODE);
    const mgr = seedManager();

    await mgr.processNodeInfoProtobuf({ num: NODE, isIgnored: true });

    expect(mgr.sendIgnoredNode).not.toHaveBeenCalled();
    const persisted = upsertNode.mock.calls.at(-1)?.[0];
    expect(persisted.isIgnored).toBe(true);
  });

  it('coalesces repeated re-pushes for the same node via cooldown', async () => {
    blocklist.add(NODE);
    const mgr = seedManager();

    await mgr.processNodeInfoProtobuf({ num: NODE, isIgnored: false });
    await mgr.processNodeInfoProtobuf({ num: NODE, isIgnored: false });

    // Two NodeInfos in quick succession → only one local admin command.
    expect(mgr.sendIgnoredNode).toHaveBeenCalledTimes(1);
    // ...but the DB flag is kept ignored on both passes.
    expect(upsertNode.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(upsertNode.mock.calls.at(-1)?.[0].isIgnored).toBe(true);
  });
});
