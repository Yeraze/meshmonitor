/**
 * Status Message receive-side ingest (#4818).
 *
 * The firmware StatusMessageModule broadcasts each node's self-set status on
 * PortNum.NODE_STATUS_APP (36) as `meshtastic.StatusMessage { string status }`.
 * `processNodeStatusMessageProtobuf` stores it as a per-node attribute via
 * `upsertNodeAsync` — never as a message/DM. These tests pin the handler's
 * upsert payload: the status is set, clamped to 80 chars, an empty status is
 * carried through as '' (the repo maps that to a null "clear"), and a packet
 * with no `from` is ignored.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockUpsertNodeAsync = vi.fn().mockResolvedValue(undefined);

vi.mock('../services/database.js', () => ({
  default: {
    upsertNodeAsync: mockUpsertNodeAsync,
    nodes: { getAllNodes: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** The nodeData object passed to the most recent upsertNodeAsync call. */
function lastUpsert(): any {
  const call = mockUpsertNodeAsync.mock.calls.at(-1);
  return call?.[0];
}

describe('MeshtasticManager - Status Message ingest (#4818)', () => {
  let manager: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await import('./meshtasticManager.js');
    manager = module.fallbackManager;
    // trackPKIEncryption hits other state/DB; not under test here.
    vi.spyOn(manager, 'trackPKIEncryption').mockResolvedValue(undefined);
  });

  const meshPacket = { from: 0x11111111, id: 42, rxSnr: 5, rxRssi: -80 };

  it('upserts the node status as a per-node attribute (not a message)', async () => {
    await manager.processNodeStatusMessageProtobuf(meshPacket, { status: 'On the ridge 🏔' });

    expect(mockUpsertNodeAsync).toHaveBeenCalledTimes(1);
    const data = lastUpsert();
    expect(data.nodeNum).toBe(0x11111111);
    expect(data.nodeId).toBe('!11111111');
    expect(data.nodeStatus).toBe('On the ridge 🏔');
    expect(typeof data.nodeStatusUpdatedAt).toBe('number');
  });

  it('clamps the status to 80 characters', async () => {
    const long = 'x'.repeat(200);
    await manager.processNodeStatusMessageProtobuf(meshPacket, { status: long });
    expect(lastUpsert().nodeStatus).toHaveLength(80);
  });

  it('carries an empty status through as "" (the repo turns that into a clear)', async () => {
    await manager.processNodeStatusMessageProtobuf(meshPacket, { status: '' });
    expect(mockUpsertNodeAsync).toHaveBeenCalledTimes(1);
    expect(lastUpsert().nodeStatus).toBe('');
  });

  it('treats a missing status field as an empty clear', async () => {
    await manager.processNodeStatusMessageProtobuf(meshPacket, {});
    expect(lastUpsert().nodeStatus).toBe('');
  });

  it('ignores a packet with no sender (from = 0)', async () => {
    await manager.processNodeStatusMessageProtobuf({ from: 0 }, { status: 'ignored' });
    expect(mockUpsertNodeAsync).not.toHaveBeenCalled();
  });
});
