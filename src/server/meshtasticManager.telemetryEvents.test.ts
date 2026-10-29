/**
 * Meshtastic TCP telemetry ingest feeds trigger.telemetry. Before this,
 * nothing called dataEventEmitter.emitTelemetry, so telemetry automations
 * never fired. Pins:
 *   - each stored reading of a live packet is emitted, tagged with its source;
 *   - a replayed frame (stale rx_time) is stored but NOT emitted;
 *   - a reply to a telemetry request we sent is flagged answersOwnRequest;
 *   - LocalStats readings are flagged localStats.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockInsertTelemetry = vi.fn().mockResolvedValue(undefined);
const mockUpsertNode = vi.fn().mockResolvedValue(undefined);

vi.mock('../services/database.js', () => ({
  default: {
    telemetry: { insertTelemetry: mockInsertTelemetry },
    nodes: { upsertNode: mockUpsertNode, getAllNodes: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const managerModule = await import('./meshtasticManager.js');
const { default: meshtasticProtobufService } = await import('./meshtasticProtobufService.js');
const { dataEventEmitter } = await import('./services/dataEventEmitter.js');
const { recordOwnTelemetryRequest, resetOwnTelemetryRequestsForTests, isAnswerToOwnTelemetryRequest } = await import('./services/ownTelemetryRequests.js');

describe('MeshtasticManager telemetry → trigger.telemetry events', () => {
  let manager: any;
  let emitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetOwnTelemetryRequestsForTests();
    manager = managerModule.fallbackManager;
    vi.spyOn(manager, 'trackPKIEncryption').mockResolvedValue(undefined);
    emitSpy = vi.spyOn(dataEventEmitter, 'emitTelemetry').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  const nowSec = () => Math.floor(Date.now() / 1000);

  it('emits each stored reading of a live packet', async () => {
    await manager.processTelemetryMessageProtobuf(
      { from: 0x22222222, id: 101, rxTime: nowSec() },
      { environmentMetrics: { temperature: 21.5, relativeHumidity: 48 } },
    );
    expect(mockInsertTelemetry).toHaveBeenCalledTimes(2);
    expect(emitSpy).toHaveBeenCalledTimes(2);
    const [nodeNum, row, sourceId, meta] = emitSpy.mock.calls[0];
    expect(nodeNum).toBe(0x22222222);
    expect(row).toMatchObject({ telemetryType: 'temperature', value: 21.5, nodeNum: 0x22222222 });
    expect(sourceId).toBe(manager.sourceId);
    expect(meta).toEqual({ answersOwnRequest: false });
  });

  it('stores but does not emit a replayed frame (stale rx_time)', async () => {
    await manager.processTelemetryMessageProtobuf(
      { from: 0x22222222, id: 102, rxTime: nowSec() - 7 * 3600 },
      { environmentMetrics: { temperature: 21.5 } },
    );
    expect(mockInsertTelemetry).toHaveBeenCalledTimes(1);
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('flags a reply to our own telemetry request', async () => {
    recordOwnTelemetryRequest(5555);
    await manager.processTelemetryMessageProtobuf(
      { from: 0x22222222, id: 103, rxTime: nowSec(), decoded: { requestId: 5555 } },
      { environmentMetrics: { temperature: 21.5 } },
    );
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy.mock.calls[0][3]).toEqual({ answersOwnRequest: true });
  });

  it('does not flag a reply to somebody else\'s request', async () => {
    await manager.processTelemetryMessageProtobuf(
      { from: 0x22222222, id: 104, rxTime: nowSec(), decoded: { requestId: 9999 } },
      { environmentMetrics: { temperature: 21.5 } },
    );
    expect(emitSpy.mock.calls[0][3]).toEqual({ answersOwnRequest: false });
  });

  it('flags LocalStats readings', async () => {
    vi.spyOn(manager, 'checkAutoHeapManagement').mockResolvedValue(undefined);
    await manager.processTelemetryMessageProtobuf(
      { from: 0x22222222, id: 105 },
      { localStats: { noiseFloor: -98, numPacketsTx: 10 } },
    );
    expect(emitSpy).toHaveBeenCalledTimes(2);
    for (const call of emitSpy.mock.calls) expect(call[3]).toEqual({ answersOwnRequest: false, localStats: true });
    expect(emitSpy.mock.calls.map((c: any[]) => c[1].telemetryType)).toContain('noiseFloor');
  });

  it('remembers the packet id of a telemetry request it sends', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(meshtasticProtobufService, 'createTelemetryRequestMessage')
      .mockReturnValue({ data: new Uint8Array([1]), packetId: 777, requestId: 778 });
    const saved = { transport: manager.transport, localNodeInfo: manager.localNodeInfo, virtualNodeServer: manager.virtualNodeServer };
    Object.defineProperty(manager, 'isConnected', { configurable: true, get: () => true });
    manager.transport = { send };
    manager.localNodeInfo = { nodeNum: 0x11111111, nodeId: '!11111111' };
    manager.virtualNodeServer = null;
    try {
      const { packetId } = await manager.requestLocalStats();
      expect(send).toHaveBeenCalledTimes(1);
      expect(packetId).toBe(777);
      expect(isAnswerToOwnTelemetryRequest(777)).toBe(true);
    } finally {
      delete (manager as any).isConnected;
      Object.assign(manager, saved);
    }
  });
});
