/**
 * Tests for the TELEMETRY_APP → NeighborInfo hijack detect-and-auto-retry
 * (issue #4210 / meshtastic/firmware#11071).
 *
 * When we send a telemetry want_response to a remote node that has neighbor_info
 * enabled, the firmware's promiscuous NeighborInfoModule can answer with a
 * NeighborInfo (port 71) reply whose request_id == our telemetry request's
 * packet id, hijacking the reply. The hijack arms the node's 3-minute cooldown,
 * so a retry returns real telemetry — but the hijacking NeighborInfo is
 * want_ack'd and the node keeps retransmitting it for ~10-30s, so an
 * instant/5s retry is dropped (hardware delay-sweep: 5s recovered 0/4, ~38s
 * recovered cleanly). We therefore schedule TWO spaced retries at 30s and 70s
 * inside the 3-min cooldown. These tests cover the bookkeeping + the schedule.
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
const RETRY_1_MS = 30000; // retry #1 at 30s from hijack
const RETRY_2_MS = 70000; // retry #2 at 70s from hijack
const DELTA_1_TO_2_MS = RETRY_2_MS - RETRY_1_MS; // 40s between retry #1 and #2

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
    manager = module.fallbackManager;
    manager.pendingTelemetryRequests.clear();
    for (const t of manager.telemetryRetryTimers) clearTimeout(t);
    manager.telemetryRetryTimers.clear();
    manager.sourceId = 'default';
    // The delayed retries only fire while the manager is connected.
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
      resolved: false,
      packetIds: new Set([REQ_ID]),
      retryTimers: [],
      ...overrides,
    });
  }

  it('does not retry before 30s, then fires retry #1 exactly at 30s', async () => {
    seedPending();
    const sendSpy = vi.spyOn(manager, 'sendTelemetryRequest').mockResolvedValue({ packetId: 111, requestId: 111 });

    await manager.processNeighborInfoProtobuf(neighborInfoPacket(REQ_ID), { neighbors: [] });

    // Scheduled, not fired inline; sequence marked retried immediately (loop-guard).
    expect(sendSpy).not.toHaveBeenCalled();
    expect(manager.pendingTelemetryRequests.get(REQ_ID)?.retried).toBe(true);

    await vi.advanceTimersByTimeAsync(RETRY_1_MS - 1);
    expect(sendSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith(DEST, CHANNEL, 'environment', { isAutoRetry: true });
    sendSpy.mockRestore();
  });

  it('fires retry #2 at 70s when the request is still unresolved', async () => {
    seedPending();
    const sendSpy = vi.spyOn(manager, 'sendTelemetryRequest').mockResolvedValue({ packetId: 111, requestId: 111 });

    await manager.processNeighborInfoProtobuf(neighborInfoPacket(REQ_ID), { neighbors: [] });

    await vi.advanceTimersByTimeAsync(RETRY_1_MS); // retry #1
    expect(sendSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(DELTA_1_TO_2_MS - 1); // just before 70s
    expect(sendSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1); // retry #2 at 70s
    expect(sendSpy).toHaveBeenCalledTimes(2);
    sendSpy.mockRestore();
  });

  it('a telemetry reply before 30s cancels BOTH retries', async () => {
    seedPending();
    const sendSpy = vi.spyOn(manager, 'sendTelemetryRequest').mockResolvedValue({ packetId: 111, requestId: 111 });

    await manager.processNeighborInfoProtobuf(neighborInfoPacket(REQ_ID), { neighbors: [] });
    // Telemetry reply arrives at ~15s.
    await vi.advanceTimersByTimeAsync(15000);
    manager.resolvePendingTelemetryRequest(REQ_ID);

    await vi.advanceTimersByTimeAsync(RETRY_2_MS);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(manager.telemetryRetryTimers.size).toBe(0);
    sendSpy.mockRestore();
  });

  it('a telemetry reply between 30s and 70s cancels retry #2 (only retry #1 sent)', async () => {
    seedPending();
    const sendSpy = vi.spyOn(manager, 'sendTelemetryRequest').mockResolvedValue({ packetId: 111, requestId: 111 });

    await manager.processNeighborInfoProtobuf(neighborInfoPacket(REQ_ID), { neighbors: [] });
    await vi.advanceTimersByTimeAsync(RETRY_1_MS); // retry #1 fires + schedules retry #2
    expect(sendSpy).toHaveBeenCalledTimes(1);

    // Telemetry reply to retry #1 arrives at ~45s → resolve by the retry's packet id.
    await vi.advanceTimersByTimeAsync(15000);
    manager.resolvePendingTelemetryRequest(111);

    await vi.advanceTimersByTimeAsync(RETRY_2_MS);
    expect(sendSpy).toHaveBeenCalledTimes(1); // retry #2 cancelled
    sendSpy.mockRestore();
  });

  it('still processes/stores the NeighborInfo neighbor data (does not drop it)', async () => {
    seedPending();
    const sendSpy = vi.spyOn(manager, 'sendTelemetryRequest').mockResolvedValue({ packetId: 111, requestId: 111 });

    await manager.processNeighborInfoProtobuf(
      neighborInfoPacket(REQ_ID),
      { neighbors: [{ nodeId: 0x55555555, snr: 5, lastRxTime: 100 }] }
    );

    expect(mockDeleteNeighbor).toHaveBeenCalledWith(0x0a0b0c0d, 'default');
    expect(mockInsertNeighborBatch).toHaveBeenCalledTimes(1);
    const [records] = mockInsertNeighborBatch.mock.calls[0];
    expect(records).toHaveLength(1);
    expect(records[0].neighborNodeNum).toBe(0x55555555);

    await vi.advanceTimersByTimeAsync(RETRY_1_MS);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    sendSpy.mockRestore();
  });

  it('does not retry when a matching telemetry reply already cleared the pending entry', async () => {
    seedPending();
    manager.resolvePendingTelemetryRequest(REQ_ID);
    expect(manager.pendingTelemetryRequests.has(REQ_ID)).toBe(false);

    const sendSpy = vi.spyOn(manager, 'sendTelemetryRequest').mockResolvedValue({ packetId: 111, requestId: 111 });
    await manager.processNeighborInfoProtobuf(neighborInfoPacket(REQ_ID), { neighbors: [] });
    await vi.advanceTimersByTimeAsync(RETRY_2_MS);
    expect(sendSpy).not.toHaveBeenCalled();
    sendSpy.mockRestore();
  });

  it('does not retry for a NeighborInfo whose request_id does not match any pending request', async () => {
    seedPending();
    const sendSpy = vi.spyOn(manager, 'sendTelemetryRequest').mockResolvedValue({ packetId: 111, requestId: 111 });

    await manager.processNeighborInfoProtobuf(neighborInfoPacket(0xdeadbeef), { neighbors: [] });
    await vi.advanceTimersByTimeAsync(RETRY_2_MS);

    expect(sendSpy).not.toHaveBeenCalled();
    expect(manager.pendingTelemetryRequests.get(REQ_ID)?.retried).toBe(false);
    sendSpy.mockRestore();
  });

  it('does not retry for an unsolicited NeighborInfo (no request_id, no pending request)', async () => {
    const sendSpy = vi.spyOn(manager, 'sendTelemetryRequest').mockResolvedValue({ packetId: 111, requestId: 111 });

    await manager.processNeighborInfoProtobuf(
      { from: 0x0a0b0c0d, id: 1, decoded: { portnum: 71 } },
      { neighbors: [] }
    );
    await vi.advanceTimersByTimeAsync(RETRY_2_MS);

    expect(sendSpy).not.toHaveBeenCalled();
    sendSpy.mockRestore();
  });

  it('starts the recovery sequence at most once — a second matching NeighborInfo mid-window does not add retries', async () => {
    seedPending();
    const sendSpy = vi.spyOn(manager, 'sendTelemetryRequest').mockResolvedValue({ packetId: 111, requestId: 111 });

    // First hijack starts the sequence.
    await manager.processNeighborInfoProtobuf(neighborInfoPacket(REQ_ID), { neighbors: [] });
    // Second hijack arrives before retry #1 — must be ignored.
    await vi.advanceTimersByTimeAsync(RETRY_1_MS / 2);
    await manager.processNeighborInfoProtobuf(neighborInfoPacket(REQ_ID), { neighbors: [] });

    // Full timeline: exactly retry #1 + retry #2 = 2 sends, not 4.
    await vi.advanceTimersByTimeAsync(RETRY_2_MS);
    expect(sendSpy).toHaveBeenCalledTimes(2);
    sendSpy.mockRestore();
  });

  it('does not fire retries if the manager disconnected before the timer elapses', async () => {
    seedPending();
    const sendSpy = vi.spyOn(manager, 'sendTelemetryRequest').mockResolvedValue({ packetId: 111, requestId: 111 });

    await manager.processNeighborInfoProtobuf(neighborInfoPacket(REQ_ID), { neighbors: [] });
    manager.isConnected = false;
    manager.transport = null;

    await vi.advanceTimersByTimeAsync(RETRY_2_MS);
    expect(sendSpy).not.toHaveBeenCalled();
    sendSpy.mockRestore();
  });

  it('disconnect() cancels ALL scheduled retry timers and clears pending requests', async () => {
    seedPending();
    const sendSpy = vi.spyOn(manager, 'sendTelemetryRequest').mockResolvedValue({ packetId: 111, requestId: 111 });

    await manager.processNeighborInfoProtobuf(neighborInfoPacket(REQ_ID), { neighbors: [] });
    expect(manager.telemetryRetryTimers.size).toBe(1);

    manager.disconnect();
    expect(manager.telemetryRetryTimers.size).toBe(0);
    expect(manager.pendingTelemetryRequests.size).toBe(0);

    await vi.advanceTimersByTimeAsync(RETRY_2_MS);
    expect(sendSpy).not.toHaveBeenCalled();
    sendSpy.mockRestore();
  });

  it('TTL (3 min) comfortably covers the full 70s two-retry schedule', async () => {
    seedPending();
    const sendSpy = vi.spyOn(manager, 'sendTelemetryRequest').mockResolvedValue({ packetId: 111, requestId: 111 });

    await manager.processNeighborInfoProtobuf(neighborInfoPacket(REQ_ID), { neighbors: [] });
    // Advance across the whole schedule; the entry must not expire before retry #2.
    await vi.advanceTimersByTimeAsync(RETRY_2_MS);
    expect(sendSpy).toHaveBeenCalledTimes(2);
    sendSpy.mockRestore();
  });

  it('does not retry a pending request that has expired past its TTL', async () => {
    seedPending({ sentAt: Date.now() - (4 * 60 * 1000) });
    const sendSpy = vi.spyOn(manager, 'sendTelemetryRequest').mockResolvedValue({ packetId: 111, requestId: 111 });

    await manager.processNeighborInfoProtobuf(neighborInfoPacket(REQ_ID), { neighbors: [] });
    await vi.advanceTimersByTimeAsync(RETRY_2_MS);

    expect(sendSpy).not.toHaveBeenCalled();
    expect(manager.pendingTelemetryRequests.has(REQ_ID)).toBe(false);
    sendSpy.mockRestore();
  });

  it('records an outgoing telemetry request as pending, keyed by packet id', () => {
    manager.recordPendingTelemetryRequest(REQ_ID, DEST, CHANNEL, 'device');
    const entry = manager.pendingTelemetryRequests.get(REQ_ID);
    expect(entry).toMatchObject({ destination: DEST, channel: CHANNEL, telemetryType: 'device', retried: false, resolved: false });
    expect([...entry.packetIds]).toEqual([REQ_ID]);
  });

  it('bounds the pending map size and prunes expired entries', () => {
    manager.pendingTelemetryRequests.set(1, {
      destination: DEST, channel: 0, sentAt: Date.now() - (5 * 60 * 1000),
      retried: false, resolved: false, packetIds: new Set([1]), retryTimers: [],
    });
    for (let i = 2; i < 400; i++) {
      manager.recordPendingTelemetryRequest(i, DEST, 0, 'device');
    }
    expect(manager.pendingTelemetryRequests.has(1)).toBe(false);
    expect(manager.pendingTelemetryRequests.size).toBeLessThanOrEqual(256);
  });
});
