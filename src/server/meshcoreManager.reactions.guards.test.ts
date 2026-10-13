/**
 * Side-effect guards for inbound reactions (#5761, epic #5759). A reaction row
 * must not feed the Auto-Responder or Forwarding; Auto-Acknowledge runs only on
 * the global opt-in and then sees the RAW text. Nothing transmits.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import databaseService from '../services/database.js';
import { buildMc1ChannelReaction } from '../utils/meshcoreReactions.js';
import { mc1HashForChannelWire } from '../utils/meshcoreReactionTarget.js';
import type { MeshCoreMessage } from './meshcoreManager.js';
import {
  SEC, THUMBS, newSourceId, makeManager, emitterSpies, rows, settle, channelEvent,
} from './test-helpers/meshcoreReactionHarness.js';

const BODY = buildMc1ChannelReaction('Bob', THUMBS, mc1HashForChannelWire('Bob: Hello', SEC)!)!;
const WIRE = `Alice: ${BODY}`;

describe('reaction side-effect guards (#5761)', () => {
  let src: string;
  let spies: ReturnType<typeof emitterSpies>;

  beforeAll(async () => {
    await databaseService.waitForReady();
  });
  beforeEach(async () => {
    src = newSourceId();
    spies = emitterSpies();
    await databaseService.settings.setSetting('meshcoreReactionsAckOnReceive', 'false');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await databaseService.settings.setSetting('meshcoreReactionsAckOnReceive', 'false');
  });

  function armed() {
    const h = makeManager(src);
    const ack = vi.spyOn(h.i, 'checkAutoAcknowledge').mockResolvedValue(undefined);
    const responder = vi.spyOn(h.i, 'checkAutoResponder').mockResolvedValue(undefined);
    const fwd = vi.spyOn(h.i, 'checkForwarding').mockResolvedValue(undefined);
    const local: MeshCoreMessage[] = [];
    h.m.on('message', (msg: MeshCoreMessage) => local.push(msg));
    return { ...h, ack, responder, fwd, local };
  }

  it('fires no Auto-Responder for a reaction', async () => {
    const { i, responder } = armed();
    i.handleBridgeEvent(channelEvent('Bob: Hello'));
    await settle();
    responder.mockClear();
    i.handleBridgeEvent(channelEvent(WIRE, SEC + 5));
    await settle();
    expect((await rows(src)).some(r => r.reactionEmoji)).toBe(true);
    expect(responder).not.toHaveBeenCalled();
  });

  it('fires no Forwarding for a reaction', async () => {
    const { i, fwd } = armed();
    i.handleBridgeEvent(channelEvent('Bob: Hello'));
    await settle();
    fwd.mockClear();
    i.handleBridgeEvent(channelEvent(WIRE, SEC + 5));
    await settle();
    expect(fwd).not.toHaveBeenCalled();
  });

  it('the real responder and forwarder return at once for a reaction row', async () => {
    const { i } = makeManager(src);
    const read = vi.spyOn(databaseService.settings, 'getSettingForSource');
    const row: MeshCoreMessage = {
      id: 'r1', fromPublicKey: 'channel-0', text: THUMBS, timestamp: 1, reactionEmoji: THUMBS,
    };
    await i.checkAutoResponder(row, false, 0, null, null);
    await i.checkForwarding(row, false, 0);
    expect(read).not.toHaveBeenCalled();
  });

  it('Auto-Acknowledge is not run with the global setting off (the default)', async () => {
    const { i, ack } = armed();
    i.handleBridgeEvent(channelEvent('Bob: Hello'));
    await settle();
    ack.mockClear();
    i.handleBridgeEvent(channelEvent(WIRE, SEC + 5));
    await settle();
    expect(ack).not.toHaveBeenCalled();
  });

  it('Auto-Acknowledge runs with the global setting on, and gets the RAW text', async () => {
    await databaseService.settings.setSetting('meshcoreReactionsAckOnReceive', 'true');
    const { i, ack } = armed();
    i.handleBridgeEvent(channelEvent('Bob: Hello'));
    await settle();
    ack.mockClear();
    i.handleBridgeEvent(channelEvent(WIRE, SEC + 5));
    await settle();
    expect(ack).toHaveBeenCalledTimes(1);
    const handed = ack.mock.calls[0][0] as MeshCoreMessage;
    expect(handed.text).toBe(BODY);
    expect(handed.reactionEmoji).toBeUndefined();
  });

  it('receive-only still blocks the opt-in acknowledgement', async () => {
    await databaseService.settings.setSetting('meshcoreReactionsAckOnReceive', 'true');
    await databaseService.settings.setSourceSetting(src, 'meshcoreAutoAckEnabled', 'true');
    await databaseService.settings.setSourceSetting(src, 'meshcoreAutoAckRegex', '.*');
    const { i, calls } = makeManager(src);
    i.receiveOnly = true;
    i.handleBridgeEvent(channelEvent('Bob: Hello'));
    i.handleBridgeEvent(channelEvent(WIRE, SEC + 5));
    await settle();
    expect(calls.filter(c => c.cmd === 'send_message')).toHaveLength(0);
  });

  it("the local 'message' event carries the raw text, the bus event the emoji", async () => {
    const { i, local } = armed();
    i.handleBridgeEvent(channelEvent('Bob: Hello'));
    await settle();
    local.length = 0;
    spies.message.mockClear();
    i.handleBridgeEvent(channelEvent(WIRE, SEC + 5));
    await settle();
    expect(local).toHaveLength(1);
    expect(local[0].text).toBe(BODY);
    expect(local[0].reactionEmoji).toBeUndefined();
    const bus = spies.message.mock.calls.map(c => c[0]);
    expect(bus).toHaveLength(1);
    expect(bus[0].text).toBe(THUMBS);
    expect(bus[0].reactionEmoji).toBe(THUMBS);
  });

  it('inbound off: raw text goes through Auto-Responder, Forwarding and Auto-Acknowledge as today', async () => {
    await databaseService.settings.setSourceSetting(src, 'meshcoreReactionsInboundEnabled', 'false');
    const { i, ack, responder, fwd } = armed();
    i.handleBridgeEvent(channelEvent(WIRE, SEC + 5));
    await settle();
    expect((await rows(src))[0].text).toBe(BODY);
    expect(ack.mock.calls[0][0]).toMatchObject({ text: BODY });
    expect(responder).toHaveBeenCalledTimes(1);
    expect(fwd).toHaveBeenCalledTimes(1);
  });

  it('an ordinary message still runs the whole tail', async () => {
    const { i, ack, responder, fwd } = armed();
    i.handleBridgeEvent(channelEvent('Bob: Hello'));
    await settle();
    expect(ack).toHaveBeenCalledTimes(1);
    expect(responder).toHaveBeenCalledTimes(1);
    expect(fwd).toHaveBeenCalledTimes(1);
  });
});
