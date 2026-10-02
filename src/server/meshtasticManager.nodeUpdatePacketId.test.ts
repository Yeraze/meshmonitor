/**
 * #5534: a node update caused by a received MeshPacket carries that packet's id
 * on the `node:updated` event (→ `{{ trigger.packetId }}` on
 * trigger.nodeUpdated). A device NodeDB sync has no originating packet and must
 * emit without one, so the token renders empty rather than a stale id.
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
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('MeshtasticManager node:updated packetId (#5534)', () => {
  let manager: any;
  let emitSpy: ReturnType<typeof vi.spyOn>;
  const nowSec = Math.floor(Date.now() / 1000);

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetNode.mockResolvedValue(null);
    const module = await import('./meshtasticManager.js');
    manager = module.fallbackManager;
    vi.spyOn(manager, 'trackPKIEncryption').mockResolvedValue(undefined);
    const { dataEventEmitter } = await import('./services/dataEventEmitter.js');
    emitSpy = vi.spyOn(dataEventEmitter, 'emitNodeUpdate');
  });

  it('a received position packet emits its packet id as the update origin', async () => {
    const meshPacket = { from: 0x44444444, id: 0xf0000001, rxTime: nowSec - 5 };
    await manager.processPositionMessageProtobuf(meshPacket, {
      latitudeI: 407128000,
      longitudeI: -740060000,
      altitude: 10,
    });

    const call = emitSpy.mock.calls.find((c) => c[0] === 0x44444444);
    expect(call).toBeDefined();
    expect(call![3]).toEqual({ packetId: 0xf0000001 });
  });

  it('a device NodeDB sync emits with no origin', async () => {
    await manager.processNodeInfoProtobuf({
      num: 0x55555555,
      user: { id: '!55555555', longName: 'Synced', shortName: 'SYN' },
    });

    const call = emitSpy.mock.calls.find((c) => c[0] === 0x55555555);
    expect(call).toBeDefined();
    expect(call![3]).toBeUndefined();
  });
});
