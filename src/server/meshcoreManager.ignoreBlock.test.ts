/**
 * MeshCore Ignore / Block at ingest (#5408).
 *
 * Block: not stored, not emitted, no auto-ack / auto-responder / forwarding.
 * Ignore: stored, the socket copy is flagged `filtered: 'ignore'`, and nothing
 * that acts on a message runs (auto-ack, auto-responder, forwarding, the
 * Virtual Node relay, automations).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType, MeshCoreMessage } from './meshcoreManager.js';
import databaseService from '../services/database.js';
import { dataEventEmitter } from './services/dataEventEmitter.js';
import { meshcoreMessageFilter } from './services/meshcoreMessageFilter.js';
import { shouldRouteMeshCoreMessageToAutomations } from './services/automation/automationEngineSingleton.js';
import type { MeshCoreIgnoredNodeRow, MeshCoreMessageFilterRow } from '../db/repositories/index.js';

const SRC = 'test-source';
const SENDER = 'cc'.repeat(32);
const ROOM = 'bb'.repeat(32);

function nodeEntry(mode: 'ignore' | 'block', name = 'Spammer'): MeshCoreIgnoredNodeRow {
  return { sourceId: SRC, publicKey: SENDER, name, mode, createdAt: 1, createdBy: null, hitCount: 0, lastHitAt: null };
}

function ruleEntry(mode: 'ignore' | 'block', pattern: string): MeshCoreMessageFilterRow {
  return {
    id: `rule-${mode}`, sourceId: SRC, mode, matchType: 'wildcard', pattern, caseSensitive: false,
    fields: 'body', enabled: true, createdAt: 1, createdBy: null, hitCount: 0, lastHitAt: null,
  };
}

function makeManager() {
  const m = new MeshCoreManager(SRC);
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;
  (m as any).localNode = { publicKey: 'aa'.repeat(32) };
  (m as any).contacts.set(SENDER, { publicKey: SENDER, advType: 1, advName: 'Spammer' });
  (m as any).contacts.set(ROOM, { publicKey: ROOM, advType: 3, advName: 'Room' });

  const vnRelay: MeshCoreMessage[] = [];
  m.on('message', (msg: MeshCoreMessage) => vnRelay.push(msg));
  const insertMessage = vi.spyOn(databaseService.meshcore, 'insertMessage').mockResolvedValue(undefined as any);
  const updateLastRoomPostAt = vi.spyOn(databaseService.meshcore, 'updateLastRoomPostAt').mockResolvedValue(undefined as any);
  vi.spyOn(databaseService.meshcore, 'upsertNode').mockResolvedValue(undefined as any);
  const busEmits = vi.spyOn(dataEventEmitter, 'emitMeshCoreMessage');
  const autoAck = vi.fn().mockResolvedValue(undefined);
  const autoResponder = vi.fn().mockResolvedValue(undefined);
  const forwarding = vi.fn().mockResolvedValue(undefined);
  (m as any).checkAutoAcknowledge = autoAck;
  (m as any).checkAutoResponder = autoResponder;
  (m as any).checkForwarding = forwarding;
  (m as any).persistContact = vi.fn().mockResolvedValue(undefined);
  return { m, vnRelay, insertMessage, updateLastRoomPostAt, busEmits, autoAck, autoResponder, forwarding };
}

const dm = (text = 'hello') => ({
  event_type: 'contact_message',
  data: { pubkey_prefix: SENDER.slice(0, 12), text, sender_timestamp: 1_700_000_000 },
});
const channel = (text: string) => ({
  event_type: 'channel_message',
  data: { channel_idx: 0, text, sender_timestamp: 1_700_000_000 },
});

describe('MeshCoreManager ingest — Ignore / Block (#5408)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    meshcoreMessageFilter.resetForTests();
  });

  afterEach(() => {
    meshcoreMessageFilter.resetForTests();
  });

  it('a blocked DM is not stored, emitted, acked, answered or forwarded', () => {
    meshcoreMessageFilter.setState(SRC, [nodeEntry('block')], []);
    const h = makeManager();
    (h.m as any).handleBridgeEvent(dm());
    expect(h.insertMessage).not.toHaveBeenCalled();
    expect(h.busEmits).not.toHaveBeenCalled();
    expect(h.vnRelay).toHaveLength(0);
    expect(h.autoAck).not.toHaveBeenCalled();
    expect(h.autoResponder).not.toHaveBeenCalled();
    expect(h.forwarding).not.toHaveBeenCalled();
    expect(h.m.getRecentMessages(10)).toHaveLength(0);
  });

  it('an ignored DM is stored but only a flagged socket copy goes out', () => {
    meshcoreMessageFilter.setState(SRC, [nodeEntry('ignore')], []);
    const h = makeManager();
    (h.m as any).handleBridgeEvent(dm());
    expect(h.insertMessage).toHaveBeenCalledTimes(1);
    expect(h.insertMessage.mock.calls[0][0]).not.toHaveProperty('filtered');
    expect(h.busEmits).toHaveBeenCalledTimes(1);
    expect(h.busEmits.mock.calls[0][0]).toMatchObject({ filtered: 'ignore', text: 'hello' });
    expect(h.vnRelay).toHaveLength(0);
    expect(h.autoAck).not.toHaveBeenCalled();
    expect(h.autoResponder).not.toHaveBeenCalled();
    expect(h.forwarding).not.toHaveBeenCalled();
    // The in-memory pool keeps the plain row; read routes re-annotate it.
    expect(h.m.getRecentMessages(10)[0].filtered).toBeUndefined();
    // The flagged event never reaches automations.
    expect(shouldRouteMeshCoreMessageToAutomations(h.busEmits.mock.calls[0][0])).toBe(false);
  });

  it('an unmatched DM still runs the normal path', () => {
    meshcoreMessageFilter.setState(SRC, [], [ruleEntry('block', '*spam*')]);
    const h = makeManager();
    (h.m as any).handleBridgeEvent(dm('good morning'));
    expect(h.insertMessage).toHaveBeenCalledTimes(1);
    expect(h.vnRelay).toHaveLength(1);
    expect(h.autoAck).toHaveBeenCalledTimes(1);
    expect(h.autoResponder).toHaveBeenCalledTimes(1);
    expect(shouldRouteMeshCoreMessageToAutomations(h.busEmits.mock.calls[0][0])).toBe(true);
  });

  it('a channel message is matched by the sender name in "Name: body"', () => {
    meshcoreMessageFilter.setState(SRC, [nodeEntry('ignore', 'spammer')], []);
    const h = makeManager();
    (h.m as any).handleBridgeEvent(channel('Spammer: buy now'));
    expect(h.insertMessage).toHaveBeenCalledTimes(1);
    expect(h.busEmits.mock.calls[0][0]).toMatchObject({ filtered: 'ignore', fromName: 'Spammer', text: 'buy now' });
    expect(h.autoAck).not.toHaveBeenCalled();
    expect(h.autoResponder).not.toHaveBeenCalled();
  });

  it('a channel message blocked by a body rule is dropped', () => {
    meshcoreMessageFilter.setState(SRC, [], [ruleEntry('block', '*crypto*')]);
    const h = makeManager();
    (h.m as any).handleBridgeEvent(channel('Alice: free crypto here'));
    expect(h.insertMessage).not.toHaveBeenCalled();
    expect(h.busEmits).not.toHaveBeenCalled();
    expect(h.autoAck).not.toHaveBeenCalled();
  });

  it('a blocked room post is dropped but still advances the room sync cursor', () => {
    meshcoreMessageFilter.setState(SRC, [nodeEntry('block')], []);
    const h = makeManager();
    (h.m as any).handleBridgeEvent({
      event_type: 'room_message',
      data: {
        room_pubkey_prefix: ROOM.slice(0, 12),
        author_pubkey_prefix: SENDER.slice(0, 8),
        text: 'room spam',
        sender_timestamp: 1_700_000_000,
      },
    });
    expect(h.insertMessage).not.toHaveBeenCalled();
    expect(h.busEmits).not.toHaveBeenCalled();
    expect(h.updateLastRoomPostAt).toHaveBeenCalledWith(SRC, ROOM, 1_700_000_000_000);
  });

  it('an advert refreshes the entry name used for channel matching', () => {
    meshcoreMessageFilter.setState(SRC, [nodeEntry('ignore', 'OldName')], []);
    vi.spyOn(databaseService, 'updateMeshCoreIgnoredNodeNameAsync').mockResolvedValue();
    const h = makeManager();
    (h.m as any).handleBridgeEvent({
      event_type: 'contact_advertised',
      data: { public_key: SENDER, adv_name: 'NewName', adv_type: 1 },
    });
    (h.m as any).handleBridgeEvent(channel('NewName: hi'));
    expect(h.busEmits.mock.calls.at(-1)?.[0]).toMatchObject({ filtered: 'ignore' });
  });
});
