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

const { getAllNodes } = vi.hoisted(() => ({ getAllNodes: vi.fn() }));

vi.mock('../services/database.js', () => {
  const shared = {
    waitForReady: vi.fn().mockResolvedValue(undefined),
    settings: {
      getSetting: vi.fn().mockResolvedValue(null),
      setSetting: vi.fn().mockResolvedValue(undefined),
    },
    getAllTraceroutesForRecalculationAsync: vi.fn().mockResolvedValue([]),
    sources: { getSource: vi.fn().mockResolvedValue(null) },
    telemetry: {
      // getAllNodesAsync reads an uptime map; .get() must exist.
      getLatestTelemetryValueForAllNodes: vi.fn().mockResolvedValue(new Map()),
    },
    nodes: {
      getNode: vi.fn().mockResolvedValue(null),
      upsertNode: vi.fn().mockResolvedValue(undefined),
      getActiveNodes: vi.fn().mockResolvedValue([]),
      getAllNodes,
    },
    recordTracerouteRequestAsync: vi.fn().mockResolvedValue(undefined),
  };
  return { default: shared, databaseService: shared };
});

import { MeshtasticManager } from './meshtasticManager.js';

function makeManager() {
  return new MeshtasticManager('src-1', { host: '127.0.0.1', port: 4403 });
}

// Minimal DB row shape consumed by mapDbNodeToDeviceInfo.
function dbNode(overrides: Record<string, any> = {}) {
  return {
    nodeNum: 382011584,
    nodeId: '!16c508c0',
    longName: 'STUART G2',
    shortName: 'TRON',
    ...overrides,
  };
}

describe('getAllNodesAsync — isUnmessagable / isLicensed pass-through (#3755)', () => {
  it('REGRESSION: exposes isUnmessagable so the DM UI can hide for unmessagable nodes', async () => {
    // The bug: mapDbNodeToDeviceInfo dropped is_unmessagable, so the client
    // node always had isUnmessagable === undefined and the DM button/compose
    // (NodesTab.tsx, MessagesTab.tsx) fell open for unmessagable nodes.
    getAllNodes.mockResolvedValue([dbNode({ isUnmessagable: 1, isLicensed: 1 })]);

    const [node] = await makeManager().getAllNodesAsync('src-1');

    expect(node.isUnmessagable).toBe(true);
    expect(node.isLicensed).toBe(true);
  });

  it('reports a messagable node as isUnmessagable false', async () => {
    getAllNodes.mockResolvedValue([dbNode({ isUnmessagable: 0, isLicensed: 0 })]);

    const [node] = await makeManager().getAllNodesAsync('src-1');

    expect(node.isUnmessagable).toBe(false);
    expect(node.isLicensed).toBe(false);
  });

  it('omits the flags when the columns are null (legacy rows)', async () => {
    getAllNodes.mockResolvedValue([dbNode({ isUnmessagable: null, isLicensed: null })]);

    const [node] = await makeManager().getAllNodesAsync('src-1');

    expect(node.isUnmessagable).toBeUndefined();
    expect(node.isLicensed).toBeUndefined();
  });
});
