/**
 * #6341 P5 WP2: passive clock samples from live LoRa telemetry/position.
 * Harness copied from meshtasticManager.transportTraffic.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGetTelemetryByNode = vi.fn().mockResolvedValue([]);
const mockInsertTelemetry = vi.fn().mockResolvedValue(undefined);

vi.mock('../services/database.js', () => ({
  default: {
    upsertNodeAsync: vi.fn().mockResolvedValue(undefined),
    nodes: { getNode: vi.fn().mockResolvedValue(null), upsertNode: vi.fn(), getAllNodes: vi.fn().mockResolvedValue([]) },
    telemetry: { insertTelemetry: mockInsertTelemetry, getTelemetryByNode: mockGetTelemetryByNode },
    messages: { getDirectMessages: vi.fn().mockResolvedValue([]), getMessage: vi.fn().mockResolvedValue(null) },
  },
}));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));
vi.mock('./services/packetLogService.js', () => ({
  default: { isEnabled: vi.fn().mockResolvedValue(false), logPacket: vi.fn() },
}));
vi.mock('./services/transportTrafficService.js', () => ({
  transportTrafficService: { recordRx: vi.fn() },
}));

const managerModule = await import('./meshtasticManager.js');
const protoModule = await import('./meshtasticProtobufService.js');
const { resetClockOffsetThrottleForTests } = await import('./services/meshcoreDeviceHealth.js');

const NOW_MS = Date.UTC(2026, 0, 15, 12, 0, 0);
const nowSec = NOW_MS / 1000;
const TELEMETRY_APP = 67;
const POSITION_APP = 3;

describe('MeshtasticManager clock sampling (#6341 P5)', () => {
  let manager: any;
  let payload: any;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_MS);
    vi.clearAllMocks();
    resetClockOffsetThrottleForTests();
    mockGetTelemetryByNode.mockResolvedValue([]);
    manager = managerModule.fallbackManager;
    vi.spyOn(manager, 'trackPKIEncryption').mockResolvedValue(undefined);
    vi.spyOn(manager, 'maybeRecordHeardReflood').mockResolvedValue(undefined);
    vi.spyOn(manager, 'processTelemetryMessageProtobuf').mockResolvedValue(undefined);
    vi.spyOn(manager, 'processPositionMessageProtobuf').mockResolvedValue(undefined);
    payload = { time: nowSec - 90 };
    vi.spyOn(protoModule.default, 'processPayload').mockImplementation(() => payload);
    manager.localNodeInfo = { nodeNum: 0xaaaaaaaa, nodeId: '!aaaaaaaa', longName: 'Local', shortName: 'LOCL' };
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function packet(o: Record<string, unknown> = {}, portnum = TELEMETRY_APP) {
    return {
      id: 4242,
      from: 0x11111111,
      to: 0xffffffff,
      decoded: { portnum, payload: new Uint8Array([1]) },
      rxTime: nowSec - 3,
      transportMechanism: 1,
      ...o,
    };
  }
  const run = (p: any, ctx?: any) => manager.processMeshPacket(p, ctx);
  const stored = () => mockInsertTelemetry.mock.calls.map((c) => c[0]).filter((r) => r.telemetryType === 'mc_rtc_drift_secs');

  it('stores a live LoRa telemetry sample as !hex with offset = now - senderSec', async () => {
    await run(packet());
    const rows = stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ nodeId: '!11111111', nodeNum: 0x11111111, value: 90 });
  });

  it('samples POSITION_APP too, sharing the hourly throttle', async () => {
    await run(packet({}, POSITION_APP));
    expect(stored()).toHaveLength(1);
    payload = { time: nowSec - 30 };
    await run(packet({ id: 4243 }));
    expect(stored()).toHaveLength(1);
  });

  it('skips a node with no clock (position time 0, uptime-like telemetry time)', async () => {
    payload = { time: 0 };
    await run(packet({}, POSITION_APP));
    payload = { time: 5000 };
    await run(packet());
    expect(stored()).toHaveLength(0);
    expect(mockGetTelemetryByNode).not.toHaveBeenCalled();
  });

  it.each([
    ['MQTT downlink', { viaMqtt: true, transportMechanism: undefined }, undefined],
    ['MQTT mechanism', { transportMechanism: 5 }, undefined],
    ['Store & Forward', {}, { viaStoreForward: true }],
    ['MQTT proxy', {}, { fromMqttProxy: true }],
    ['Virtual Node request', {}, { virtualNodeRequestId: 9 }],
    ['wrong local clock', { rxTime: nowSec - 3600 }, undefined],
    ['local node', { from: 0xaaaaaaaa }, undefined],
  ])('stores nothing and reads no DB for %s', async (_n, over, ctx) => {
    await run(packet(over as any), ctx);
    expect(stored()).toHaveLength(0);
    expect(mockGetTelemetryByNode).not.toHaveBeenCalled();
  });

  it('stores nothing for a firmware NodeDB replay id', async () => {
    const rx = nowSec - 3;
    let h = 0x11111111 >>> 0;
    h = (Math.imul(h, 2654435761) + (rx >>> 0)) >>> 0;
    h = (Math.imul(h, 2654435761) + 2) >>> 0;
    await run(packet({ id: h, rxTime: rx }));
    expect(stored()).toHaveLength(0);
  });
});
