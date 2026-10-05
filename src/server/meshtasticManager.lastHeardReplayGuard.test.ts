/**
 * Regression tests for #4192 / #4445 — the replay guard (replayGuard.ts) was
 * only wired into the generic packet upsert and NodeInfo handling. Position,
 * telemetry, paxcounter, and Store & Forward heartbeat packets stamped
 * `lastHeard: Date.now() / 1000` unconditionally, so a firmware-2.8 PhoneAPI
 * replay of cached position/telemetry (old `rx_time`, per-node) still made an
 * offline node look freshly heard even though the generic-packet path (and
 * its per-transport `transportLastRf`/`transportLastUdp` stamps) correctly
 * froze `lastHeard` at the true last-contact time — exactly the symptom
 * reported in #4445 (lastHeard newer than both transport timestamps).
 *
 * These tests drive each fixed handler directly with a stale (`rxTime` >6h
 * old) and a fresh packet, asserting `lastHeard` passed to `upsertNodeAsync`
 * is `undefined` (preserved) for the stale case and a live timestamp for the
 * fresh case.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockUpsertNodeAsync = vi.fn().mockResolvedValue(undefined);
const mockGetNode = vi.fn().mockResolvedValue(null);
const mockInsertTelemetry = vi.fn().mockResolvedValue(undefined);
const mockGetDirectMessages = vi.fn().mockResolvedValue([]);
const mockGetMessage = vi.fn().mockResolvedValue(null);

vi.mock('../services/database.js', () => ({
  default: {
    upsertNodeAsync: mockUpsertNodeAsync,
    nodes: { getNode: mockGetNode, upsertNode: vi.fn(), getAllNodes: vi.fn().mockResolvedValue([]) },
    telemetry: { insertTelemetry: mockInsertTelemetry },
    messages: { getDirectMessages: mockGetDirectMessages, getMessage: mockGetMessage },
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Loaded once while the file is collected, not inside a hook. A dynamic import in
// `beforeEach` charged the manager's module load (~2 s idle, 10 s+ on a busy
// host) to the first test's hook budget; collection has no such budget.
const managerModule = await import('./meshtasticManager.js');

describe('MeshtasticManager - lastHeard replay guard coverage (#4192/#4445)', () => {
  let manager: any;
  // A pinned clock, not the wall clock. `nowSec` used to be read while the file
  // was collected and compared with the `Date.now()` the manager read during the
  // test; a slow module load put more than the 5 s tolerance between the two.
  // With `Date` faked the manager reads exactly NOW_MS, so the stamps are exact.
  const NOW_MS = Date.UTC(2026, 0, 15, 12, 0, 0);
  const nowSec = NOW_MS / 1000;
  const staleRxTime = nowSec - 24 * 60 * 60; // 24h old — well past the 6h threshold
  const freshRxTime = nowSec - 30; // 30s old — clearly live

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_MS);
    vi.clearAllMocks();
    mockGetNode.mockResolvedValue(null);
    mockGetDirectMessages.mockResolvedValue([]);
    mockGetMessage.mockResolvedValue(null);
    manager = managerModule.fallbackManager;
    vi.spyOn(manager, 'trackPKIEncryption').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function lastHeardArg(): number | undefined {
    expect(mockUpsertNodeAsync).toHaveBeenCalled();
    const call = mockUpsertNodeAsync.mock.calls[mockUpsertNodeAsync.mock.calls.length - 1];
    return call[0].lastHeard;
  }

  describe('processTelemetryMessageProtobuf', () => {
    it('does not advance lastHeard for a stale/replayed telemetry packet', async () => {
      const meshPacket = { from: 0x11111111, id: 1, rxTime: staleRxTime };
      await manager.processTelemetryMessageProtobuf(meshPacket, {
        deviceMetrics: { batteryLevel: 90 },
      });

      expect(lastHeardArg()).toBeUndefined();
    });

    it('advances lastHeard for a live telemetry packet', async () => {
      const meshPacket = { from: 0x11111111, id: 2, rxTime: freshRxTime };
      await manager.processTelemetryMessageProtobuf(meshPacket, {
        deviceMetrics: { batteryLevel: 90 },
      });

      expect(lastHeardArg()).toBe(nowSec);
    });
  });

  describe('processPaxcounterMessageProtobuf', () => {
    it('does not advance lastHeard for a stale/replayed paxcounter packet', async () => {
      const meshPacket = { from: 0x22222222, id: 3, rxTime: staleRxTime };
      await manager.processPaxcounterMessageProtobuf(meshPacket, { wifi: 5, ble: 2 });

      expect(lastHeardArg()).toBeUndefined();
    });

    it('advances lastHeard for a live paxcounter packet', async () => {
      const meshPacket = { from: 0x22222222, id: 4, rxTime: freshRxTime };
      await manager.processPaxcounterMessageProtobuf(meshPacket, { wifi: 5, ble: 2 });

      expect(lastHeardArg()).toBe(nowSec);
    });
  });

  describe('processStoreForwardMessage — ROUTER_HEARTBEAT', () => {
    const ROUTER_HEARTBEAT = 2;

    it('does not advance lastHeard for a stale/replayed S&F heartbeat', async () => {
      const meshPacket = { from: 0x33333333, id: 5, rxTime: staleRxTime };
      await manager.processStoreForwardMessage(meshPacket, {
        rr: ROUTER_HEARTBEAT,
        heartbeat: { period: 900, secondary: 0 },
      });

      expect(lastHeardArg()).toBeUndefined();
    });

    it('advances lastHeard for a live S&F heartbeat', async () => {
      const meshPacket = { from: 0x33333333, id: 6, rxTime: freshRxTime };
      await manager.processStoreForwardMessage(meshPacket, {
        rr: ROUTER_HEARTBEAT,
        heartbeat: { period: 900, secondary: 0 },
      });

      expect(lastHeardArg()).toBe(nowSec);
    });
  });

  describe('processPositionMessageProtobuf', () => {
    // latitudeI/longitudeI are degrees * 1e7 on the wire.
    const position = { latitudeI: 407128000, longitudeI: -740060000, altitude: 10 };

    it('does not advance lastHeard for a stale/replayed position packet', async () => {
      const meshPacket = { from: 0x44444444, id: 7, rxTime: staleRxTime };
      await manager.processPositionMessageProtobuf(meshPacket, position);

      expect(lastHeardArg()).toBeUndefined();
    });

    it('advances lastHeard for a live position packet', async () => {
      const meshPacket = { from: 0x44444444, id: 8, rxTime: freshRxTime };
      await manager.processPositionMessageProtobuf(meshPacket, position);

      expect(lastHeardArg()).toBe(nowSec);
    });

    // #5401: positionTimestamp is when the fix was OBSERVED. A NodeDB replay
    // stamped with "now" re-dated a stale fix as the freshest one, so it
    // outranked a newer fix from another source in the unified merge.
    function positionTimestampArg(): number | undefined {
      const withPos = mockUpsertNodeAsync.mock.calls.filter((c: any[]) => c[0].latitude != null);
      expect(withPos.length).toBeGreaterThan(0);
      return withPos[withPos.length - 1][0].positionTimestamp;
    }

    it('stamps a replayed position with its original rx_time, not now (#5401)', async () => {
      const meshPacket = { from: 0x44444444, id: 9, rxTime: staleRxTime };
      await manager.processPositionMessageProtobuf(meshPacket, position);

      expect(positionTimestampArg()).toBe(staleRxTime * 1000);
    });

    it('stamps a live position with now (#5401)', async () => {
      const meshPacket = { from: 0x44444444, id: 10, rxTime: freshRxTime };
      await manager.processPositionMessageProtobuf(meshPacket, position);

      expect(positionTimestampArg()).toBe(NOW_MS);
    });
  });

  // #5401: a NodeInfo from the radio's NodeDB carries whatever position the
  // radio last stored, possibly days old. It must be dated by the fix's own
  // time (or the radio's lastHeard), never by "now".
  describe('processNodeInfoProtobuf position timestamp (#5401)', () => {
    const nodeNum = 0x55555555;
    function nodeInfoTimestampArg(): number | undefined {
      const withPos = mockUpsertNodeAsync.mock.calls.filter((c: any[]) => c[0].latitude != null);
      expect(withPos.length).toBeGreaterThan(0);
      return withPos[withPos.length - 1][0].positionTimestamp;
    }

    it("dates a NodeDB position by the fix's own time", async () => {
      const fixTime = nowSec - 2 * 24 * 60 * 60;
      await manager.processNodeInfoProtobuf({
        num: nodeNum,
        lastHeard: nowSec - 60,
        position: { latitudeI: 407128000, longitudeI: -740060000, altitude: 800, time: fixTime, precisionBits: 32 },
      });
      expect(nodeInfoTimestampArg()).toBe(fixTime * 1000);
    });

    it("falls back to the radio's lastHeard when the fix has no time", async () => {
      await manager.processNodeInfoProtobuf({
        num: nodeNum,
        lastHeard: nowSec - 600,
        position: { latitudeI: 407128000, longitudeI: -740060000, altitude: 800 },
      });
      expect(nodeInfoTimestampArg()).toBe((nowSec - 600) * 1000);
    });

    it('leaves the stored stamp alone when neither time is known', async () => {
      await manager.processNodeInfoProtobuf({
        num: nodeNum,
        position: { latitudeI: 407128000, longitudeI: -740060000, altitude: 800 },
      });
      expect(nodeInfoTimestampArg()).toBeUndefined();
    });
  });
});
