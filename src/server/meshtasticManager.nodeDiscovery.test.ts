/**
 * #5534: trigger.nodeDiscovered on Meshtastic. processMeshPacket raises
 * `node:discovered` (with the packet id) for the first LIVE packet from a node
 * that has no row on this source — never for a NodeDB replay, an existing
 * node, or our own node — and marks that packet's position update as
 * `discovered` so trigger.nodeUpdated does not also fire for it.
 *
 * Harness modelled on meshtasticManager.transportTraffic.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockUpsertNodeAsync = vi.fn().mockResolvedValue(undefined);
const mockGetNode = vi.fn().mockResolvedValue(null);

vi.mock('../services/database.js', () => ({
  default: {
    upsertNodeAsync: mockUpsertNodeAsync,
    nodes: { getNode: mockGetNode, upsertNode: vi.fn(), getAllNodes: vi.fn().mockResolvedValue([]), updateNodeMessageHops: vi.fn() },
    telemetry: { insertTelemetry: vi.fn().mockResolvedValue(undefined) },
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

const NEW_NODE = 0x11111111;
const POSITION_APP = 3;

// Loaded once while the file is collected, not inside a hook. A dynamic import in
// `beforeEach` charged the manager's module load (~2 s idle, 10 s+ on a busy
// host) to the first test's hook budget; collection has no such budget.
const managerModule = await import('./meshtasticManager.js');

describe('MeshtasticManager node discovery (#5534)', () => {
  let manager: any;
  let discoveredSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetNode.mockResolvedValue(null);
    manager = managerModule.fallbackManager;
    vi.spyOn(manager, 'trackPKIEncryption').mockResolvedValue(undefined);
    vi.spyOn(manager, 'maybeRecordHeardReflood').mockResolvedValue(undefined);
    manager.localNodeInfo = { nodeNum: 0xaaaaaaaa, nodeId: '!aaaaaaaa', longName: 'Local', shortName: 'LOCL' };
    const { dataEventEmitter } = await import('./services/dataEventEmitter.js');
    discoveredSpy = vi.spyOn(dataEventEmitter, 'emitNodeDiscovered');
  });

  // rx_time is read at call time, not suite load, so a slow import can't age it.
  function packet(overrides: Record<string, unknown> = {}) {
    return {
      id: 0xf0000007,
      from: NEW_NODE,
      to: 0xffffffff,
      decoded: { portnum: 1, payload: new Uint8Array() },
      rxTime: Math.floor(Date.now() / 1000) - 2,
      ...overrides,
    };
  }

  it('raises node:discovered with the packet id for a live packet from an unknown node', async () => {
    await manager.processMeshPacket(packet());
    expect(discoveredSpy).toHaveBeenCalledTimes(1);
    expect(discoveredSpy.mock.calls[0][0]).toEqual({ nodeNum: NEW_NODE, packetId: 0xf0000007 });
    expect(discoveredSpy.mock.calls[0][1]).toBe(manager.sourceId);
  });

  it('does not raise it when the node already has a row on this source', async () => {
    mockGetNode.mockResolvedValue({ nodeNum: NEW_NODE, sourceId: manager.sourceId });
    await manager.processMeshPacket(packet());
    expect(discoveredSpy).not.toHaveBeenCalled();
  });

  it('raises it when only ANOTHER source has a row for the node', async () => {
    // Unscoped lookup finds the other source's row; the scoped re-check finds none.
    mockGetNode.mockImplementation(async (_num: number, sourceId?: string) =>
      sourceId ? null : { nodeNum: NEW_NODE, sourceId: 'other-source' });
    await manager.processMeshPacket(packet());
    expect(discoveredSpy).toHaveBeenCalledTimes(1);
  });

  it('does not raise it for a firmware 2.8 NodeDB replay (rx_time 30 min old)', async () => {
    await manager.processMeshPacket(packet({ rxTime: Math.floor(Date.now() / 1000) - 30 * 60 }));
    expect(discoveredSpy).not.toHaveBeenCalled();
  });

  it('does not raise it for our own node (#3914)', async () => {
    await manager.processMeshPacket(packet({ from: 0xaaaaaaaa }));
    expect(discoveredSpy).not.toHaveBeenCalled();
  });

  it('raises it again after the node was deleted (no row ⇒ new again)', async () => {
    mockGetNode.mockResolvedValue({ nodeNum: NEW_NODE, sourceId: manager.sourceId });
    await manager.processMeshPacket(packet());
    expect(discoveredSpy).not.toHaveBeenCalled();
    mockGetNode.mockResolvedValue(null); // row deleted
    await manager.processMeshPacket(packet());
    expect(discoveredSpy).toHaveBeenCalledTimes(1);
  });

  it('marks the discovering packet\'s position update so nodeUpdated is skipped', async () => {
    const posSpy = vi.spyOn(manager, 'processPositionMessageProtobuf').mockResolvedValue(undefined);
    await manager.processMeshPacket(packet({ decoded: { portnum: POSITION_APP, payload: new Uint8Array([0x08, 0x01]) } }));
    expect(posSpy).toHaveBeenCalled();
    expect(posSpy.mock.calls[0][2]).toMatchObject({ nodeDiscovered: true });
    posSpy.mockRestore();
  });

  it('a known node\'s position packet is not marked discovered', async () => {
    mockGetNode.mockResolvedValue({ nodeNum: NEW_NODE, sourceId: manager.sourceId });
    const posSpy = vi.spyOn(manager, 'processPositionMessageProtobuf').mockResolvedValue(undefined);
    await manager.processMeshPacket(packet({ decoded: { portnum: POSITION_APP, payload: new Uint8Array([0x08, 0x01]) } }));
    expect(posSpy.mock.calls[0][2]).toMatchObject({ nodeDiscovered: false });
    posSpy.mockRestore();
  });

  it('a device NodeDB sync inserts silently (no node:discovered)', async () => {
    await manager.processNodeInfoProtobuf({
      num: 0x55555555,
      user: { id: '!55555555', longName: 'Synced', shortName: 'SYN' },
    });
    expect(discoveredSpy).not.toHaveBeenCalled();
  });
});
