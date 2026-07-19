/**
 * Tests for the TELEMETRY_APP → NeighborInfo hijack detect-and-auto-retry
 * (issue #4210 / meshtastic/firmware#11071).
 *
 * When we send a telemetry want_response to a remote node that has neighbor_info
 * enabled, the firmware's promiscuous NeighborInfoModule can answer with a
 * NeighborInfo (port 71) reply whose request_id == our telemetry request's
 * packet id, hijacking the reply. The hijack arms the node's 3-minute cooldown,
 * so a retry returns real telemetry — but because LoRa is half-duplex the retry
 * must be DELAYED (an instant retry reaches the node while it is still
 * transmitting and is dropped; verified twice on hardware). These tests cover
 * the manager bookkeeping + the delayed, one-shot auto-retry.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
const RETRY_DELAY_MS = 5000;

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
    vi.useFakeTimers();
    mockGetNode.mockResolvedValue({ nodeNum: DEST, hopsAway: 1 });
    mockGetNodesByNums.mockResolvedValue(new Map());
    mockUpsertNode.mockResolvedValue(undefined);
    mockDeleteNeighbor.mockResolvedValue(undefined);
    mockInsertNeighborBatch.mockResolvedValue(undefined);

    const module = await import('./meshtasticManager.js');
    manager = module.default;
    manager.pendingTelemetryRequests.clear();
    for (const t of manager.telemetryRetryTimers) clearTimeout(t);
    manager.telemetryRetryTimers.clear();
    manager.sourceId = 'default';
    // The delayed retry only fires while the manager is connected.
    manager.isConnected = true;
    manager.transport = { disconnect: vi.fn() };
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it('does not retry immediately, then auto-retries exactly once after the delay', async () => {
    seedPending();
    const sendSpy = vi.spyOn(manager, 'sendTelemetryRequest').mockResolvedValue({ packetId: 1, requestId: 1 });

    await manager.processNeighborInfoProtobuf(neighborInfoPacket(REQ_ID), { neighbors: [] });

    // Retry is scheduled, NOT fired inline.
    expect(sendSpy).not.toHaveBeenCalled();
    // Pending entry is marked retried immediately so a duplicate NeighborInfo won't re-fire.
    expect(manager.pendingTelemetryRequests.get(REQ_ID)?.retried).toBe(true);

    // Not yet at the delay boundary.
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS - 1);
    expect(sendSpy).not.toHaveBeenCalled();

    // Delay elapses → the retry fires exactly once with the same args.
    await vi.advanceTimersByTimeAsync(1);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith(DEST, CHANNEL, 'environment', { isAutoRetry: true });
    sendSpy.mockRestore();
  });

  it('still processes/stores the NeighborInfo neighbor data (does not drop it)', async () => {
    seedPending();
    const sendSpy = vi.spyOn(manager, 'sendTelemetryRequest').mockResolvedValue({ packetId: 1, requestId: 1 });

    await manager.processNeighborInfoProtobuf(
      neighborInfoPacket(REQ_ID),
      { neighbors: [{ nodeId: 0x55555555, snr: 5, lastRxTime: 100 }] }
    );

    // Neighbor rows persisted regardless of the (delayed) retry.
    expect(mockDeleteNeighbor).toHaveBeenCalledWith(0x0a0b0c0d, 'default');
    expect(mockInsertNeighborBatch).toHaveBeenCalledTimes(1);
    const [records] = mockInsertNeighborBatch.mock.calls[0];
    expect(records).toHaveLength(1);
    expect(records[0].neighborNodeNum).toBe(0x55555555);

    // And the retry still fires after the delay.
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    sendSpy.mockRestore();
  });

  it('does not retry when a matching telemetry reply already cleared the pending entry', async () => {
    seedPending();
    // Simulate the telemetry reply resolving the pending request.
    manager.resolvePendingTelemetryRequest(REQ_ID);
    expect(manager.pendingTelemetryRequests.has(REQ_ID)).toBe(false);

    const sendSpy = vi.spyOn(manager, 'sendTelemetryRequest').mockResolvedValue({ packetId: 1, requestId: 1 });
    await manager.processNeighborInfoProtobuf(neighborInfoPacket(REQ_ID), { neighbors: [] });
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    expect(sendSpy).not.toHaveBeenCalled();
    sendSpy.mockRestore();
  });

  it('does not retry for a NeighborInfo whose request_id does not match any pending request', async () => {
    seedPending();
    const sendSpy = vi.spyOn(manager, 'sendTelemetryRequest').mockResolvedValue({ packetId: 1, requestId: 1 });

    await manager.processNeighborInfoProtobuf(neighborInfoPacket(0xdeadbeef), { neighbors: [] });
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);

    expect(sendSpy).not.toHaveBeenCalled();
    // Unrelated pending entry is untouched.
    expect(manager.pendingTelemetryRequests.get(REQ_ID)?.retried).toBe(false);
    sendSpy.mockRestore();
  });

  it('does not retry for an unsolicited NeighborInfo (no request_id, no pending request)', async () => {
    const sendSpy = vi.spyOn(manager, 'sendTelemetryRequest').mockResolvedValue({ packetId: 1, requestId: 1 });

    await manager.processNeighborInfoProtobuf(
      { from: 0x0a0b0c0d, id: 1, decoded: { portnum: 71 } },
      { neighbors: [] }
    );
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);

    expect(sendSpy).not.toHaveBeenCalled();
    sendSpy.mockRestore();
  });

  it('retries at most once — a second matching NeighborInfo during the delay window does not schedule a second retry', async () => {
    seedPending();
    const sendSpy = vi.spyOn(manager, 'sendTelemetryRequest').mockResolvedValue({ packetId: 1, requestId: 1 });

    // First hijack schedules the retry.
    await manager.processNeighborInfoProtobuf(neighborInfoPacket(REQ_ID), { neighbors: [] });
    // Second hijack arrives mid-delay — must NOT schedule another retry.
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS / 2);
    await manager.processNeighborInfoProtobuf(neighborInfoPacket(REQ_ID), { neighbors: [] });

    // Let all timers drain.
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    sendSpy.mockRestore();
  });

  it('does not fire the retry if the manager disconnected before the timer elapses', async () => {
    seedPending();
    const sendSpy = vi.spyOn(manager, 'sendTelemetryRequest').mockResolvedValue({ packetId: 1, requestId: 1 });

    await manager.processNeighborInfoProtobuf(neighborInfoPacket(REQ_ID), { neighbors: [] });
    // In-flight timer guard: manager loses connection before the delay elapses.
    manager.isConnected = false;
    manager.transport = null;

    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    expect(sendSpy).not.toHaveBeenCalled();
    sendSpy.mockRestore();
  });

  it('disconnect() cancels scheduled retry timers and clears pending requests', async () => {
    seedPending();
    const sendSpy = vi.spyOn(manager, 'sendTelemetryRequest').mockResolvedValue({ packetId: 1, requestId: 1 });

    await manager.processNeighborInfoProtobuf(neighborInfoPacket(REQ_ID), { neighbors: [] });
    expect(manager.telemetryRetryTimers.size).toBe(1);

    manager.disconnect();
    expect(manager.telemetryRetryTimers.size).toBe(0);
    expect(manager.pendingTelemetryRequests.size).toBe(0);

    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    expect(sendSpy).not.toHaveBeenCalled();
    sendSpy.mockRestore();
  });

  it('does not retry a pending request that has expired past its TTL', async () => {
    // sentAt well beyond the 3-minute TTL.
    seedPending({ sentAt: Date.now() - (4 * 60 * 1000) });
    const sendSpy = vi.spyOn(manager, 'sendTelemetryRequest').mockResolvedValue({ packetId: 1, requestId: 1 });

    await manager.processNeighborInfoProtobuf(neighborInfoPacket(REQ_ID), { neighbors: [] });
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);

    expect(sendSpy).not.toHaveBeenCalled();
    // Expired entry is pruned.
    expect(manager.pendingTelemetryRequests.has(REQ_ID)).toBe(false);
    sendSpy.mockRestore();
  });

  it('records an outgoing telemetry request as pending, keyed by packet id', () => {
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
