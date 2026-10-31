/**
 * Outbound MeshCore reactions through the device manager (#5762, epic #5759).
 * Real `:memory:` database, stub radio. Nothing transmits.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import databaseService from '../services/database.js';
import { MeshCoreDeviceType } from './meshcoreManager.js';
import { isMeshCoreReactionError } from './errors/meshcoreReactionError.js';
import { isTxDisabledError } from './errors/txDisabledError.js';
import { MESHCORE_REACTIONS_OUTBOUND_DEFAULT, mc1HashForChannelWire, mc1HashForDm } from '../utils/meshcoreReactionTarget.js';
import { parseMeshCoreReaction } from '../utils/meshcoreReactions.js';
import {
  SEC, THUMBS, PEER_KEY, SELF_KEY, SELF_NAME, newSourceId, makeManager, emitterSpies, rows, settle, channelEvent, dmEvent,
} from './test-helpers/meshcoreReactionHarness.js';

const HEART = '❤';
const HEART_VS16 = '❤️';

async function expectRefusal(p: Promise<unknown>, code: string): Promise<any> {
  try {
    await p;
  } catch (err) {
    expect(isMeshCoreReactionError(err)).toBe(true);
    expect((err as any).code).toBe(code);
    return err;
  }
  throw new Error(`expected refusal ${code}`);
}

describe('MeshCoreManager.sendReaction (#5762)', () => {
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

  async function withChannelTarget() {
    const h = makeManager(src);
    h.i.handleBridgeEvent(channelEvent('Bob: Hello', SEC, 3));
    await settle();
    const target = (await rows(src)).find(r => r.text === 'Hello')!;
    return { ...h, target };
  }
  const sends = (calls: { cmd: string }[]) => calls.filter(c => c.cmd === 'send_message');

  it('sends one channel packet, stores the emoji row, emits it', async () => {
    const { m, calls, target } = await withChannelTarget();
    const msg = await m.sendReaction(target.id, THUMBS);
    await settle();

    const s = sends(calls);
    expect(s).toHaveLength(1);
    const hash = mc1HashForChannelWire('Bob: Hello', SEC)!;
    expect(s[0].params.text).toBe(`@[Bob]${THUMBS}\n${hash}`);
    expect(s[0].params.channel_idx).toBe(3);
    expect(s[0].params.to).toBeFalsy();

    expect(msg.text).toBe(THUMBS);
    const stored = (await rows(src)).find(r => r.id === msg.id)!;
    expect(stored).toMatchObject({
      text: THUMBS,
      reactionEmoji: THUMBS,
      reactionFormat: 'mc1-channel',
      reactionTargetHash: hash,
      reactionTargetSender: 'Bob',
      reactionTargetId: target.id,
      fromPublicKey: SELF_KEY,
      toPublicKey: 'channel-3',
    });
    expect(stored.reactionRawText).toBe(s[0].params.text);
    expect(stored.mc1Hash ?? null).toBeNull();
    expect(stored.senderTimestamp).toBeTruthy();

    const ev = spies.message.mock.calls.map(c => c[0]).find(e => e.reactionEmoji);
    expect(ev).toMatchObject({ id: msg.id, text: THUMBS, reactionTargetId: target.id });
    expect(msg.expectedAckCrc).toBeUndefined();
    expect(msg.deliveryStatus).toBeUndefined();
  });

  it('our own channel reaction echoed back with a space separator folds, not a text bubble (#6039)', async () => {
    const { m, i, calls, target } = await withChannelTarget();
    const msg = await m.sendReaction(target.id, THUMBS);
    await settle();
    const sent = sends(calls)[0];
    const wire = sent.params.text as string; // `@[Bob]👍\n<hash>`
    const sec = sent.params.sender_timestamp as number;
    expect(wire).toContain('\n');

    // The companion hears its OWN channel reaction re-flooded and surfaces it as
    // a received channel message, but the firmware/transport delivers the body
    // with the wire newline turned into a space. Before #6039 this failed the
    // strict newline parser and was stored as a plain `@[...]` text bubble; it
    // must now be recognised as our reaction and deduped against the sent row.
    i.handleBridgeEvent(channelEvent(`${SELF_NAME}: ${wire.replace('\n', ' ')}`, sec, 3));
    await settle();

    const all = await rows(src);
    expect(all.some(r => r.text.startsWith('@['))).toBe(false);
    const reactions = all.filter(r => r.reactionEmoji);
    expect(reactions).toHaveLength(1);
    expect(reactions[0].id).toBe(msg.id);
    expect(reactions[0].reactionTargetId).toBe(target.id);
    expect(reactions[0].text).toBe(THUMBS);
  });

  it('sends a DM reaction to the full peer key', async () => {
    const { m, i, calls } = makeManager(src);
    i.handleBridgeEvent(dmEvent('Hello'));
    await settle();
    const target = (await rows(src)).find(r => r.text === 'Hello')!;
    (m as any).contacts.set(PEER_KEY, { publicKey: PEER_KEY, advType: MeshCoreDeviceType.COMPANION });
    const msg = await m.sendReaction(target.id, THUMBS);
    const s = sends(calls);
    expect(s).toHaveLength(1);
    expect(s[0].params.to).toBe(PEER_KEY);
    expect(s[0].params.text).toBe(`${THUMBS}\n${mc1HashForDm('Hello', SEC)}`);
    expect(msg.toPublicKey).toBe(PEER_KEY);
    expect(parseMeshCoreReaction(s[0].params.text as string, 'dm')).toMatchObject({ emoji: THUMBS });
  });

  it('a second identical reaction is DUPLICATE_REACTION with one bridge call; VS16 counts', async () => {
    const { m, calls, target } = await withChannelTarget();
    const first = await m.sendReaction(target.id, HEART);
    const err = await expectRefusal(m.sendReaction(target.id, THUMBS === HEART ? HEART : HEART_VS16), 'DUPLICATE_REACTION');
    expect(err.existingId).toBe(first.id);
    await expectRefusal(m.sendReaction(target.id, HEART), 'DUPLICATE_REACTION');
    expect(sends(calls)).toHaveLength(1);
    // A different emoji still goes.
    await m.sendReaction(target.id, THUMBS);
    expect(sends(calls)).toHaveLength(2);
  });

  it('two concurrent calls send once', async () => {
    const { m, calls, target } = await withChannelTarget();
    const results = await Promise.allSettled([m.sendReaction(target.id, THUMBS), m.sendReaction(target.id, THUMBS)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(sends(calls)).toHaveLength(1);
  });

  it('a radio failure is SEND_FAILED with no row and no event', async () => {
    const { m, i, target } = await withChannelTarget();
    spies.message.mockClear();
    i.sendBridgeCommand = async () => ({ id: '1', success: false, error: 'busy' });
    await expectRefusal(m.sendReaction(target.id, THUMBS), 'SEND_FAILED');
    await settle();
    expect((await rows(src)).filter(r => r.reactionEmoji)).toHaveLength(0);
    expect(spies.message).not.toHaveBeenCalled();
  });

  it('arms no retry even with channel retry on', async () => {
    const { m, target } = await withChannelTarget();
    vi.spyOn(databaseService.settings, 'getSettingAsBoolean').mockResolvedValue(true);
    await m.sendReaction(target.id, THUMBS);
    expect((m as any).pendingChannelRetries.size).toBe(0);
    expect((m as any).pendingDmRetries.size).toBe(0);
  });

  it('DM reaction with an ack crc arms no ack-timeout retry', async () => {
    const { m, i } = makeManager(src);
    i.handleBridgeEvent(dmEvent('Hello'));
    await settle();
    const target = (await rows(src)).find(r => r.text === 'Hello')!;
    (m as any).contacts.set(PEER_KEY, { publicKey: PEER_KEY, advType: MeshCoreDeviceType.COMPANION });
    i.sendBridgeCommand = async () => ({ id: '1', success: true, data: { expectedAckCrc: 77, estTimeout: 5000 } });
    const msg = await m.sendReaction(target.id, THUMBS);
    expect((m as any).pendingDmRetries.size).toBe(0);
    expect(msg.expectedAckCrc).toBeUndefined();
  });

  it('refuses when outbound is off, receive-only, disconnected, repeater', async () => {
    const { m, i, target } = await withChannelTarget();
    await databaseService.settings.setSourceSetting(src, 'meshcoreReactionsOutboundEnabled', 'false');
    await expectRefusal(m.sendReaction(target.id, THUMBS), 'REACTIONS_OUTBOUND_DISABLED');
    await databaseService.settings.setSourceSetting(src, 'meshcoreReactionsOutboundEnabled', 'true');

    i.receiveOnly = true;
    await m.sendReaction(target.id, THUMBS).then(
      () => { throw new Error('expected TxDisabledError'); },
      (e) => expect(isTxDisabledError(e)).toBe(true),
    );
    i.receiveOnly = false;

    i.connected = false;
    await expectRefusal(m.sendReaction(target.id, THUMBS), 'SOURCE_NOT_CONNECTED');
    i.connected = true;
    i.deviceType = MeshCoreDeviceType.REPEATER;
    await expectRefusal(m.sendReaction(target.id, THUMBS), 'SOURCE_NOT_CONNECTED');
    i.deviceType = MeshCoreDeviceType.COMPANION;
    expect(MESHCORE_REACTIONS_OUTBOUND_DEFAULT).toBe(true);
  });

  it('refuses bad emoji, unknown id, and a reaction-shaped plain row', async () => {
    const { m, i, target } = await withChannelTarget();
    await expectRefusal(m.sendReaction(target.id, '5'), 'INVALID_EMOJI');
    await expectRefusal(m.sendReaction('nope', THUMBS), 'MESSAGE_NOT_FOUND');
    // Inbound off: a reaction stays a plain row; it still cannot be a target.
    await databaseService.settings.setSourceSetting(src, 'meshcoreReactionsInboundEnabled', 'false');
    const wire = `Alice: @[Bob]${THUMBS}\n${mc1HashForChannelWire('Bob: Hello', SEC)!}`;
    i.handleBridgeEvent(channelEvent(wire, SEC + 2, 3));
    await settle();
    const plain = (await rows(src)).find(r => r.text.startsWith('@['))!;
    expect(plain).toBeTruthy();
    await expectRefusal(m.sendReaction(plain.id, HEART), 'TARGET_IS_REACTION');
  });

  it('our own reaction row cannot be resent or reacted to', async () => {
    const { m, target } = await withChannelTarget();
    const msg = await m.sendReaction(target.id, THUMBS);
    await expectRefusal(m.sendReaction(msg.id, HEART), 'TARGET_IS_REACTION');
    expect(SELF_NAME).toBeTruthy();
  });
});
