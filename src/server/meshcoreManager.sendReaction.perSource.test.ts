/** Per-source isolation of outbound reactions (#5762). */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import databaseService from '../services/database.js';
import { isMeshCoreReactionError } from './errors/meshcoreReactionError.js';
import {
  THUMBS, newSourceId, makeManager, emitterSpies, rows, settle, channelEvent,
} from './test-helpers/meshcoreReactionHarness.js';

describe('outbound reactions are scoped per source (#5762)', () => {
  let a: string;
  let b: string;

  beforeAll(async () => {
    await databaseService.waitForReady();
  });
  beforeEach(() => {
    a = newSourceId();
    b = newSourceId();
    emitterSpies();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function both() {
    const A = makeManager(a);
    const B = makeManager(b);
    A.i.handleBridgeEvent(channelEvent('Bob: Hello'));
    B.i.handleBridgeEvent(channelEvent('Bob: Hello'));
    await settle();
    const ta = (await rows(a)).find(r => r.text === 'Hello')!;
    const tb = (await rows(b)).find(r => r.text === 'Hello')!;
    return { A, B, ta, tb };
  }

  it('an id from A is MESSAGE_NOT_FOUND on B', async () => {
    const { B, ta } = await both();
    await expect(B.m.sendReaction(ta.id, THUMBS)).rejects.toSatisfy(
      (e: unknown) => isMeshCoreReactionError(e) && e.code === 'MESSAGE_NOT_FOUND',
    );
  });

  it('a reaction sent on A does not make B a duplicate', async () => {
    const { A, B, ta, tb } = await both();
    await A.m.sendReaction(ta.id, THUMBS);
    const msg = await B.m.sendReaction(tb.id, THUMBS);
    expect(msg.reactionTargetId).toBe(tb.id);
    expect(B.calls.filter(c => c.cmd === 'send_message')).toHaveLength(1);
  });

  it('outbound off on A leaves B able to send', async () => {
    const { A, B, ta, tb } = await both();
    await databaseService.settings.setSourceSetting(a, 'meshcoreReactionsOutboundEnabled', 'false');
    await expect(A.m.sendReaction(ta.id, THUMBS)).rejects.toSatisfy(
      (e: unknown) => isMeshCoreReactionError(e) && e.code === 'REACTIONS_OUTBOUND_DISABLED',
    );
    await expect(B.m.sendReaction(tb.id, THUMBS)).resolves.toBeTruthy();
  });
});
