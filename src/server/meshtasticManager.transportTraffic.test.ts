/**
 * Counter-hook coverage for #5101 Phase 3 WP3 — the per-transport RX counter
 * at the packet-receive seam in `meshtasticManager.ts` (~L6436, right after
 * `txColumn`/`heardSec` are computed inside `processMeshPacket`).
 *
 * Modelled on `meshtasticManager.lastHeardReplayGuard.test.ts`: drives
 * `processMeshPacket` directly on the exported `fallbackManager` instance,
 * mocking only what that path touches (database, packet log, the heard-reflood
 * diagnostic write) so the real classification/gate logic runs unmocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockUpsertNodeAsync = vi.fn().mockResolvedValue(undefined);
const mockGetNode = vi.fn().mockResolvedValue(null);

vi.mock('../services/database.js', () => ({
  default: {
    upsertNodeAsync: mockUpsertNodeAsync,
    nodes: { getNode: mockGetNode, upsertNode: vi.fn(), getAllNodes: vi.fn().mockResolvedValue([]) },
    telemetry: { insertTelemetry: vi.fn().mockResolvedValue(undefined) },
    messages: { getDirectMessages: vi.fn().mockResolvedValue([]), getMessage: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));

// packet_log is opt-in; keep it off so processMeshPacket's large logging
// block (irrelevant to this hook) never runs.
vi.mock('./services/packetLogService.js', () => ({
  default: { isEnabled: vi.fn().mockResolvedValue(false), logPacket: vi.fn() },
}));

const mockRecordRx = vi.fn();
vi.mock('./services/transportTrafficService.js', () => ({
  transportTrafficService: { recordRx: mockRecordRx },
}));

const TX_LORA = 1;
const TX_MQTT = 5;
const TX_MULTICAST_UDP = 6;

describe('MeshtasticManager — transport-traffic counter hook (#5101 P3 WP3)', () => {
  let manager: any;
  const nowSec = Math.floor(Date.now() / 1000);
  const freshRxTime = nowSec - 30; // clearly live
  const staleRxTime = nowSec - 24 * 60 * 60; // well past the replay-guard threshold

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetNode.mockResolvedValue(null);
    const module = await import('./meshtasticManager.js');
    manager = module.fallbackManager;
    vi.spyOn(manager, 'trackPKIEncryption').mockResolvedValue(undefined);
    vi.spyOn(manager, 'maybeRecordHeardReflood').mockResolvedValue(undefined);
    manager.localNodeInfo = { nodeNum: 0xaaaaaaaa, nodeId: '!aaaaaaaa', longName: 'Local', shortName: 'LOCL' };
  });

  function basePacket(overrides: Record<string, unknown>) {
    return {
      id: 1,
      from: 0x11111111,
      to: 0xffffffff,
      decoded: { portnum: 1, payload: new Uint8Array() },
      rxTime: freshRxTime,
      ...overrides,
    };
  }

  it('records "rf" for a LoRa-mechanism packet', async () => {
    await manager.processMeshPacket(basePacket({ transportMechanism: TX_LORA }));
    expect(mockRecordRx).toHaveBeenCalledWith(manager.sourceId, 'rf');
  });

  it('records "mqtt" for mechanism 5 (MQTT)', async () => {
    await manager.processMeshPacket(basePacket({ transportMechanism: TX_MQTT }));
    expect(mockRecordRx).toHaveBeenCalledWith(manager.sourceId, 'mqtt');
  });

  it('records "mqtt" for viaMqtt with no explicit mechanism', async () => {
    await manager.processMeshPacket(basePacket({ transportMechanism: undefined, viaMqtt: true }));
    expect(mockRecordRx).toHaveBeenCalledWith(manager.sourceId, 'mqtt');
  });

  it('records "udp" for mechanism 6 (multicast UDP)', async () => {
    await manager.processMeshPacket(basePacket({ transportMechanism: TX_MULTICAST_UDP }));
    expect(mockRecordRx).toHaveBeenCalledWith(manager.sourceId, 'udp');
  });

  it('does not record our own node\'s packet', async () => {
    await manager.processMeshPacket(
      basePacket({ from: manager.localNodeInfo.nodeNum, transportMechanism: TX_LORA }),
    );
    expect(mockRecordRx).not.toHaveBeenCalled();
  });

  it('does not record a stale/replayed packet (heardSec undefined)', async () => {
    await manager.processMeshPacket(
      basePacket({ transportMechanism: TX_LORA, rxTime: staleRxTime }),
    );
    expect(mockRecordRx).not.toHaveBeenCalled();
  });

  describe('firmware 2.8 PhoneAPI NodeDB replay exclusion (#5034 / live-reception fix)', () => {
    // A replay is indistinguishable from a fresh LoRa reception on every field
    // except rx_time, which keeps the ORIGINAL first-heard timestamp (#5034).
    // 30 minutes is well inside the #4192 6h replay-guard threshold (so
    // `heardSec`/the node stamp are unaffected) but well outside the 120s
    // live-reception window the counter now uses.
    const replayShapedRxTime = nowSec - 30 * 60;

    it('does not record the counter for a replay-shaped packet (stable id, LORA, rx_time 30 min old)', async () => {
      await manager.processMeshPacket(
        basePacket({ id: 42, transportMechanism: TX_LORA, rxTime: replayShapedRxTime }),
      );
      expect(mockRecordRx).not.toHaveBeenCalled();
    });

    it('still stamps the node\'s lastHeard/transportLastRf for that same replay-shaped packet', async () => {
      await manager.processMeshPacket(
        basePacket({ id: 42, transportMechanism: TX_LORA, rxTime: replayShapedRxTime }),
      );
      expect(mockUpsertNodeAsync).toHaveBeenCalled();
      const call = mockUpsertNodeAsync.mock.calls[mockUpsertNodeAsync.mock.calls.length - 1];
      // stamped with "now" (not the replay's 30-min-old rx_time) — close, not
      // exact, since resolveLastHeardSec reads a fresh Date.now() internally.
      expect(call[0].lastHeard).toBeCloseTo(nowSec, -1);
      expect(call[0].transportLastRf).toBeCloseTo(nowSec, -1);
    });

    it('still records a genuinely fresh packet on the same node', async () => {
      await manager.processMeshPacket(
        basePacket({ id: 43, transportMechanism: TX_LORA, rxTime: freshRxTime }),
      );
      expect(mockRecordRx).toHaveBeenCalledWith(manager.sourceId, 'rf');
    });
  });
});
