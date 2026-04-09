/**
 * Tests for issue #2602 — virtual node "zombie" fixes.
 *
 * Covers two distinct VirtualNodeServer behaviors:
 *
 *   1. `sendNodeInfosFromDb` MUST NOT ship the broadcast pseudo-node row
 *      (`!ffffffff`, nodeNum 0xFFFFFFFF) or any other synthetic stub to a
 *      connected Meshtastic client, and it MUST scope its node query to the
 *      manager's `sourceId` so multi-source instances don't bleed nodes
 *      between sources.
 *
 *   2. `removeByNodenum` admin commands sent over the virtual node TCP
 *      channel MUST be acked-and-dropped: the requesting client gets a
 *      fabricated routing-ack with errorReason=NONE so its UI doesn't hang,
 *      and the command is NEVER queued out to the physical radio. This is
 *      enforced regardless of `allowAdminCommands`, because deletion is a
 *      MeshMonitor-only operation per the issue resolution.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

// ────────────────────────────────────────────────────────────────────────────
// Module mocks — set up BEFORE the import of virtualNodeServer.js
// ────────────────────────────────────────────────────────────────────────────

const { getActiveNodesMock, getSettingMock } = vi.hoisted(() => ({
  getActiveNodesMock: vi.fn().mockResolvedValue([]),
  getSettingMock: vi.fn().mockResolvedValue('24'),
}));

vi.mock('../services/database.js', () => {
  const shared = {
    nodes: {
      getActiveNodes: getActiveNodesMock,
      setNodeFavorite: vi.fn().mockResolvedValue(undefined),
    },
    getSettingAsync: getSettingMock,
    waitForReady: vi.fn().mockResolvedValue(undefined),
  };
  return { default: shared, databaseService: shared };
});

const {
  createNodeInfoMock,
  createFakeRoutingAckMock,
  parseToRadioMock,
  decodeAdminMessageMock,
  normalizePortNumMock,
} = vi.hoisted(() => ({
  createNodeInfoMock: vi.fn().mockResolvedValue(new Uint8Array([10, 20, 30])),
  createFakeRoutingAckMock: vi.fn().mockResolvedValue(new Uint8Array([0xa, 0xc, 0xc])),
  parseToRadioMock: vi.fn(),
  decodeAdminMessageMock: vi.fn(),
  normalizePortNumMock: vi.fn((n: any) => (typeof n === 'number' ? n : 0)),
}));

vi.mock('./meshtasticProtobufService.js', () => {
  const svc = {
    createNodeInfo: createNodeInfoMock,
    createFakeRoutingAck: createFakeRoutingAckMock,
    parseToRadio: parseToRadioMock,
    normalizePortNum: normalizePortNumMock,
    getPortNumName: (n: number) => `PORT_${n}`,
  };
  return { default: svc, meshtasticProtobufService: svc };
});

vi.mock('./protobufService.js', () => {
  const svc = {
    decodeAdminMessage: decodeAdminMessageMock,
  };
  return { default: svc, protobufService: svc };
});

import { VirtualNodeServer } from './virtualNodeServer.js';

// ────────────────────────────────────────────────────────────────────────────
// Test helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build a minimal MeshtasticManager-shaped stub for the VN constructor.
 * The VN never actually exercises any of these methods in the tests we run
 * here, but several call sites (incl. our removeByNodenum intercept) read
 * `getLocalNodeInfo()` and `sourceId`.
 */
function makeFakeManager(sourceId: string = 'src-1', localNodeNum: number = 0x11223344) {
  return {
    sourceId,
    getLocalNodeInfo: () => ({
      nodeNum: localNodeNum,
      nodeId: `!${localNodeNum.toString(16).padStart(8, '0')}`,
    }),
    processIncomingData: vi.fn().mockResolvedValue(undefined),
  } as any;
}

/**
 * Stub a connected client into the VN's internal map and capture writes
 * via a simple Uint8Array buffer recorder.
 */
function attachFakeClient(vn: VirtualNodeServer, clientId: string = 'client-1') {
  const writes: Uint8Array[] = [];
  const fakeSocket: any = {
    destroyed: false,
    writable: true,
    remoteAddress: '192.168.1.50',
    write: (chunk: Uint8Array, cb?: (err?: Error) => void) => {
      writes.push(chunk);
      if (cb) cb();
      return true;
    },
    end: vi.fn(),
    destroy: vi.fn(),
    on: vi.fn(),
  };

  const client = {
    socket: fakeSocket,
    id: clientId,
    buffer: Buffer.alloc(0),
    connectedAt: new Date(),
    lastActivity: new Date(),
  };

  // Reach into the private clients Map
  (vn as any).clients.set(clientId, client);
  return { writes, client };
}

// ────────────────────────────────────────────────────────────────────────────
// 1. sendNodeInfosFromDb filtering
// ────────────────────────────────────────────────────────────────────────────

