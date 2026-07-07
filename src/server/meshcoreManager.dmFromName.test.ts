/**
 * Tests for issue #3973: MeshCore DM (contact_message) events did not populate
 * `fromName`, even though the sender contact is resolved right there — leaving
 * `{{ trigger.fromName }}` empty for MeshCore DM automations (unlike channel and
 * room-post messages, which already carried a sender name).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType, MeshCoreMessage } from './meshcoreManager.js';
import databaseService from '../services/database.js';

function makeManager(opts?: {
  contacts?: Array<{ publicKey: string; advType?: number; advName?: string; name?: string }>;
}): { manager: MeshCoreManager; emittedMessages: MeshCoreMessage[]; insertMessage: ReturnType<typeof vi.spyOn> } {
  const m = new MeshCoreManager('test-source');
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;
  (m as any).localNode = { publicKey: 'aa'.repeat(32) };

  const emittedMessages: MeshCoreMessage[] = [];

  if (opts?.contacts) {
    for (const c of opts.contacts) {
      (m as any).contacts.set(c.publicKey, {
        publicKey: c.publicKey,
        advType: c.advType ?? 1,
        advName: c.advName,
        name: c.name,
      });
    }
  }

  m.on('message', (msg: MeshCoreMessage) => emittedMessages.push(msg));
  const insertMessage = vi.spyOn(databaseService.meshcore, 'insertMessage').mockResolvedValue(undefined as any);

  return { manager: m, emittedMessages, insertMessage };
}

describe('MeshCoreManager contact_message fromName (#3973)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('populates fromName from the resolved contact advName', () => {
    const senderPubkey = 'cc'.repeat(32);
    const { manager, emittedMessages, insertMessage } = makeManager({
      contacts: [{ publicKey: senderPubkey, advName: 'Alice' }],
    });

    (manager as any).handleBridgeEvent({
      event_type: 'contact_message',
      data: {
        pubkey_prefix: senderPubkey,
        text: 'hello there',
        sender_timestamp: 1700000000,
      },
    });

    expect(emittedMessages).toHaveLength(1);
    expect(emittedMessages[0].fromName).toBe('Alice');
    expect(insertMessage).toHaveBeenCalledWith(expect.objectContaining({ fromName: 'Alice' }), expect.anything());
  });

  it('falls back to the contact name when advName is unset', () => {
    const senderPubkey = 'dd'.repeat(32);
    const { manager, emittedMessages } = makeManager({
      contacts: [{ publicKey: senderPubkey, name: 'Bob' }],
    });

    (manager as any).handleBridgeEvent({
      event_type: 'contact_message',
      data: {
        pubkey_prefix: senderPubkey,
        text: 'hi',
        sender_timestamp: 1700000001,
      },
    });

    expect(emittedMessages[0].fromName).toBe('Bob');
  });

  it('leaves fromName undefined when the sender contact is unknown', () => {
    const { manager, emittedMessages } = makeManager();

    (manager as any).handleBridgeEvent({
      event_type: 'contact_message',
      data: {
        pubkey_prefix: 'deadbeef',
        text: 'orphan dm',
        sender_timestamp: 1700000002,
      },
    });

    expect(emittedMessages[0].fromName).toBeUndefined();
  });
});
