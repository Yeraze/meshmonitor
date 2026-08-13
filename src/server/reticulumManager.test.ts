/**
 * Tests for reticulumManager.ts (#3960 Phase 1a WP4).
 *
 * announce/interface_stats DB-write mapping is exercised by invoking the
 * manager's private handleAnnounce/handleInterfaceStats methods directly
 * (mirrors MeshCoreManager's contactPersistence.test.ts pattern) — this
 * proves the DB-mapping logic deterministically, without spinning up a real
 * bridge connection, while still using the real wire-protocol *types*
 * (AnnounceMessage / InterfaceStatsMessage) so a shape drift in
 * reticulumProtocol.ts would still be caught here.
 *
 * getStatus()/isConnected() connection-lifecycle transitions are exercised
 * against a real in-process WebSocket mock bridge (same helper style as
 * reticulumBridgeClient.test.ts), since that behavior genuinely depends on
 * ReticulumBridgeClient's own state machine, not just this manager's glue.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocketServer, type WebSocket as WSSocket } from 'ws';
import type {
  AnnounceMessage,
  FailureCode,
  InterfaceStatsEntry,
  InterfaceStatsMessage,
  StatusMessage,
  WelcomeMessage,
} from './reticulumProtocol.js';

const upsertDestination = vi.fn().mockResolvedValue(undefined);
const upsertInterface = vi.fn().mockResolvedValue(undefined);
const insertTelemetryBatch = vi.fn().mockResolvedValue(0);

vi.mock('../services/database.js', () => ({
  default: {
    reticulum: {
      upsertDestination: (...args: unknown[]) => upsertDestination(...args),
      upsertInterface: (...args: unknown[]) => upsertInterface(...args),
    },
    telemetry: {
      insertTelemetryBatch: (...args: unknown[]) => insertTelemetryBatch(...args),
    },
  },
}));

import { ReticulumManager } from './reticulumManager.js';
import { reticulumInterfaceNodeId, reticulumInterfaceNodeNum } from './services/reticulumTelemetry.js';

function makeAnnounce(overrides: Partial<AnnounceMessage> = {}): AnnounceMessage {
  return {
    v: 1,
    type: 'announce',
    ts: 1_700_000_000_000,
    destinationHash: 'abc123',
    identityHash: 'id-abc',
    appName: 'lxmf',
    aspects: ['delivery'],
    displayName: 'Alice',
    appDataB64: 'ZGF0YQ==',
    hops: 3,
    nextHopInterface: 'TCP Client',
    rssi: -80,
    snr: 4.5,
    q: 90,
    isPathResponse: false,
    ...overrides,
  };
}

function makeInterfaceStats(interfaces: InterfaceStatsEntry[], ts = 1_700_000_000_000): InterfaceStatsMessage {
  return { v: 1, type: 'interface_stats', ts, interfaces };
}

const IFACE_A: InterfaceStatsEntry = {
  name: 'TCP Client',
  type: 'TCPClientInterface',
  status: 'up',
  online: true,
  txBytes: 100,
  rxBytes: 50,
};

describe('ReticulumManager DB persistence', () => {
  beforeEach(() => {
    upsertDestination.mockClear();
    upsertInterface.mockClear();
    insertTelemetryBatch.mockClear();
  });

  it('announce -> upsertDestination with mapped fields (aspects joined, q renamed to quality)', async () => {
    const manager = new ReticulumManager('src-a', 'Source A');
    // @ts-expect-error - exercising the private handler directly
    await manager.handleAnnounce(makeAnnounce());

    expect(upsertDestination).toHaveBeenCalledTimes(1);
    expect(upsertDestination).toHaveBeenCalledWith('src-a', {
      destinationHash: 'abc123',
      identityHash: 'id-abc',
      appName: 'lxmf',
      aspects: 'delivery',
      displayName: 'Alice',
      appDataB64: 'ZGF0YQ==',
      hops: 3,
      nextHopInterface: 'TCP Client',
      rssi: -80,
      snr: 4.5,
      quality: 90,
      announceAt: 1_700_000_000_000,
    });
  });

  it('announce with multiple aspects joins them with "."', async () => {
    const manager = new ReticulumManager('src-a');
    // @ts-expect-error - exercising the private handler directly
    await manager.handleAnnounce(makeAnnounce({ appName: 'nomadnetwork', aspects: ['node', 'delivery'] }));
    expect(upsertDestination).toHaveBeenCalledWith('src-a', expect.objectContaining({ aspects: 'node.delivery' }));
  });

  it('announce with no aspects maps to null (not an empty string/array)', async () => {
    const manager = new ReticulumManager('src-a');
    // @ts-expect-error - exercising the private handler directly
    await manager.handleAnnounce(makeAnnounce({ aspects: [] }));
    expect(upsertDestination).toHaveBeenCalledWith('src-a', expect.objectContaining({ aspects: null }));

    upsertDestination.mockClear();
    // @ts-expect-error - exercising the private handler directly
    await manager.handleAnnounce(makeAnnounce({ aspects: null }));
    expect(upsertDestination).toHaveBeenCalledWith('src-a', expect.objectContaining({ aspects: null }));
  });

  it('interface_stats -> upsertInterface snapshot for every interface', async () => {
    const manager = new ReticulumManager('src-a');
    // @ts-expect-error - exercising the private handler directly
    await manager.handleInterfaceStats(makeInterfaceStats([IFACE_A]));

    expect(upsertInterface).toHaveBeenCalledTimes(1);
    expect(upsertInterface).toHaveBeenCalledWith('src-a', {
      interfaceName: 'TCP Client',
      interfaceType: 'TCPClientInterface',
      interfaceHash: null,
      mode: null,
      status: 'up',
      online: true,
      bitrate: null,
      txBytes: 100,
      rxBytes: 50,
      lastSeenAt: 1_700_000_000_000,
    });
  });

  it('a failed upsertInterface for one interface does not block persistence of the others', async () => {
    upsertInterface.mockRejectedValueOnce(new Error('db down')).mockResolvedValue(undefined);
    const manager = new ReticulumManager('src-a');
    const ifaceB: InterfaceStatsEntry = { ...IFACE_A, name: 'AutoInterface' };
    // @ts-expect-error - exercising the private handler directly
    await manager.handleInterfaceStats(makeInterfaceStats([IFACE_A, ifaceB]));
    expect(upsertInterface).toHaveBeenCalledTimes(2);
  });

  it('first interface_stats poll seeds the baseline but writes no telemetry history (nothing to diff against)', async () => {
    const manager = new ReticulumManager('src-a');
    // @ts-expect-error - exercising the private handler directly
    await manager.handleInterfaceStats(makeInterfaceStats([IFACE_A]));
    expect(insertTelemetryBatch).not.toHaveBeenCalled();
  });

  it('a second poll with advanced counters writes throttled tx/rx-rate rows', async () => {
    const manager = new ReticulumManager('src-a');
    // @ts-expect-error - exercising the private handler directly
    await manager.handleInterfaceStats(makeInterfaceStats([IFACE_A], 1_700_000_000_000));
    // +10s, +1000 tx bytes, +500 rx bytes -> 100 B/s tx, 50 B/s rx
    // @ts-expect-error - exercising the private handler directly
    await manager.handleInterfaceStats(
      makeInterfaceStats([{ ...IFACE_A, txBytes: 1100, rxBytes: 550 }], 1_700_000_010_000),
    );

    expect(insertTelemetryBatch).toHaveBeenCalledTimes(1);
    const [rows, sourceId] = insertTelemetryBatch.mock.calls[0];
    expect(sourceId).toBe('src-a');
    const nodeNum = reticulumInterfaceNodeNum('TCP Client');
    const nodeId = reticulumInterfaceNodeId('TCP Client');
    expect(rows).toEqual([
      expect.objectContaining({ nodeId, nodeNum, telemetryType: 'reticulum_iface_tx_rate', timestamp: 1_700_000_010_000, value: 100, unit: 'B/s' }),
      expect.objectContaining({ nodeId, nodeNum, telemetryType: 'reticulum_iface_rx_rate', timestamp: 1_700_000_010_000, value: 50, unit: 'B/s' }),
    ]);
  });

  it('an unchanged poll (identical counters) writes no telemetry history', async () => {
    const manager = new ReticulumManager('src-a');
    // @ts-expect-error - exercising the private handler directly
    await manager.handleInterfaceStats(makeInterfaceStats([IFACE_A], 1_700_000_000_000));
    // @ts-expect-error - exercising the private handler directly
    await manager.handleInterfaceStats(makeInterfaceStats([IFACE_A], 1_700_000_010_000));
    expect(insertTelemetryBatch).not.toHaveBeenCalled();
  });

  it('a counter reset (new value lower than previous) is treated as a fresh baseline, not a negative rate', async () => {
    const manager = new ReticulumManager('src-a');
    const highCounters: InterfaceStatsEntry = { ...IFACE_A, txBytes: 1000, rxBytes: 500 };
    // @ts-expect-error - exercising the private handler directly
    await manager.handleInterfaceStats(makeInterfaceStats([highCounters], 1_700_000_000_000));
    // Counters dropped (e.g. bridge process restarted) — must not fabricate a negative rate.
    // @ts-expect-error - exercising the private handler directly
    await manager.handleInterfaceStats(
      makeInterfaceStats([{ ...highCounters, txBytes: 10, rxBytes: 5 }], 1_700_000_010_000),
    );
    expect(insertTelemetryBatch).not.toHaveBeenCalled();

    // But the reset value is now the new baseline: the NEXT genuine advance writes history again.
    // @ts-expect-error - exercising the private handler directly
    await manager.handleInterfaceStats(
      makeInterfaceStats([{ ...highCounters, txBytes: 110, rxBytes: 55 }], 1_700_000_020_000),
    );
    expect(insertTelemetryBatch).toHaveBeenCalledTimes(1);
  });

  it('a telemetry write failure is swallowed (logged, not thrown)', async () => {
    insertTelemetryBatch.mockRejectedValueOnce(new Error('db down'));
    const manager = new ReticulumManager('src-a');
    // @ts-expect-error - exercising the private handler directly
    await manager.handleInterfaceStats(makeInterfaceStats([IFACE_A], 1_700_000_000_000));
    await expect(
      // @ts-expect-error - exercising the private handler directly
      manager.handleInterfaceStats(makeInterfaceStats([{ ...IFACE_A, txBytes: 1100, rxBytes: 550 }], 1_700_000_010_000)),
    ).resolves.toBeUndefined();
  });
});

describe('ReticulumManager bridge/RNS version caching (#3960 Phase 1b WP-B)', () => {
  function makeWelcome(overrides: Partial<WelcomeMessage> = {}): WelcomeMessage {
    return {
      v: 1,
      type: 'welcome',
      ts: 1_700_000_000_000,
      protocolVersion: 1,
      bridgeVersion: '0.1.0',
      rnsVersion: '1.4.2',
      ...overrides,
    };
  }

  function makeStatus(overrides: Partial<StatusMessage> = {}): StatusMessage {
    return {
      v: 1,
      type: 'status',
      ts: 1_700_000_000_000,
      connected: true,
      ...overrides,
    };
  }

  it('getBridgeVersion()/getRnsVersion() are null before any welcome/status is seen', () => {
    const manager = new ReticulumManager('src-a');
    expect(manager.getBridgeVersion()).toBeNull();
    expect(manager.getRnsVersion()).toBeNull();
  });

  it('welcome caches both bridgeVersion and rnsVersion', () => {
    const manager = new ReticulumManager('src-a');
    // @ts-expect-error - exercising the private handler directly
    manager.handleWelcome(makeWelcome());
    expect(manager.getBridgeVersion()).toBe('0.1.0');
    expect(manager.getRnsVersion()).toBe('1.4.2');
  });

  it('a status push with rnsVersion refreshes the cached RNS version without touching bridgeVersion', () => {
    const manager = new ReticulumManager('src-a');
    // @ts-expect-error - exercising the private handler directly
    manager.handleWelcome(makeWelcome({ bridgeVersion: '0.1.0', rnsVersion: '1.4.2' }));
    // @ts-expect-error - exercising the private handler directly
    manager.handleStatus(makeStatus({ rnsVersion: '1.5.0' }));
    expect(manager.getBridgeVersion()).toBe('0.1.0');
    expect(manager.getRnsVersion()).toBe('1.5.0');
  });

  it('a status push with no rnsVersion (e.g. the health-monitor failure broadcast) leaves the cached value untouched', () => {
    const manager = new ReticulumManager('src-a');
    // @ts-expect-error - exercising the private handler directly
    manager.handleWelcome(makeWelcome({ rnsVersion: '1.4.2' }));
    // @ts-expect-error - exercising the private handler directly
    manager.handleStatus(makeStatus({ rnsVersion: undefined, code: 'BRIDGE_UNREACHABLE' as FailureCode }));
    expect(manager.getRnsVersion()).toBe('1.4.2');
  });

  it('end-to-end: connect() over a real welcome handshake populates both getters', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    try {
      const { url } = await new Promise<{ url: string }>((resolve) => {
        wss.on('listening', () => {
          const addr = wss.address();
          const port = addr && typeof addr === 'object' ? addr.port : 0;
          resolve({ url: `ws://127.0.0.1:${port}` });
        });
      });
      wss.on('connection', (ws) => {
        ws.on('message', (data) => {
          const env = JSON.parse(String(data)) as Record<string, unknown>;
          if (env.type === 'hello') {
            ws.send(
              JSON.stringify({ v: 1, type: 'welcome', ts: Date.now(), protocolVersion: 1, bridgeVersion: '0.2.1', rnsVersion: '1.6.0' }),
            );
          } else if (env.type === 'configure') {
            ws.send(JSON.stringify({ v: 1, type: 'ready', id: env.id, ts: Date.now() }));
          }
        });
      });

      const manager = new ReticulumManager('src-a');
      await manager.connect({ mode: 'attach', bridgeUrl: url, token: 't', protocolVersion: 1, configDir: '/rns' });
      expect(manager.getBridgeVersion()).toBe('0.2.1');
      expect(manager.getRnsVersion()).toBe('1.6.0');
      await manager.disconnect();
    } finally {
      await new Promise<void>((res) => wss.close(() => res()));
    }
  });
});

describe('ReticulumManager getLocalNodeInfo / scheduler no-ops', () => {
  it('getLocalNodeInfo returns null', () => {
    const manager = new ReticulumManager('src-a');
    expect(manager.getLocalNodeInfo()).toBeNull();
  });

  it('startDistanceDeleteScheduler/stopDistanceDeleteScheduler are no-ops (positions arrive Phase 3)', async () => {
    const manager = new ReticulumManager('src-a');
    await expect(manager.startDistanceDeleteScheduler()).resolves.toBeUndefined();
    expect(() => manager.stopDistanceDeleteScheduler()).not.toThrow();
  });

  it('constructor requires a non-empty sourceId', () => {
    expect(() => new ReticulumManager('')).toThrow();
  });
});

describe('ReticulumManager connection lifecycle', () => {
  const activeManagers: ReticulumManager[] = [];
  const activeServers: WebSocketServer[] = [];

  afterEach(async () => {
    for (const m of activeManagers.splice(0)) {
      await m.disconnect();
    }
    for (const wss of activeServers.splice(0)) {
      await new Promise<void>((res) => wss.close(() => res()));
    }
  });

  function startMockBridge(
    onConnection: (ws: WSSocket, send: (obj: Record<string, unknown>) => void) => void,
  ): Promise<{ url: string }> {
    return new Promise((resolve) => {
      const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      activeServers.push(wss);
      wss.on('listening', () => {
        const addr = wss.address();
        const port = addr && typeof addr === 'object' ? addr.port : 0;
        resolve({ url: `ws://127.0.0.1:${port}` });
      });
      wss.on('connection', (ws) => {
        const send = (obj: Record<string, unknown>) => ws.send(JSON.stringify(obj));
        onConnection(ws, send);
      });
    });
  }

  function trackManager(m: ReticulumManager): ReticulumManager {
    activeManagers.push(m);
    return m;
  }

  it('getStatus().connected transitions false -> true on connect, back to false on disconnect', async () => {
    const { url } = await startMockBridge((ws, send) => {
      ws.on('message', (data) => {
        const env = JSON.parse(String(data)) as Record<string, unknown>;
        if (env.type === 'hello') {
          send({ v: 1, type: 'welcome', ts: Date.now(), protocolVersion: 1, bridgeVersion: '0.1.0', rnsVersion: '1.4.2' });
        } else if (env.type === 'configure') {
          send({ v: 1, type: 'ready', id: env.id, ts: Date.now() });
        }
      });
    });

    const manager = trackManager(new ReticulumManager('src-a', 'Source A'));
    expect(manager.getStatus().connected).toBe(false);
    expect(manager.isConnected()).toBe(false);

    await manager.connect({ mode: 'attach', bridgeUrl: url, token: 't', protocolVersion: 1, configDir: '/rns' });
    expect(manager.getStatus().connected).toBe(true);
    expect(manager.isConnected()).toBe(true);
    const status = manager.getStatus();
    expect(status.sourceId).toBe('src-a');
    expect(status.sourceName).toBe('Source A');
    expect(status.sourceType).toBe('reticulum');

    await manager.disconnect();
    expect(manager.getStatus().connected).toBe(false);
    expect(manager.isConnected()).toBe(false);
  });

  it('getStatus() accepts a live-name override without mutating the stored name', async () => {
    const manager = trackManager(new ReticulumManager('src-a', 'Stored Name'));
    expect(manager.getStatus('Live Name').sourceName).toBe('Live Name');
    expect(manager.getStatus().sourceName).toBe('Stored Name');
  });

  it('start() with no configure() call logs and returns without connecting', async () => {
    const manager = trackManager(new ReticulumManager('src-a'));
    await manager.start();
    expect(manager.isConnected()).toBe(false);
  });

  it('start() swallows a connect failure (bridge unreachable) rather than throwing', async () => {
    const manager = trackManager(new ReticulumManager('src-a'));
    manager.configure({ mode: 'attach', bridgeUrl: 'ws://127.0.0.1:1', token: 't', protocolVersion: 1, configDir: '/rns' });
    await expect(manager.start()).resolves.toBeUndefined();
    expect(manager.isConnected()).toBe(false);
  });

  it('connect() propagates a bridge-unreachable failure to the caller', async () => {
    const manager = trackManager(new ReticulumManager('src-a'));
    await expect(
      manager.connect({ mode: 'attach', bridgeUrl: 'ws://127.0.0.1:1', token: 't', protocolVersion: 1, configDir: '/rns' }),
    ).rejects.toThrow();
    expect(manager.isConnected()).toBe(false);
  });
});
