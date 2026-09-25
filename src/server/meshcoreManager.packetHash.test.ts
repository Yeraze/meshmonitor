/**
 * #5357 — manager plumbing for the MeshCore packet hash:
 *   - the backend's `packet_hash` reaches MeshCoreMessage.packetHash on DMs and
 *     channel messages (and is absent when the backend sent none);
 *   - the sync channel-secret lookup handed to the backend reads the cache of
 *     the `channels` table, with slot 0 falling back to the Public secret.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const getAllChannels = vi.fn();

vi.mock('../services/database.js', () => ({
  default: {
    meshcore: {
      insertMessage: vi.fn().mockResolvedValue(undefined),
      updateLastRoomPostAt: vi.fn().mockResolvedValue(undefined),
    },
    settings: { getSettingForSource: vi.fn().mockResolvedValue(undefined) },
    channels: { getAllChannels: (...a: unknown[]) => getAllChannels(...a) },
    savedRegions: { getAllAsync: vi.fn().mockResolvedValue([]) },
  },
}));

const emitMeshCoreMessage = vi.fn();
vi.mock('./services/dataEventEmitter.js', () => ({
  dataEventEmitter: {
    emitMeshCoreMessage: (...a: unknown[]) => emitMeshCoreMessage(...a),
    emitMeshCoreOtaPacket: vi.fn(),
    emitMeshCoreChannelHeard: vi.fn(),
    emitMeshCoreContactUpdated: vi.fn(),
  },
}));

import { MeshCoreManager } from './meshcoreManager.js';
import { MESHCORE_PUBLIC_CHANNEL_SECRET } from './utils/meshcoreGroupEcho.js';

function dispatch(m: MeshCoreManager, event_type: string, data: Record<string, unknown>): void {
  // @ts-expect-error - exercising the private bridge-event handler
  m.handleBridgeEvent({ event_type, data });
}

const lastEmitted = () => emitMeshCoreMessage.mock.calls[emitMeshCoreMessage.mock.calls.length - 1][0];

describe('MeshCoreManager packet hash plumbing (#5357)', () => {
  let m: MeshCoreManager;

  beforeEach(() => {
    vi.clearAllMocks();
    getAllChannels.mockResolvedValue([]);
    m = new MeshCoreManager('src-a');
  });

  it('copies packet_hash onto a channel message', () => {
    dispatch(m, 'channel_message', { channel_idx: 0, text: 'Bob: hi', sender_timestamp: 1, packet_hash: 'AABBCCDDEEFF0011' });
    expect(lastEmitted().packetHash).toBe('AABBCCDDEEFF0011');
  });

  it('copies packet_hash onto a DM', () => {
    dispatch(m, 'contact_message', { pubkey_prefix: 'a1b2c3d4e5f6', text: 'hi', sender_timestamp: 1, packet_hash: '0011223344556677' });
    expect(lastEmitted().packetHash).toBe('0011223344556677');
  });

  it('leaves packetHash undefined when the backend matched no frame', () => {
    dispatch(m, 'channel_message', { channel_idx: 0, text: 'Bob: hi', sender_timestamp: 1 });
    expect(lastEmitted().packetHash).toBeUndefined();
    dispatch(m, 'room_message', { room_pubkey_prefix: 'aa', author_pubkey_prefix: 'bb', text: 'post', sender_timestamp: 1 });
    expect(lastEmitted().packetHash).toBeUndefined();
  });

  it('resolves channel secrets from the channels table, slot 0 falling back to Public', async () => {
    const secret3 = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    getAllChannels.mockResolvedValue([
      { id: 3, name: 'Gauntlet', psk: secret3.toString('base64') },
      { id: 4, name: 'Bad', psk: Buffer.from('short').toString('base64') },
      { id: 5, name: 'None', psk: null },
    ]);
    await (m as any).refreshChannelSecrets();
    const resolve = (idx: number): Uint8Array | null => (m as any).resolveChannelSecret(idx);

    expect(Buffer.from(resolve(3)!).equals(secret3)).toBe(true);
    expect(resolve(0)).toBe(MESHCORE_PUBLIC_CHANNEL_SECRET);
    expect(resolve(4)).toBeNull();
    expect(resolve(5)).toBeNull();
    expect(resolve(9)).toBeNull();
    expect(getAllChannels).toHaveBeenCalledWith('src-a');
  });

  it('prefers a stored slot-0 secret over the Public fallback', async () => {
    const own = Buffer.from('ffeeddccbbaa99887766554433221100', 'hex');
    getAllChannels.mockResolvedValue([{ id: 0, name: 'Private0', psk: own.toString('base64') }]);
    await (m as any).refreshChannelSecrets();
    expect(Buffer.from((m as any).resolveChannelSecret(0)).equals(own)).toBe(true);
  });

  it('keeps the previous cache when the DB read fails', async () => {
    const secret3 = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    getAllChannels.mockResolvedValueOnce([{ id: 3, name: 'G', psk: secret3.toString('base64') }]);
    await (m as any).refreshChannelSecrets();
    getAllChannels.mockRejectedValueOnce(new Error('db down'));
    await (m as any).refreshChannelSecrets();
    expect((m as any).resolveChannelSecret(3)).not.toBeNull();
  });
});
