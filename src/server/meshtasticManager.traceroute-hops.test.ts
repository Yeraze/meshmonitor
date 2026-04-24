/**
 * MeshtasticManager — Traceroute intermediate hop handling (issues 2610 + 2602)
 *
 * History:
 *   - Issue 2610 (March 2026): processTracerouteMessage was modified to stamp
 *     a fresh `lastHeard` on every intermediate hop in route[] and routeBack[]
 *     so the dashboard's stale-node filter would surface them.
 *   - Issue 2602 (April 2026): That same stamping leaked the hops out to
 *     virtual node clients via sendNodeInfosFromDb, where the connected
 *     Meshtastic app rendered them as zombies on the map and could not delete
 *     them (they don't exist on the physical node).
 *
 * Resolution: stop touching `lastHeard` from the hop loop entirely. Known
 * hops are skipped (their lastHeard updates only when a real packet from them
 * arrives). Unknown hops still get a stub row so future name lookups resolve
 * — but with a NULL `lastHeard`, so `gt(lastHeard, cutoff)` excludes them
 * from both the dashboard and the VN until a real packet arrives.
 *
 * The from/to nodes of the traceroute itself are still stamped with
 * `lastHeard` by the explicit upsert block at the top of
 * processTracerouteMessage — those represent actual radio peers (the
 * requester and responder), not relay-only intermediates.
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
      insertTelemetryBatch: vi.fn().mockResolvedValue(0),
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

vi.mock('./messageQueueService.js', () => {
  const mockInstance = {
    enqueue: vi.fn(),
    setSendCallback: vi.fn(),
    handleAck: vi.fn(),
    handleFailure: vi.fn(),
    recordExternalSend: vi.fn(),
    clear: vi.fn(),
    getStatus: vi.fn(() => ({ queueLength: 0, pendingAcks: 0, processing: false })),
  };
  function MessageQueueService() { return mockInstance as any; }
  return {
    messageQueueService: mockInstance,
    MessageQueueService,
  };
});

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

describe('MeshtasticManager — traceroute intermediate hop handling (issues 2610 + 2602)', () => {
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

  /** All upsertNode calls that targeted a specific nodeNum. */
  const upsertCallsFor = (nodeNum: number): Array<Record<string, unknown>> => {
    return mockUpsertNode.mock.calls
      .filter(call => call[0]?.nodeNum === nodeNum)
      .map(call => call[0]);
  };

  /** Subset of those calls that explicitly include a `lastHeard` field. */
  const upsertCallsWithLastHeardFor = (nodeNum: number): Array<Record<string, unknown>> => {
    return upsertCallsFor(nodeNum).filter(call => 'lastHeard' in call);
  };

  it('does NOT touch a known intermediate hop in the forward route (#2602)', async () => {
    // Hops 0xaaaa1111 and 0xaaaa2222 already exist in the DB. The hop loop
    // must skip them entirely so the (stale) lastHeard is preserved and
    // they don't accidentally surface in getActiveNodes / VN clients.
    const stale = Math.floor(Date.now() / 1000) - 86_400 * 10; // 10 days ago
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

    // Neither intermediate hop should have been upserted at all — they
    // already exist and the hop loop skips them.
    expect(upsertCallsFor(0xaaaa1111)).toEqual([]);
    expect(upsertCallsFor(0xaaaa2222)).toEqual([]);
  });

  it('does NOT touch a known intermediate hop in the return route (#2602)', async () => {
    const stale = Math.floor(Date.now() / 1000) - 86_400 * 10;
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

    expect(upsertCallsFor(0xbbbb3333)).toEqual([]);
    expect(upsertCallsFor(0xbbbb4444)).toEqual([]);
  });

  it('creates a stub row for an unknown intermediate hop WITHOUT a lastHeard (#2602)', async () => {
    // from/to exist but the intermediate hop is totally unknown.
    // Make getNode stateful: once we upsert a stub, subsequent reads must
    // return it (otherwise downstream code paths like
    // estimateIntermediatePositions would re-upsert it and we'd be testing
    // implementation noise instead of the actual property under test).
    const stale = Math.floor(Date.now() / 1000) - 86_400;
    const fakeStore = new Map<number, any>();
    mockGetNode.mockImplementation((nodeNum: number) => {
      if (fakeStore.has(nodeNum)) return fakeStore.get(nodeNum);
      if (nodeNum === 0xcccc5555) return undefined; // unknown hop
      return { nodeNum, nodeId: `!${nodeNum.toString(16)}`, longName: 'Node', shortName: 'ND', lastHeard: stale };
    });
    mockUpsertNode.mockImplementation((data: any) => {
      fakeStore.set(data.nodeNum, { ...data });
      return Promise.resolve(undefined);
    });

    const packet = makeTraceroutePacket(0xdddddddd, 0x11111111);
    const routeDiscovery = {
      route: [0xcccc5555],
      routeBack: [],
      snrTowards: [40, 20],
      snrBack: [],
    };

    await (manager as any).processTracerouteMessage(packet, routeDiscovery);

    // The stub upsert MUST exist (so future lookups can find a name) and
    // NONE of the calls for this hop may include a `lastHeard` field — we
    // have not directly heard from this node, only seen it relay traffic
    // on our behalf.
    const stubCalls = upsertCallsFor(0xcccc5555);
    expect(stubCalls.length).toBeGreaterThanOrEqual(1);
    expect(upsertCallsWithLastHeardFor(0xcccc5555)).toEqual([]);
    const stub = stubCalls[0] as any;
    expect(stub.longName).toContain('cccc5555');
    expect(stub.shortName).toBeDefined();
  });

  it('never clobbers the longName of a known hop (no upsert at all)', async () => {
    const stale = Math.floor(Date.now() / 1000) - 86_400 * 5;
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

    // Known node — the hop loop must skip it entirely. No upserts means
    // no risk of clobbering longName, shortName, or lastHeard.
    expect(upsertCallsFor(0xeeee6666)).toEqual([]);
  });

  it('filters invalid/reserved node numbers out of the hop loop entirely', async () => {
    const stale = Math.floor(Date.now() / 1000) - 86_400;
    const fakeStore = new Map<number, any>();
    mockGetNode.mockImplementation((nodeNum: number) => {
      if (fakeStore.has(nodeNum)) return fakeStore.get(nodeNum);
      // Make 0xaaaa7777 an *unknown* hop so it gets stub-created (lets us
      // observe that the hop loop ran for the valid value). Reserved values
      // are filtered out before the loop ever runs, so they should never
      // hit upsertNode regardless of getNode return value.
      if (nodeNum === 0xaaaa7777) return undefined;
      return { nodeNum, nodeId: `!${nodeNum.toString(16)}`, longName: 'Node', shortName: 'ND', lastHeard: stale };
    });
    mockUpsertNode.mockImplementation((data: any) => {
      fakeStore.set(data.nodeNum, { ...data });
      return Promise.resolve(undefined);
    });

    const packet = makeTraceroutePacket(0xdddddddd, 0x11111111);
    // Reserved: 0-3, 255, 65535 — must never be upserted as hops.
    // BROADCAST (4294967295) is KEPT in the route array (firmware inserts it
    // as a placeholder for relay-role hops that refuse to self-identify) but
    // must NOT be stub-upserted into the nodes table.
    const routeDiscovery = {
      route: [0, 1, 2, 3, 255, 65535, 4294967295, 0xaaaa7777],
      routeBack: [],
      snrTowards: [10, 10, 10, 10, 10, 10, 10, 10, 10],
      snrBack: [],
    };

    await (manager as any).processTracerouteMessage(packet, routeDiscovery);

    // The valid (unknown) hop was stub-created — proves the loop did execute
    // and the filter let the right value through. And critically: no upsert
    // for this hop carried a `lastHeard` field.
    expect(upsertCallsFor(0xaaaa7777).length).toBeGreaterThanOrEqual(1);
    expect(upsertCallsWithLastHeardFor(0xaaaa7777)).toEqual([]);
    // Reserved values and BROADCAST must never have been upserted via the
    // hop loop (BROADCAST is rendered as "Unknown" but never stored as a node).
    for (const reserved of [0, 1, 2, 3, 255, 65535, 4294967295]) {
      expect(upsertCallsFor(reserved)).toEqual([]);
    }
  });

  it('preserves BROADCAST_ADDR hops in the stored route without stub-creating them', async () => {
    const stale = Math.floor(Date.now() / 1000) - 86_400;
    mockGetNode.mockImplementation((nodeNum: number) => ({
      nodeNum, nodeId: `!${nodeNum.toString(16)}`, longName: 'Node', shortName: 'ND', lastHeard: stale,
    }));

    const packet = makeTraceroutePacket(0xdddddddd, 0x11111111);
    // Firmware placeholder (0xffffffff) for a relay-role hop — must be kept
    // in the persisted route so the UI can render it as "Unknown".
    const routeDiscovery = {
      route: [0xaaaa1111, 4294967295, 0xaaaa2222],
      routeBack: [],
      snrTowards: [40, 30, 20, 10],
      snrBack: [],
    };

    await (manager as any).processTracerouteMessage(packet, routeDiscovery);

    // BROADCAST must NOT have been upserted as a node.
    expect(upsertCallsFor(4294967295)).toEqual([]);

    // The persisted route (first arg to insertTraceroute) must include BROADCAST.
    expect(mockInsertTraceroute).toHaveBeenCalled();
    const insertedRoute = mockInsertTraceroute.mock.calls[0][0].route;
    const parsedRoute = JSON.parse(insertedRoute);
    expect(parsedRoute).toEqual([0xaaaa1111, 4294967295, 0xaaaa2222]);
  });

  it('does not double-upsert the from/to nodes via the hop loop', async () => {
    const stale = Math.floor(Date.now() / 1000) - 86_400;
    mockGetNode.mockImplementation((nodeNum: number) => ({
      nodeNum, nodeId: `!${nodeNum.toString(16)}`, longName: 'Node', shortName: 'ND', lastHeard: stale,
    }));

    const fromNum = 0xdddddddd;
    const toNum = 0x11111111;
    const packet = makeTraceroutePacket(fromNum, toNum);

    // Pathological case: from/to also appear in the route arrays. The hop
    // loop should dedupe them so they aren't upserted redundantly.
    // 0xaaaa8888 is known so the hop loop skips it.
    const routeDiscovery = {
      route: [toNum, 0xaaaa8888, fromNum],
      routeBack: [],
      snrTowards: [40, 30, 20, 10],
      snrBack: [],
    };

    await (manager as any).processTracerouteMessage(packet, routeDiscovery);

    // From/to each get exactly one upsert (from the explicit from/to block
    // at the top of processTracerouteMessage), and that upsert DOES carry
    // lastHeard because they are real radio peers from this packet's POV.
    const fromWithLh = upsertCallsWithLastHeardFor(fromNum);
    const toWithLh = upsertCallsWithLastHeardFor(toNum);
    expect(fromWithLh.length).toBe(1);
    expect(toWithLh.length).toBe(1);
    expect(Number(fromWithLh[0].lastHeard)).toBeGreaterThan(stale);
    expect(Number(toWithLh[0].lastHeard)).toBeGreaterThan(stale);

    // Known intermediate hop — never upserted by the hop loop.
    expect(upsertCallsFor(0xaaaa8888)).toEqual([]);
  });
});