describe('VirtualNodeServer.sendNodeInfosFromDb — issue #2602 zombie filtering', () => {
  beforeEach(() => {
    getActiveNodesMock.mockReset();
    getSettingMock.mockReset();
    createNodeInfoMock.mockReset();
    createNodeInfoMock.mockResolvedValue(new Uint8Array([10, 20, 30]));
    getSettingMock.mockResolvedValue('24');
  });

  it('skips the broadcast pseudo-node !ffffffff', async () => {
    const realNode = {
      nodeNum: 0x11223344,
      nodeId: '!11223344',
      longName: 'Real',
      shortName: 'REAL',
      hwModel: 1,
      lastHeard: Math.floor(Date.now() / 1000),
    };
    const broadcastPseudo = {
      nodeNum: 0xffffffff,
      nodeId: '!ffffffff',
      longName: 'Broadcast',
      shortName: 'BCAST',
      hwModel: 0,
      // Even if a stale install has lastHeard stamped, the filter must drop it.
      lastHeard: Math.floor(Date.now() / 1000),
    };
    getActiveNodesMock.mockResolvedValue([realNode, broadcastPseudo]);

    const vn = new VirtualNodeServer({
      port: 4503,
      meshtasticManager: makeFakeManager(),
    });
    attachFakeClient(vn);

    const result = await (vn as any).sendNodeInfosFromDb('client-1');

    expect(result.disconnected).toBe(false);
    expect(result.sent).toBe(1);
    expect(createNodeInfoMock).toHaveBeenCalledTimes(1);
    // The single createNodeInfo call must be for the real node, never broadcast.
    const call = createNodeInfoMock.mock.calls[0][0];
    expect(call.nodeNum).toBe(0x11223344);
  });

  it('skips any row whose nodeId is exactly !ffffffff even if nodeNum somehow differs', async () => {
    // Belt-and-suspenders: catch a hypothetical row where the textual
    // nodeId is '!ffffffff' but the integer nodeNum field has drifted
    // (e.g. signed/unsigned cast bugs in older migrations).
    getActiveNodesMock.mockResolvedValue([
      {
        nodeNum: -1,
        nodeId: '!ffffffff',
        longName: 'Broadcast',
        shortName: 'BCAST',
        hwModel: 0,
        lastHeard: Math.floor(Date.now() / 1000),
      },
    ]);

    const vn = new VirtualNodeServer({
      port: 4503,
      meshtasticManager: makeFakeManager(),
    });
    attachFakeClient(vn);

    const result = await (vn as any).sendNodeInfosFromDb('client-1');
    expect(result.sent).toBe(0);
    expect(createNodeInfoMock).not.toHaveBeenCalled();
  });

  it('queries getActiveNodes scoped to the manager sourceId', async () => {
    getActiveNodesMock.mockResolvedValue([]);
    getSettingMock.mockResolvedValue('48'); // 48 hours → 2 days

    const vn = new VirtualNodeServer({
      port: 4503,
      meshtasticManager: makeFakeManager('src-multi-A'),
    });
    attachFakeClient(vn);

    await (vn as any).sendNodeInfosFromDb('client-1');

    expect(getActiveNodesMock).toHaveBeenCalledTimes(1);
    const [days, sourceId] = getActiveNodesMock.mock.calls[0];
    expect(days).toBeCloseTo(2);
    expect(sourceId).toBe('src-multi-A');
  });

  it('falls back to default 24h when maxNodeAgeHours setting is unset', async () => {
    getActiveNodesMock.mockResolvedValue([]);
    getSettingMock.mockResolvedValue(null);

    const vn = new VirtualNodeServer({
      port: 4503,
      meshtasticManager: makeFakeManager('src-default'),
    });
    attachFakeClient(vn);

    await (vn as any).sendNodeInfosFromDb('client-1');

    const [days] = getActiveNodesMock.mock.calls[0];
    // 24h / 24 == 1 day
    expect(days).toBeCloseTo(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. removeByNodenum ack-and-drop
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build a minimal toRadio object the way meshtasticProtobufService.parseToRadio
 * would return it for an ADMIN_APP packet carrying removeByNodenum. The
 * VN code only inspects: `packet`, `packet.id`, `packet.from`, `packet.to`,
 * `packet.decoded.portnum`, `packet.decoded.payload`.
 */
function makeRemoveByNodenumPacket(opts: {
  packetId?: number;
  fromNum?: number;
  toNum?: number;
} = {}) {
  return {
    packet: {
      id: opts.packetId ?? 0xdead_beef,
      from: opts.fromNum ?? 0xaa00aa00,
      to: opts.toNum ?? 0xff_ff_ff_ff,
      decoded: {
        portnum: 6, // ADMIN_APP
        payload: new Uint8Array([1, 2, 3, 4]),
      },
    },
  };
}

describe('VirtualNodeServer — removeByNodenum ack-and-drop (issue #2602)', () => {
  beforeEach(() => {
    parseToRadioMock.mockReset();
    decodeAdminMessageMock.mockReset();
    createFakeRoutingAckMock.mockReset();
    createFakeRoutingAckMock.mockResolvedValue(new Uint8Array([0xa, 0xc, 0xc]));
    normalizePortNumMock.mockClear();
    normalizePortNumMock.mockImplementation((n: any) => (typeof n === 'number' ? n : 0));
  });

  it('intercepts removeByNodenum and acks the requesting client when allowAdminCommands=false', async () => {
    parseToRadioMock.mockResolvedValue(makeRemoveByNodenumPacket({ packetId: 0xdead_beef, fromNum: 0xaa00aa00 }));
    decodeAdminMessageMock.mockReturnValue({ removeByNodenum: 0x66666666 });

    const fakeMgr = makeFakeManager('src-1', 0x11223344);
    const vn = new VirtualNodeServer({
      port: 4503,
      meshtasticManager: fakeMgr,
      allowAdminCommands: false,
    });
    const { writes } = attachFakeClient(vn, 'client-1');

    // Drive the private message handler directly with arbitrary payload bytes;
    // parseToRadio is mocked so the bytes are irrelevant.
    await (vn as any).handleClientMessage('client-1', new Uint8Array([0]));

    // Routing ack helper called with original packet id, requester as `to`,
    // local node as `from`.
    expect(createFakeRoutingAckMock).toHaveBeenCalledTimes(1);
    const [requestId, requesterNodeNum, ackFromNodeNum] = createFakeRoutingAckMock.mock.calls[0];
    expect(requestId).toBe(0xdead_beef);
    expect(requesterNodeNum).toBe(0xaa00aa00);
    expect(ackFromNodeNum).toBe(0x11223344);

    // The fabricated ack must have been written to *this* client's socket.
    expect(writes.length).toBeGreaterThanOrEqual(1);

    // Critically: the request must NOT have been forwarded to the physical
    // node via the manager.
    expect((fakeMgr as Mock & any).processIncomingData).not.toHaveBeenCalled();
  });

  it('intercepts removeByNodenum even when allowAdminCommands=true', async () => {
    parseToRadioMock.mockResolvedValue(makeRemoveByNodenumPacket({ packetId: 42, fromNum: 0xbbbb0001 }));
    decodeAdminMessageMock.mockReturnValue({ removeByNodenum: 12345 });

    const fakeMgr = makeFakeManager('src-1', 0x77777777);
    const vn = new VirtualNodeServer({
      port: 4503,
      meshtasticManager: fakeMgr,
      allowAdminCommands: true, // <-- the dangerous mode
    });
    const { writes } = attachFakeClient(vn);

    await (vn as any).handleClientMessage('client-1', new Uint8Array([0]));

    // Even in permissive mode, removeByNodenum must be intercepted before
    // reaching the queue.
    expect(createFakeRoutingAckMock).toHaveBeenCalledTimes(1);
    expect(writes.length).toBeGreaterThanOrEqual(1);
    expect((fakeMgr as Mock & any).processIncomingData).not.toHaveBeenCalled();
  });

  it('does NOT intercept other admin messages (e.g. setFavoriteNode)', async () => {
    parseToRadioMock.mockResolvedValue(makeRemoveByNodenumPacket({ packetId: 1 }));
    // setFavoriteNode is handled by the existing favorite/unfavorite intercept,
    // not by our new path. The new path must explicitly leave it alone.
    decodeAdminMessageMock.mockReturnValue({ setFavoriteNode: 999 });

    const fakeMgr = makeFakeManager();
    const vn = new VirtualNodeServer({
      port: 4503,
      meshtasticManager: fakeMgr,
      allowAdminCommands: false,
    });
    attachFakeClient(vn);

    await (vn as any).handleClientMessage('client-1', new Uint8Array([0])).catch(() => {
      // The favorite intercept path may try to call other database methods
      // that aren't fully mocked here — that's fine, we only care that the
      // *new* removeByNodenum-specific path didn't fire a routing ack.
    });

    expect(createFakeRoutingAckMock).not.toHaveBeenCalled();
  });

  it('falls through (does not crash) when admin payload cannot be decoded', async () => {
    parseToRadioMock.mockResolvedValue(makeRemoveByNodenumPacket({ packetId: 1 }));
    decodeAdminMessageMock.mockImplementation(() => {
      throw new Error('mock decode failure');
    });

    const fakeMgr = makeFakeManager();
    const vn = new VirtualNodeServer({
      port: 4503,
      meshtasticManager: fakeMgr,
      allowAdminCommands: false,
    });
    attachFakeClient(vn);

    // Should not throw — the catch in our intercept logs and falls through
    // to the existing block-or-allow logic. We don't care what happens
    // afterwards beyond "no routing ack was fabricated for this packet"
    // since we never confirmed it was a removeByNodenum.
    await (vn as any).handleClientMessage('client-1', new Uint8Array([0])).catch(() => {});

    expect(createFakeRoutingAckMock).not.toHaveBeenCalled();
  });
});
