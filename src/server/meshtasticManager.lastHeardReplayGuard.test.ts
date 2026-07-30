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

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

describe('MeshtasticManager - lastHeard replay guard coverage (#4192/#4445)', () => {
  let manager: any;
  const nowSec = Math.floor(Date.now() / 1000);
  const staleRxTime = nowSec - 24 * 60 * 60; // 24h old — well past the 6h threshold
  const freshRxTime = nowSec - 30; // 30s old — clearly live

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetNode.mockResolvedValue(null);
    mockGetDirectMessages.mockResolvedValue([]);
    mockGetMessage.mockResolvedValue(null);
    const module = await import('./meshtasticManager.js');
    manager = module.fallbackManager;
    vi.spyOn(manager, 'trackPKIEncryption').mockResolvedValue(undefined);
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

      expect(lastHeardArg()).toBeCloseTo(nowSec, -1);
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

      expect(lastHeardArg()).toBeCloseTo(nowSec, -1);
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

      expect(lastHeardArg()).toBeCloseTo(nowSec, -1);
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

      expect(lastHeardArg()).toBeCloseTo(nowSec, -1);
    });
  });
});
