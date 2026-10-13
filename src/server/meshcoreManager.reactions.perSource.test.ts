/**
 * Per-source isolation of inbound reactions (#5761, epic #5759): a reaction on
 * source A never resolves to a target on source B, at ingest or late.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import databaseService from '../services/database.js';
import { buildMc1ChannelReaction } from '../utils/meshcoreReactions.js';
import { mc1HashForChannelWire } from '../utils/meshcoreReactionTarget.js';
import {
  SEC, THUMBS, newSourceId, makeManager, emitterSpies, rows, settle, channelEvent,
} from './test-helpers/meshcoreReactionHarness.js';

const WIRE = `Alice: ${buildMc1ChannelReaction('Bob', THUMBS, mc1HashForChannelWire('Bob: Hello', SEC)!)!}`;

describe('reactions are scoped per source (#5761)', () => {
  let a: string;
  let b: string;
  let spies: ReturnType<typeof emitterSpies>;

  beforeAll(async () => {
    await databaseService.waitForReady();
  });
  beforeEach(() => {
    a = newSourceId();
    b = newSourceId();
    spies = emitterSpies();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a reaction on A does not resolve to the same message on B', async () => {
    const A = makeManager(a);
    const B = makeManager(b);
    B.i.handleBridgeEvent(channelEvent('Bob: Hello'));
    await settle();
    A.i.handleBridgeEvent(channelEvent(WIRE, SEC + 5));
    await settle();
    const reaction = (await rows(a)).find(r => r.reactionEmoji)!;
    expect(reaction.reactionTargetId ?? null).toBeNull();
    expect(await rows(b)).toHaveLength(1);
  });

  it('a target arriving on B does not late-resolve a pending reaction on A', async () => {
    const A = makeManager(a);
    const B = makeManager(b);
    A.i.handleBridgeEvent(channelEvent(WIRE, SEC + 5));
    await settle();
    B.i.handleBridgeEvent(channelEvent('Bob: Hello'));
    await settle();
    expect((await rows(a)).find(r => r.reactionEmoji)!.reactionTargetId ?? null).toBeNull();
    expect(spies.resolved).not.toHaveBeenCalled();
    // The target then reaching A does resolve it.
    A.i.handleBridgeEvent(channelEvent('Bob: Hello'));
    await settle();
    expect((await rows(a)).find(r => r.reactionEmoji)!.reactionTargetId).toBeTruthy();
    expect(spies.resolved).toHaveBeenCalledTimes(1);
    expect(spies.resolved.mock.calls[0][1]).toBe(a);
  });

  it("deleting a target on A leaves B's reactions alone", async () => {
    const A = makeManager(a);
    const B = makeManager(b);
    for (const h of [A, B]) {
      h.i.handleBridgeEvent(channelEvent('Bob: Hello'));
      await settle();
      h.i.handleBridgeEvent(channelEvent(WIRE, SEC + 5));
      await settle();
    }
    const target = (await rows(a)).find(r => r.text === 'Hello')!;
    await A.m.deleteStoredMessage(target.id);
    expect(await rows(a)).toHaveLength(0);
    expect(await rows(b)).toHaveLength(2);
  });
});
