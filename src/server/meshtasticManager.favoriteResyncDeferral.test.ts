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
 * Favorite write-back deferral during the initial config sync (#5122).
 *
 * A reporter packet-captured this: MeshMonitor sent a `SetFavoriteNode` admin
 * packet WHILE the initial NodeDB sync was still streaming, the node stopped
 * ACKing that exact TCP segment, the OS retransmitted it 8 times over ~10-15s
 * with an unchanged sequence number, and the node then RST the connection. The
 * sync restarted from scratch and, on their ~190-node mesh, never completed —
 * reproduced in 3 of 4 clean runs. The same capture shows the identical packet
 * flowing fine outside the sync window, so the bug is WHEN we send it.
 *
 * The reconciliation itself is not in question: a `favoriteLocked` node's DB
 * value must still win immediately and locally. Only the admin write-back to
 * the device waits for `configComplete`.
 */
describe('MeshtasticManager — favorite write-back deferral (#5122)', () => {
  let mgr: any;
  let sent: Array<{ op: 'add' | 'remove'; nodeNum: number }>;

  const capturing = (on: boolean) => {
    mgr.isCapturingInitConfig = on;
    mgr.configCaptureComplete = !on;
  };

  beforeEach(() => {
    mgr = new MeshtasticManager('src-1', { host: '127.0.0.1', port: 4403 }) as any;
    sent = [];
    mgr.sendFavoriteNode = vi.fn(async (n: number) => { sent.push({ op: 'add', nodeNum: n }); });
    mgr.sendRemoveFavoriteNode = vi.fn(async (n: number) => { sent.push({ op: 'remove', nodeNum: n }); });
  });

  it('sends nothing to the device while the config sync is still running', async () => {
    capturing(true);
    mgr.queueFavoriteResync(111, '!0000006f', true);
    await Promise.resolve();

    expect(sent).toEqual([]);
    expect(mgr.pendingFavoriteResync.get(111)).toBe(true);
  });

  it('applies the deferred write-back once the sync completes', async () => {
    capturing(true);
    mgr.queueFavoriteResync(111, '!0000006f', true);
    mgr.queueFavoriteResync(222, '!000000de', false);

    capturing(false);
    await mgr.flushPendingFavoriteResyncs();

    expect(sent).toEqual([
      { op: 'add', nodeNum: 111 },
      { op: 'remove', nodeNum: 222 },
    ]);
    expect(mgr.pendingFavoriteResync.size).toBe(0);
  });

  it('collapses a node that flaps mid-sync into ONE write-back at its final value', async () => {
    // The old code fired per NodeInfo. A node reported repeatedly during a
    // large sync therefore produced a burst of admin packets — precisely the
    // load this defers.
    capturing(true);
    mgr.queueFavoriteResync(111, '!0000006f', true);
    mgr.queueFavoriteResync(111, '!0000006f', false);
    mgr.queueFavoriteResync(111, '!0000006f', true);

    capturing(false);
    await mgr.flushPendingFavoriteResyncs();

    expect(sent).toEqual([{ op: 'add', nodeNum: 111 }]);
  });

  it('sends immediately when no sync is in progress', async () => {
    capturing(false);
    mgr.queueFavoriteResync(111, '!0000006f', true);
    await new Promise((r) => setImmediate(r));

    expect(sent).toEqual([{ op: 'add', nodeNum: 111 }]);
    expect(mgr.pendingFavoriteResync.size).toBe(0);
  });

  it('coalesces repeat write-backs for the same node behind a cooldown', async () => {
    // Mirrors the ignore re-sync guard sitting directly below the call site: a
    // device that cannot durably hold the flag would otherwise earn an admin
    // command on every NodeInfo naming that node.
    capturing(false);
    await mgr.sendFavoriteResyncNow(111, '!0000006f', true);
    await mgr.sendFavoriteResyncNow(111, '!0000006f', true);

    expect(sent).toEqual([{ op: 'add', nodeNum: 111 }]);
  });

  it('does not let one node cooldown block a different node', async () => {
    capturing(false);
    await mgr.sendFavoriteResyncNow(111, '!0000006f', true);
    await mgr.sendFavoriteResyncNow(222, '!000000de', true);

    expect(sent).toHaveLength(2);
  });

  it('survives a send that throws, and still applies the rest of the queue', async () => {
    capturing(true);
    mgr.queueFavoriteResync(111, '!0000006f', true);
    mgr.queueFavoriteResync(222, '!000000de', true);
    mgr.sendFavoriteNode = vi.fn(async (n: number) => {
      if (n === 111) throw new Error('device busy');
      sent.push({ op: 'add', nodeNum: n });
    });

    capturing(false);
    await expect(mgr.flushPendingFavoriteResyncs()).resolves.toBeUndefined();
    expect(sent).toEqual([{ op: 'add', nodeNum: 222 }]);
  });

  it('drops queued write-backs when the sync dies mid-flight', async () => {
    // A sync that never reaches configComplete must not carry stale intents
    // into the next session — the device re-reports its own state on reconnect
    // and the reconciliation runs again from there.
    capturing(true);
    mgr.queueFavoriteResync(111, '!0000006f', true);
    expect(mgr.pendingFavoriteResync.size).toBe(1);

    await mgr.handleDisconnected();

    expect(mgr.pendingFavoriteResync.size).toBe(0);
    expect(sent).toEqual([]);
  });
});
