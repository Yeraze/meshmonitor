/**
 * Regression test for issue #4194: messages MeshMonitor itself sends to a
 * MeshCore channel (or as a DM/room post) were stored with `fromName`
 * undefined. The Unified Messages feed's `senderLabel` falls back to
 * `fromNodeId` (the raw local public key) when no name is present, so our own
 * sends showed up labelled by a 64-char public key instead of our node name —
 * even though the identity is known (we sent it).
 *
 * Received channel messages carry the sender name inline via the "Name: " body
 * prefix; our own sends have no such prefix, so the fix stamps
 * `this.localNode.name` onto the self-sent message at write time. These tests
 * assert the constructed/persisted message carries that name.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType, MeshCoreMessage } from './meshcoreManager.js';
import databaseService from '../services/database.js';

const SELF_KEY = 'aa'.repeat(32);
const SELF_NAME = 'My MeshCore Node';

function makeManager(): {
  manager: MeshCoreManager;
  emittedMessages: MeshCoreMessage[];
  insertMessage: ReturnType<typeof vi.spyOn>;
} {
  const m = new MeshCoreManager('test-source');
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;
  (m as any).localNode = { publicKey: SELF_KEY, name: SELF_NAME };

  // Bridge send always succeeds; channel sends return no ack fields.
  (m as any).sendBridgeCommand = vi.fn().mockResolvedValue({ success: true, data: {} });

  const emittedMessages: MeshCoreMessage[] = [];
  m.on('message', (msg: MeshCoreMessage) => emittedMessages.push(msg));

  const insertMessage = vi.spyOn(databaseService.meshcore, 'insertMessage').mockResolvedValue(undefined as any);
  // No channel scope / default scope configured for the send path.
  vi.spyOn(databaseService.channels, 'getChannelById').mockResolvedValue(null as any);
  vi.spyOn(databaseService.settings, 'getSettingForSource').mockResolvedValue(null as any);

  return { manager: m, emittedMessages, insertMessage };
}

describe('MeshCoreManager self-sent message fromName (#4194)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('stamps the local node name on a self-sent channel message', async () => {
    const { manager, emittedMessages, insertMessage } = makeManager();

    // Channel send: no recipient pubkey, channel index provided.
    await (manager as any).performScopedSend('hello channel', undefined, 0);

    expect(emittedMessages).toHaveLength(1);
    expect(emittedMessages[0].fromName).toBe(SELF_NAME);
    expect(emittedMessages[0].fromPublicKey).toBe(SELF_KEY);
    expect(insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({ fromName: SELF_NAME, fromPublicKey: SELF_KEY }),
      'test-source',
    );
  });

  it('stamps the local node name on a self-sent DM', async () => {
    const { manager, emittedMessages } = makeManager();

    await (manager as any).performScopedSend('hello dm', 'bb'.repeat(32));

    expect(emittedMessages).toHaveLength(1);
    expect(emittedMessages[0].fromName).toBe(SELF_NAME);
  });

  it('stamps the local node name on a self-sent room post', async () => {
    const { manager, emittedMessages, insertMessage } = makeManager();

    await manager.sendRoomPost('hello room', 'cc'.repeat(32));

    expect(emittedMessages).toHaveLength(1);
    expect(emittedMessages[0].fromName).toBe(SELF_NAME);
    expect(insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({ fromName: SELF_NAME, messageType: 'room_post' }),
      'test-source',
    );
  });

  it('leaves fromName undefined when the local node name is unknown', async () => {
    const { manager, emittedMessages } = makeManager();
    (manager as any).localNode = { publicKey: SELF_KEY }; // no name

    await (manager as any).performScopedSend('nameless', undefined, 0);

    expect(emittedMessages[0].fromName).toBeUndefined();
  });
});
