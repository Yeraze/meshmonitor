/**
 * MeshtasticManager — Traceroute intermediate hop lastHeard updates (issue 2610)
 *
 * Verifies that when processTracerouteMessage runs, every node that appears
 * in route[] and routeBack[] gets its lastHeard updated. A node relaying a
 * traceroute response is apparently alive and on-air, so the stale-node
 * filter shouldn't hide it from the UI.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before any imports
const mockGetNode = vi.fn();
const mockUpsertNode = vi.fn();
const mockGetSetting = vi.fn();
const mockInsertMessage = vi.fn();
const mockInsertTraceroute = vi.fn();
const mockInsertRouteSegment = vi.fn();
const mockUpdateRecordHolderSegmentAsync = vi.fn();
const mockInsertTelemetry = vi.fn();

vi.mock('../services/database.js', () => ({
  default: {
    getSetting: mockGetSetting,
    getNode: mockGetNode,
    upsertNode: mockUpsertNode,
    insertMessage: mockInsertMessage,
    insertTraceroute: mockInsertTraceroute,
    findUserByIdAsync: vi.fn(),
    findUserByUsernameAsync: vi.fn(),
    checkPermissionAsync: vi.fn(),
    getUserPermissionSetAsync: vi.fn(),
    settings: {
      getSetting: mockGetSetting,
      setSetting: vi.fn().mockResolvedValue(undefined),
    },
    nodes: {
      getNode: mockGetNode,
      getAllNodes: vi.fn().mockResolvedValue([]),
      getActiveNodes: vi.fn().mockResolvedValue([]),
      upsertNode: mockUpsertNode,
      markNodeAsWelcomedIfNotAlready: vi.fn().mockResolvedValue(false),
      getNodeCount: vi.fn().mockResolvedValue(0),
      setNodeFavorite: vi.fn().mockResolvedValue(undefined),
      updateNodeMessageHops: vi.fn().mockResolvedValue(undefined),
    },
    channels: {
      getChannelById: vi.fn().mockResolvedValue({ id: 0, name: 'Primary' }),
      getAllChannels: vi.fn().mockResolvedValue([]),
      upsertChannel: vi.fn(),
      getChannelCount: vi.fn().mockResolvedValue(0),
    },
    telemetry: {
      insertTelemetry: mockInsertTelemetry,
      getLatestTelemetryForType: vi.fn().mockResolvedValue(null),
    },
    messages: {
      insertMessage: mockInsertMessage,
      getMessages: vi.fn().mockResolvedValue([]),
      updateMessageTimestamps: vi.fn().mockResolvedValue(true),
      updateMessageDeliveryState: vi.fn().mockResolvedValue(true),
    },
    traceroutes: {
      insertTraceroute: mockInsertTraceroute,
      insertRouteSegment: mockInsertRouteSegment,
    },
    neighbors: {
      upsertNeighborInfo: vi.fn().mockResolvedValue(undefined),
      deleteNeighborInfoForNode: vi.fn().mockResolvedValue(0),
    },
    getAllTraceroutesForRecalculation: vi.fn().mockReturnValue([]),
    updateRecordHolderSegment: vi.fn(),
    updateRecordHolderSegmentAsync: mockUpdateRecordHolderSegmentAsync,
    recordTracerouteRequest: vi.fn(),
    suppressGhostNode: vi.fn(),
    isNodeSuppressed: vi.fn().mockReturnValue(false),
    isAutoTimeSyncEnabled: vi.fn().mockReturnValue(false),
    getAutoTimeSyncIntervalMinutes: vi.fn().mockReturnValue(0),
    logKeyRepairAttemptAsync: vi.fn().mockResolvedValue(0),
    clearKeyRepairStateAsync: vi.fn().mockResolvedValue(undefined),
    deleteNodeAsync: vi.fn().mockResolvedValue({}),
    getNodeNeedingTracerouteAsync: vi.fn().mockResolvedValue(null),
    logAutoTracerouteAttemptAsync: vi.fn().mockResolvedValue(0),
    getNodeNeedingTimeSyncAsync: vi.fn().mockResolvedValue(null),
    getNodeNeedingRemoteAdminCheckAsync: vi.fn().mockResolvedValue(null),
    updateNodeRemoteAdminStatusAsync: vi.fn().mockResolvedValue(undefined),
    getNodesNeedingKeyRepairAsync: vi.fn().mockResolvedValue([]),
    getKeyRepairLogAsync: vi.fn().mockResolvedValue([]),
    setKeyRepairStateAsync: vi.fn().mockResolvedValue(undefined),
    insertTelemetryAsync: vi.fn().mockResolvedValue(undefined),
    getLatestTelemetryForTypeAsync: vi.fn().mockResolvedValue(null),
    getMessageByRequestIdAsync: vi.fn().mockResolvedValue(null),
    updateNodeMobilityAsync: vi.fn().mockResolvedValue(0),
    getRecentEstimatedPositionsAsync: vi.fn().mockResolvedValue([]),
    updateAutoTracerouteResultByNodeAsync: vi.fn().mockResolvedValue(undefined),
    getAllGeofenceCooldownsAsync: vi.fn().mockResolvedValue([]),
    setGeofenceCooldownAsync: vi.fn().mockResolvedValue(undefined),
    markMessageAsReadAsync: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock('./services/dataEventEmitter.js', () => ({
  dataEventEmitter: {
    emitNewMessage: vi.fn(),
    emitTracerouteComplete: vi.fn(),
    emit: vi.fn(),
    on: vi.fn(),
  },
}));

vi.mock('./meshtasticProtobufService.js', () => ({
  default: {
    initialize: vi.fn(),
    createMeshPacket: vi.fn(),
    createTextMessage: vi.fn(),
  },
  meshtasticProtobufService: {
    initialize: vi.fn(),
    createMeshPacket: vi.fn(),
    createTextMessage: vi.fn(),
  },
}));

vi.mock('./protobufService.js', () => ({
  default: {
    encode: vi.fn(),
    decode: vi.fn(),
  },
  convertIpv4ConfigToStrings: vi.fn(),
}));

vi.mock('./protobufLoader.js', () => ({
  getProtobufRoot: vi.fn(),
}));

vi.mock('./tcpTransport.js', () => ({
  TcpTransport: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('./services/notificationService.js', () => ({
  notificationService: {
    checkAndSendNotifications: vi.fn(),
    notifyTraceroute: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('./services/serverEventNotificationService.js', () => ({
  serverEventNotificationService: {
    notifyNodeConnected: vi.fn(),
    notifyNodeDisconnected: vi.fn(),
  },
}));

vi.mock('./services/packetLogService.js', () => ({
  default: {
    logPacket: vi.fn(),
  },
}));

vi.mock('./services/channelDecryptionService.js', () => ({
  channelDecryptionService: {
    tryDecrypt: vi.fn(),
  },
}));

vi.mock('./messageQueueService.js', () => ({
  messageQueueService: {
    enqueue: vi.fn(),
    setSendCallback: vi.fn(),
    clear: vi.fn(),
    recordExternalSend: vi.fn(),
  },
}));

vi.mock('./utils/cronScheduler.js', () => ({
  validateCron: vi.fn(() => true),
  scheduleCron: vi.fn(() => ({ stop: vi.fn() })),
}));

vi.mock('./config/environment.js', () => ({
  getEnvironmentConfig: vi.fn(() => ({
    NODE_IP: '127.0.0.1',
    TCP_PORT: 4403,
    LOG_LEVEL: 'info',
  })),
}));

vi.mock('../utils/autoResponderUtils.js', () => ({
  normalizeTriggerPatterns: vi.fn(),
  normalizeTriggerChannels: vi.fn(),
}));

vi.mock('../utils/nodeHelpers.js', () => ({
  isNodeComplete: vi.fn(),
}));

describe('MeshtasticManager — traceroute intermediate hop lastHeard (issue 2610)', () => {
  let manager: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetSetting.mockResolvedValue('km');
    mockInsertMessage.mockResolvedValue(true);
    mockInsertTraceroute.mockReturnValue(undefined);
    mockInsertRouteSegment.mockResolvedValue(undefined);
    mockUpdateRecordHolderSegmentAsync.mockResolvedValue(undefined);
    mockInsertTelemetry.mockResolvedValue(undefined);

    const module = await import('./meshtasticManager.js');
    manager = module.default;
    // Ensure there's no "local node" so the "skip response from local" guard doesn't bail
    (manager as any).localNodeInfo = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const makeTraceroutePacket = (from: number, to: number) => ({
    from,
    to,
    id: 99999,
    channel: 0,
    rxTime: Math.floor(Date.now() / 1000),
    decoded: { portnum: 70 },
  });

  /**
   * Pull every upsertNode call that touched a given nodeNum and return the
   * lastHeard values passed, in order. Handy for asserting that a specific
   * hop was updated without caring about call order vs. from/to upserts.
   */
  const lastHeardsFor = (nodeNum: number): number[] => {
    return mockUpsertNode.mock.calls
      .filter(call => call[0]?.nodeNum === nodeNum)
      .map(call => call[0]?.lastHeard)
      .filter((lh): lh is number => typeof lh === 'number');
  };

  it('updates lastHeard for intermediate hops in the forward route', async () => {
    // Set up: hops 0xaaaa1111 and 0xaaaa2222 are known nodes with old lastHeard
    const stale = Date.now() / 1000 - 86_400 * 10; // 10 days ago
    mockGetNode.mockImplementation((nodeNum: number) => {
      if (nodeNum === 0xaaaa1111 || nodeNum === 0xaaaa2222) {
        return { nodeNum, nodeId: `!${nodeNum.toString(16)}`, longName: 'Existing', shortName: 'EX', lastHeard: stale };
      }
      // from/to known so we don't spend time in the name-creation branch
      return { nodeNum, nodeId: `!${nodeNum.toString(16)}`, longName: 'Node', shortName: 'ND', lastHeard: stale };
    });

    const packet = makeTraceroutePacket(0xdddddddd, 0x11111111);
    const routeDiscovery = {
      route: [0xaaaa1111, 0xaaaa2222],
      routeBack: [],
      snrTowards: [40, 30, 20],
      snrBack: [],
    };

    await (manager as any).processTracerouteMessage(packet, routeDiscovery);

    // Each intermediate hop must have been upserted with a fresh lastHeard.
    const hop1 = lastHeardsFor(0xaaaa1111);
    const hop2 = lastHeardsFor(0xaaaa2222);
    expect(hop1.length).toBeGreaterThan(0);
    expect(hop2.length).toBeGreaterThan(0);
    // Fresh means "after the stale value", not "equal to some exact now"
    expect(Math.max(...hop1)).toBeGreaterThan(stale);
    expect(Math.max(...hop2)).toBeGreaterThan(stale);
  });

  it('updates lastHeard for intermediate hops in the return route', async () => {
    const stale = Date.now() / 1000 - 86_400 * 10;
    mockGetNode.mockImplementation((nodeNum: number) => ({
      nodeNum, nodeId: `!${nodeNum.toString(16)}`, longName: 'Node', shortName: 'ND', lastHeard: stale,
    }));

    const packet = makeTraceroutePacket(0xdddddddd, 0x11111111);
    const routeDiscovery = {
      route: [],
      routeBack: [0xbbbb3333, 0xbbbb4444],
      snrTowards: [],
      snrBack: [40, 30, 20],
    };

    await (manager as any).processTracerouteMessage(packet, routeDiscovery);

    const hop3 = lastHeardsFor(0xbbbb3333);
    const hop4 = lastHeardsFor(0xbbbb4444);
    expect(hop3.length).toBeGreaterThan(0);
    expect(hop4.length).toBeGreaterThan(0);
    expect(Math.max(...hop3)).toBeGreaterThan(stale);
    expect(Math.max(...hop4)).toBeGreaterThan(stale);
  });

  it('creates a stub row for a previously-unknown intermediate hop', async () => {
    // from/to exist but the intermediate hop is totally unknown
    const stale = Date.now() / 1000 - 86_400;
    mockGetNode.mockImplementation((nodeNum: number) => {
      if (nodeNum === 0xcccc5555) return undefined; // unknown hop
      return { nodeNum, nodeId: `!${nodeNum.toString(16)}`, longName: 'Node', shortName: 'ND', lastHeard: stale };
    });

    const packet = makeTraceroutePacket(0xdddddddd, 0x11111111);
    const routeDiscovery = {
      route: [0xcccc5555],
      routeBack: [],
      snrTowards: [40, 20],
      snrBack: [],
    };

    await (manager as any).processTracerouteMessage(packet, routeDiscovery);

    // The stub upsert should include a placeholder longName/shortName
    // (not just lastHeard) so future lookups can resolve the node.
    const stubCall = mockUpsertNode.mock.calls.find(
      call => call[0]?.nodeNum === 0xcccc5555 && typeof call[0]?.longName === 'string',
    );
    expect(stubCall).toBeDefined();
    expect(stubCall?.[0]?.longName).toContain('cccc5555');
    expect(stubCall?.[0]?.shortName).toBeDefined();
    expect(typeof stubCall?.[0]?.lastHeard).toBe('number');
  });

  it('does not overwrite longName when updating a known hop', async () => {
    const stale = Date.now() / 1000 - 86_400 * 5;
    mockGetNode.mockImplementation((nodeNum: number) => {
      if (nodeNum === 0xeeee6666) {
        return { nodeNum, nodeId: `!eeee6666`, longName: 'Real Node Name', shortName: 'REAL', lastHeard: stale };
      }
      return { nodeNum, nodeId: `!${nodeNum.toString(16)}`, longName: 'Node', shortName: 'ND', lastHeard: stale };
    });

    const packet = makeTraceroutePacket(0xdddddddd, 0x11111111);
    const routeDiscovery = {
      route: [0xeeee6666],
      routeBack: [],
      snrTowards: [40, 20],
      snrBack: [],
    };

    await (manager as any).processTracerouteMessage(packet, routeDiscovery);

    // Every upsert for this known hop must NOT include longName — we only
    // touch lastHeard, never clobber the human-chosen name.
    const callsForHop = mockUpsertNode.mock.calls.filter(call => call[0]?.nodeNum === 0xeeee6666);
    expect(callsForHop.length).toBeGreaterThan(0);
    for (const call of callsForHop) {
      expect(call[0]?.longName).toBeUndefined();
    }
  });

  it('filters invalid/reserved node numbers out of the hop update loop', async () => {
    const stale = Date.now() / 1000 - 86_400;
    mockGetNode.mockImplementation((nodeNum: number) => ({
      nodeNum, nodeId: `!${nodeNum.toString(16)}`, longName: 'Node', shortName: 'ND', lastHeard: stale,
    }));

    const packet = makeTraceroutePacket(0xdddddddd, 0x11111111);
    // Reserved: 0-3, 255, 65535, 4294967295 — must never be upserted as hops
    const routeDiscovery = {
      route: [0, 1, 2, 3, 255, 65535, 4294967295, 0xaaaa7777],
      routeBack: [],
      snrTowards: [10, 10, 10, 10, 10, 10, 10, 10, 10],
      snrBack: [],
    };

    await (manager as any).processTracerouteMessage(packet, routeDiscovery);

    // Only the valid hop was upserted from the filtered route
    expect(lastHeardsFor(0xaaaa7777).length).toBeGreaterThan(0);
    // Every reserved value must not have been upserted via the hop loop
    for (const reserved of [0, 1, 2, 3, 255, 65535, 4294967295]) {
      // from/to shouldn't collide with these; if they ever did, the test
      // would need revisiting. Assert no upsertNode call touched them.
      expect(lastHeardsFor(reserved)).toEqual([]);
    }
  });

  it('does not double-upsert the from/to nodes via the hop loop', async () => {
    const stale = Date.now() / 1000 - 86_400;
    mockGetNode.mockImplementation((nodeNum: number) => ({
      nodeNum, nodeId: `!${nodeNum.toString(16)}`, longName: 'Node', shortName: 'ND', lastHeard: stale,
    }));

    const fromNum = 0xdddddddd;
    const toNum = 0x11111111;
    const packet = makeTraceroutePacket(fromNum, toNum);

    // Pathological case: from/to also appear in the route arrays. The hop
    // loop should dedupe them so they aren't upserted redundantly.
    const routeDiscovery = {
      route: [toNum, 0xaaaa8888, fromNum],
      routeBack: [],
      snrTowards: [40, 30, 20, 10],
      snrBack: [],
    };

    await (manager as any).processTracerouteMessage(packet, routeDiscovery);

    // From/to each get exactly one upsert from the explicit from/to block
    // at the top of processTracerouteMessage — not an extra one from the
    // hop loop. (The block runs once for each.)
    expect(lastHeardsFor(fromNum).length).toBe(1);
    expect(lastHeardsFor(toNum).length).toBe(1);

    // And the real intermediate hop still got updated
    expect(lastHeardsFor(0xaaaa8888).length).toBeGreaterThan(0);
  });
});
