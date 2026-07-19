/**
 * Tests for the TELEMETRY_APP → NeighborInfo hijack detect-and-auto-retry
 * (issue #4210 / meshtastic/firmware#11071).
 *
 * When we send a telemetry want_response to a remote node that has neighbor_info
 * enabled, the firmware's promiscuous NeighborInfoModule can answer with a
 * NeighborInfo (port 71) reply whose request_id == our telemetry request's
 * packet id, hijacking the reply. The hijack arms the node's 3-minute cooldown,
 * so an immediate retry returns real telemetry. These tests cover the manager
 * bookkeeping + one-shot auto-retry.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetNode = vi.fn();
const mockUpsertNode = vi.fn();
const mockGetNodesByNums = vi.fn();
const mockDeleteNeighbor = vi.fn();
const mockInsertNeighborBatch = vi.fn();

vi.mock('../services/database.js', () => ({
  default: {
    getSetting: vi.fn(),
    nodes: {
      getNode: mockGetNode,
      getNodesByNums: mockGetNodesByNums,
    },
    neighbors: {
      deleteNeighborInfoForNode: mockDeleteNeighbor,
      insertNeighborInfoBatch: mockInsertNeighborBatch,
    },
    upsertNodeAsync: mockUpsertNode,
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const DEST = 0x0a0b0c0d;
const CHANNEL = 2;
const REQ_ID = 0x12345678;

/** A minimal inbound NeighborInfo MeshPacket carrying decoded.requestId. */
function neighborInfoPacket(requestId: number) {
  return {
    from: 0x0a0b0c0d,
    id: 0x99990000,
    decoded: { portnum: 71, requestId },
  };
}

