/**
 * Inbound MeshCore reactions through the device manager (#5761, epic #5759).
 * Real `:memory:` database, stub radio. Nothing transmits.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import databaseService from '../services/database.js';
import { meshcoreMessageFilter } from './services/meshcoreMessageFilter.js';
import { buildMc1ChannelReaction, buildMc1DmReaction } from '../utils/meshcoreReactions.js';
import {
  mc1HashForChannelWire,
  mc1HashForDm,
  mc1HashForOwnChannelText,
} from '../utils/meshcoreReactionTarget.js';
import {
  SEC, THUMBS, PEER_KEY, SELF_NAME, newSourceId, makeManager, emitterSpies, rows, settle, channelEvent, dmEvent,
} from './test-helpers/meshcoreReactionHarness.js';

const reactionWire = (target = 'Bob', body = 'Hello', sec = SEC) =>
  `Alice: ${buildMc1ChannelReaction(target, THUMBS, mc1HashForChannelWire(`${target}: ${body}`, sec)!)}`;

describe('MeshCoreManager inbound reactions (#5761)', () => {
  let src: string;
  let spies: ReturnType<typeof emitterSpies>;

  beforeAll(async () => {
    await databaseService.waitForReady();
  });
  beforeEach(() => {
    src = newSourceId();
    spies = emitterSpies();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('channel reaction: one row with text = emoji, resolved, no raw-text row', async () => {
    const { i } = makeManager(src);
    i.handleBridgeEvent(channelEvent('Bob: Hello'));
    await settle();
    i.handleBridgeEvent(channelEvent(reactionWire(), SEC + 5));
    await settle();

    const all = await rows(src);
    expect(all).toHaveLength(2);
    const target = all.find(r => r.text === 'Hello')!;
    const reaction = all.find(r => r.reactionEmoji)!;
    expect(reaction.text).toBe(THUMBS);
    expect(reaction.reactionTargetId).toBe(target.id);
    expect(reaction.reactionRawText).toContain('@[Bob]');
    expect(all.some(r => r.text.startsWith('@['))).toBe(false);
    // The target row carries the raw wire second and its MC1 hash.
    expect(target.senderTimestamp).toBe(SEC);
    expect(target.mc1Hash).toBe(mc1HashForChannelWire('Bob: Hello', SEC));
    // A reaction row is never a target: no hash.
    expect(reaction.mc1Hash ?? null).toBeNull();
    // Bus: the emoji copy with the reaction fields.
    const ev = spies.message.mock.calls.map(c => c[0]).find(e => e.reactionEmoji);
    expect(ev).toMatchObject({ text: THUMBS, reactionTargetId: target.id });
    expect(ev && 'mc1Hash' in ev).toBe(false);
  });

  it('DM: a reaction to our own DM resolves, and a received DM stores senderTimestamp + mc1Hash', async () => {
    const { m, i } = makeManager(src);
    await m.sendMessage('Hello', PEER_KEY);
    await settle();
    const own = (await rows(src)).find(r => r.text === 'Hello')!;
    const sec = own.senderTimestamp!;
    expect(own.mc1Hash).toBe(mc1HashForDm('Hello', sec));

    i.handleBridgeEvent(dmEvent(buildMc1DmReaction(THUMBS, mc1HashForDm('Hello', sec)!)!, sec + 1));
    await settle();
    const reaction = (await rows(src)).find(r => r.reactionEmoji)!;
    expect(reaction.reactionTargetId).toBe(own.id);
    expect(reaction.text).toBe(THUMBS);

    i.handleBridgeEvent(dmEvent('plain dm', SEC));
    await settle();
    const dm = (await rows(src)).find(r => r.text === 'plain dm')!;
    expect(dm.senderTimestamp).toBe(SEC);
    expect(dm.mc1Hash).toBe(mc1HashForDm('plain dm', SEC));
  });

  it('a reaction to our own channel message resolves by our own name', async () => {
    const { m, i } = makeManager(src);
    await m.sendMessage('ping', undefined, 0);
    await settle();
    const own = (await rows(src)).find(r => r.text === 'ping')!;
    expect(own.mc1Hash).toBe(mc1HashForOwnChannelText('ping', own.senderTimestamp!));
    const hash = mc1HashForOwnChannelText('ping', own.senderTimestamp!)!;
    i.handleBridgeEvent(channelEvent(`Alice: ${buildMc1ChannelReaction(SELF_NAME, THUMBS, hash)!}`, SEC));
    await settle();
    const reaction = (await rows(src)).find(r => r.reactionEmoji)!;
    expect(reaction.reactionTargetId).toBe(own.id);
  });

  it('inbound off: the raw text is stored as an ordinary message, with its tail', async () => {
    await databaseService.settings.setSourceSetting(src, 'meshcoreReactionsInboundEnabled', 'false');
    const { i } = makeManager(src);
    const ack = vi.spyOn(i, 'checkAutoAcknowledge').mockResolvedValue(undefined);
    const responder = vi.spyOn(i, 'checkAutoResponder').mockResolvedValue(undefined);
    const fwd = vi.spyOn(i, 'checkForwarding').mockResolvedValue(undefined);
    i.handleBridgeEvent(channelEvent('Bob: Hello'));
    i.handleBridgeEvent(channelEvent(reactionWire(), SEC + 5));
    await settle();
    const all = await rows(src);
    expect(all).toHaveLength(2);
    const raw = all.find(r => r.text.startsWith('@[Bob]'))!;
    expect(raw.reactionEmoji ?? null).toBeNull();
    expect(raw.mc1Hash).toBeTruthy();
    expect(ack).toHaveBeenCalledTimes(2);
    expect(responder).toHaveBeenCalledTimes(2);
    expect(fwd).toHaveBeenCalledTimes(2);
  });

  it('ignore verdict: stored, flagged on the socket copy, nothing else fires', async () => {
    const { i } = makeManager(src);
    i.handleBridgeEvent(channelEvent('Bob: Hello'));
    await settle();
    vi.spyOn(meshcoreMessageFilter, 'classify').mockReturnValue({ action: 'ignore', entryKind: 'name' } as never);
    const ack = vi.spyOn(i, 'checkAutoAcknowledge').mockResolvedValue(undefined);
    spies.message.mockClear();
    i.handleBridgeEvent(channelEvent(reactionWire(), SEC + 5));
    await settle();
    const reaction = (await rows(src)).find(r => r.reactionEmoji);
    expect(reaction).toBeTruthy();
    const ev = spies.message.mock.calls.map(c => c[0]).find(e => e.reactionEmoji);
    expect(ev?.filtered).toBe('ignore');
    expect(ack).not.toHaveBeenCalled();
  });

  it('block verdict: nothing stored, nothing emitted', async () => {
    const { i } = makeManager(src);
    vi.spyOn(meshcoreMessageFilter, 'classify').mockReturnValue({ action: 'block', entryKind: 'name' } as never);
    i.handleBridgeEvent(channelEvent('Bob: Hello'));
    i.handleBridgeEvent(channelEvent(reactionWire(), SEC + 5));
    await settle();
    expect(await rows(src)).toHaveLength(0);
    expect(spies.message).not.toHaveBeenCalled();
  });

  it('a duplicate reaction (same reactor, same emoji) stores and emits nothing', async () => {
    const { i } = makeManager(src);
    i.handleBridgeEvent(channelEvent('Bob: Hello'));
    await settle();
    i.handleBridgeEvent(channelEvent(reactionWire(), SEC + 5));
    await settle();
    spies.message.mockClear();
    i.handleBridgeEvent(channelEvent(reactionWire(), SEC + 6));
    await settle();
    expect((await rows(src)).filter(r => r.reactionEmoji)).toHaveLength(1);
    expect(spies.message).not.toHaveBeenCalled();
  });

  it('late resolution: target arrives after the reaction, emits resolved and patches the pool', async () => {
    const { i } = makeManager(src);
    i.handleBridgeEvent(channelEvent(reactionWire(), SEC + 5));
    await settle();
    const first = (await rows(src)).find(r => r.reactionEmoji)!;
    expect(first.reactionTargetId ?? null).toBeNull();

    i.handleBridgeEvent(channelEvent('Bob: Hello'));
    await settle();
    const all = await rows(src);
    const target = all.find(r => r.text === 'Hello')!;
    expect(all.find(r => r.reactionEmoji)!.reactionTargetId).toBe(target.id);
    expect(spies.resolved).toHaveBeenCalledTimes(1);
    expect(spies.resolved.mock.calls[0][0]).toMatchObject({ id: first.id, reactionTargetId: target.id });
    expect(spies.resolved.mock.calls[0][1]).toBe(src);
    expect(i.messages.find(m => m.id === first.id)?.reactionTargetId).toBe(target.id);
  });

  it('a room post is never parsed, hashed or given a wire second', async () => {
    const { i } = makeManager(src);
    const text = `@[Bob]${THUMBS}\nb45pc4ek`;
    i.handleBridgeEvent({
      event_type: 'room_message',
      data: { text, room_pubkey_prefix: 'cd'.repeat(6), author_pubkey_prefix: PEER_KEY.slice(0, 12), sender_timestamp: SEC, snr: 1 },
    });
    await settle();
    const [row] = await rows(src);
    expect(row.text).toBe(text);
    expect(row.messageType).toBe('room_post');
    expect(row.senderTimestamp ?? null).toBeNull();
    expect(row.mc1Hash ?? null).toBeNull();
    expect(row.reactionEmoji ?? null).toBeNull();
  });

  it('deleting a target deletes its reactions and reports their ids', async () => {
    const { m, i } = makeManager(src);
    i.handleBridgeEvent(channelEvent('Bob: Hello'));
    await settle();
    i.handleBridgeEvent(channelEvent(reactionWire(), SEC + 5));
    await settle();
    const all = await rows(src);
    const target = all.find(r => r.text === 'Hello')!;
    const reaction = all.find(r => r.reactionEmoji)!;

    expect(await m.deleteStoredMessage(target.id)).toBe(true);
    expect(await rows(src)).toHaveLength(0);
    const payload = spies.deleted.mock.calls.at(-1)![0];
    expect(payload.ids).toEqual(expect.arrayContaining([target.id, reaction.id]));
    expect(i.messages.some(x => x.id === reaction.id)).toBe(false);
  });
});