describe('MeshtasticManager - telemetry NeighborInfo hijack auto-retry (#4210)', () => {
  let manager: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetNode.mockResolvedValue({ nodeNum: DEST, hopsAway: 1 });
    mockGetNodesByNums.mockResolvedValue(new Map());
    mockUpsertNode.mockResolvedValue(undefined);
    mockDeleteNeighbor.mockResolvedValue(undefined);
    mockInsertNeighborBatch.mockResolvedValue(undefined);

    const module = await import('./meshtasticManager.js');
    manager = module.default;
    manager.pendingTelemetryRequests.clear();
    manager.sourceId = 'default';
  });

  function seedPending(overrides: Partial<any> = {}) {
    manager.pendingTelemetryRequests.set(REQ_ID, {
      destination: DEST,
      channel: CHANNEL,
      telemetryType: 'environment',
      sentAt: Date.now(),
      retried: false,
      ...overrides,
    });
  }

  it('auto-retries exactly once when an inbound NeighborInfo matches a pending telemetry request', async () => {
    seedPending();
    const sendSpy = vi.spyOn(manager, 'sendTelemetryRequest').mockResolvedValue({ packetId: 1, requestId: 1 });

    await manager.processNeighborInfoProtobuf(neighborInfoPacket(REQ_ID), { neighbors: [] });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith(DEST, CHANNEL, 'environment', { isAutoRetry: true });
    // Pending entry is marked retried so a duplicate NeighborInfo won't re-fire.
    expect(manager.pendingTelemetryRequests.get(REQ_ID)?.retried).toBe(true);
    sendSpy.mockRestore();
  });

  it('still processes/stores the NeighborInfo neighbor data (does not drop it)', async () => {
    seedPending();
    const sendSpy = vi.spyOn(manager, 'sendTelemetryRequest').mockResolvedValue({ packetId: 1, requestId: 1 });

    await manager.processNeighborInfoProtobuf(
      neighborInfoPacket(REQ_ID),
      { neighbors: [{ nodeId: 0x55555555, snr: 5, lastRxTime: 100 }] }
    );

    // Retry fired AND neighbor rows were persisted.
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(mockDeleteNeighbor).toHaveBeenCalledWith(0x0a0b0c0d, 'default');
    expect(mockInsertNeighborBatch).toHaveBeenCalledTimes(1);
    const [records] = mockInsertNeighborBatch.mock.calls[0];
    expect(records).toHaveLength(1);
    expect(records[0].neighborNodeNum).toBe(0x55555555);
    sendSpy.mockRestore();
  });

  it('does not retry when a matching telemetry reply already cleared the pending entry', async () => {
    seedPending();
    // Simulate the telemetry reply resolving the pending request.
    manager.resolvePendingTelemetryRequest(REQ_ID);
    expect(manager.pendingTelemetryRequests.has(REQ_ID)).toBe(false);

    const sendSpy = vi.spyOn(manager, 'sendTelemetryRequest').mockResolvedValue({ packetId: 1, requestId: 1 });
    await manager.processNeighborInfoProtobuf(neighborInfoPacket(REQ_ID), { neighbors: [] });
    expect(sendSpy).not.toHaveBeenCalled();
    sendSpy.mockRestore();
  });

  it('does not retry for a NeighborInfo whose request_id does not match any pending request', async () => {
    seedPending();
    const sendSpy = vi.spyOn(manager, 'sendTelemetryRequest').mockResolvedValue({ packetId: 1, requestId: 1 });

    await manager.processNeighborInfoProtobuf(neighborInfoPacket(0xdeadbeef), { neighbors: [] });

    expect(sendSpy).not.toHaveBeenCalled();
    // Unrelated pending entry is untouched.
    expect(manager.pendingTelemetryRequests.get(REQ_ID)?.retried).toBe(false);
    sendSpy.mockRestore();
  });

  it('does not retry for an unsolicited NeighborInfo (no request_id, no pending request)', async () => {
    // No pending entries seeded.
    const sendSpy = vi.spyOn(manager, 'sendTelemetryRequest').mockResolvedValue({ packetId: 1, requestId: 1 });

    await manager.processNeighborInfoProtobuf(
      { from: 0x0a0b0c0d, id: 1, decoded: { portnum: 71 } },
      { neighbors: [] }
    );

    expect(sendSpy).not.toHaveBeenCalled();
    sendSpy.mockRestore();
  });

  it('retries at most once — a second matching NeighborInfo does not re-fire', async () => {
    seedPending();
    const sendSpy = vi.spyOn(manager, 'sendTelemetryRequest').mockResolvedValue({ packetId: 1, requestId: 1 });

    await manager.processNeighborInfoProtobuf(neighborInfoPacket(REQ_ID), { neighbors: [] });
    await manager.processNeighborInfoProtobuf(neighborInfoPacket(REQ_ID), { neighbors: [] });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    sendSpy.mockRestore();
  });

  it('does not retry a pending request that has expired past its TTL', async () => {
    // sentAt well beyond the 3-minute TTL.
    seedPending({ sentAt: Date.now() - (4 * 60 * 1000) });
    const sendSpy = vi.spyOn(manager, 'sendTelemetryRequest').mockResolvedValue({ packetId: 1, requestId: 1 });

    await manager.processNeighborInfoProtobuf(neighborInfoPacket(REQ_ID), { neighbors: [] });

    expect(sendSpy).not.toHaveBeenCalled();
    // Expired entry is pruned.
    expect(manager.pendingTelemetryRequests.has(REQ_ID)).toBe(false);
    sendSpy.mockRestore();
  });

  it('records an outgoing telemetry request as pending, keyed by packet id', async () => {
    // Drive the record helper directly (avoids the transport/protobuf machinery).
    manager.recordPendingTelemetryRequest(REQ_ID, DEST, CHANNEL, 'device', false);
    const entry = manager.pendingTelemetryRequests.get(REQ_ID);
    expect(entry).toMatchObject({ destination: DEST, channel: CHANNEL, telemetryType: 'device', retried: false });
  });

  it('bounds the pending map size and prunes expired entries', () => {
    // Insert one already-expired entry, then many fresh ones over the cap.
    manager.pendingTelemetryRequests.set(1, { destination: DEST, channel: 0, sentAt: Date.now() - (5 * 60 * 1000), retried: false });
    for (let i = 2; i < 400; i++) {
      manager.recordPendingTelemetryRequest(i, DEST, 0, 'device', false);
    }
    // Expired entry gone; size capped at the configured max.
    expect(manager.pendingTelemetryRequests.has(1)).toBe(false);
    expect(manager.pendingTelemetryRequests.size).toBeLessThanOrEqual(256);
  });
});
