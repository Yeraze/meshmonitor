/**
 * GET /api/unified/messages — MeshCore reaction refs (#5759 / #5763).
 *
 * A reaction entry carries `reactionEmoji` + `reactionTargetRefs`; a plain
 * entry carries `meshcoreRowRefs`. Refs are `mc:<sourceId>:<rowId>` strings
 * built only from rows that already passed the per-source permission and
 * keyed-row gates, so a viewer never sees anything derived from a source or
 * channel they cannot read. Real permission rows (createRouteTestApp).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import unifiedRoutes from './unifiedRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { channelKeyFingerprint, keyedChannelIndex } from '../services/meshcoreFrameIngest.js';
import { meshcoreMessageFilter } from '../services/meshcoreMessageFilter.js';

const A = 'mcrx-a';
const B = 'mcrx-b';
const SOURCES = [
  { id: A, name: 'Alpha Radio' },
  { id: B, name: 'Bravo Radio' },
];
const OPS_HEX = Buffer.alloc(16, 0x11).toString('hex');
const OPS_FP = channelKeyFingerprint(OPS_HEX);
const OPS_KEYED = keyedChannelIndex(OPS_HEX);
const T0 = 1_790_000_000_000;
const THUMB = '\u{1F44D}';
const HASH = 'b45pc4ek';

describe('GET /api/unified/messages — MeshCore reaction refs (#5759)', () => {
  let harness: RouteTestHarness;
  let seq = 0;

  const plain = (sourceId: string, id: string, over: Record<string, unknown> = {}) =>
    harness.db.meshcore.insertMessage(
      {
        id, fromPublicKey: 'channel-1', fromName: 'Alice', toPublicKey: null, text: 'hello mesh',
        timestamp: T0, messageType: 'text', createdAt: T0 + 300 + ++seq, ...over,
      } as never,
      sourceId,
    );
  const react = (sourceId: string, id: string, over: Record<string, unknown> = {}) =>
    plain(sourceId, id, {
      fromName: 'Bob', text: THUMB, timestamp: T0 + 5000, createdAt: T0 + 5300 + seq,
      reactionEmoji: THUMB, reactionFormat: 'mc1-channel', reactionTargetHash: HASH,
      reactionTargetSender: 'Alice', reactionRawText: `@[Alice]${THUMB}\n${HASH}`, ...over,
    });

  beforeEach(async () => {
    seq = 0;
    harness = await createRouteTestApp({ useOptionalAuth: false, mount: (app) => app.use('/api/unified', unifiedRoutes) });
    for (const s of SOURCES) {
      await harness.db.sources.deleteSource(s.id).catch(() => {});
      await harness.db.sources.createSource({ id: s.id, name: s.name, type: 'meshcore', config: {}, enabled: true });
      await harness.db.channels.upsertChannel({ id: 1, name: 'Ops', role: 2, psk: Buffer.from(OPS_HEX, 'hex').toString('base64') } as never, s.id);
    }
  });

  afterEach(async () => {
    for (const s of SOURCES) {
      meshcoreMessageFilter.setState(s.id, [], []);
      await harness.db.meshcore.deleteAllMessagesForSource(s.id).catch(() => {});
      await harness.db.channels.deleteChannel(1, s.id).catch(() => {});
      await harness.db.sources.deleteSource(s.id).catch(() => {});
    }
    await harness.cleanup();
  });

  const feed = async (user: Parameters<RouteTestHarness['loginAs']>[0], query = '') => {
    const res = await (await harness.loginAs(user)).get(`/api/unified/messages${query}`);
    expect(res.status).toBe(200);
    return res;
  };
  const reactionsOf = (body: any[]) => body.filter((m) => m.reactionEmoji);
  const plainOf = (body: any[]) => body.filter((m) => !m.reactionEmoji);

  it('refs the target on both sources and the matched target of the reaction', async () => {
    await plain(A, 'tA');
    await plain(B, 'tB');
    await react(A, 'rA', { reactionTargetId: 'tA' });

    const { body } = await feed(harness.admin);
    expect(Array.isArray(body)).toBe(true);
    const [target] = plainOf(body);
    const [reaction] = reactionsOf(body);
    expect(target.meshcoreRowRefs.sort()).toEqual([`mc:${A}:tA`, `mc:${B}:tB`]);
    expect(reaction.reactionEmoji).toBe(THUMB);
    expect(reaction.reactionTargetRefs).toEqual([`mc:${A}:tA`]);
    expect(reaction.meshcoreRowRefs).toBeUndefined();
    expect(target.reactionEmoji).toBeUndefined();
  });

  it('merges a reaction heard on two sources and keeps both target refs', async () => {
    await plain(A, 'tA');
    await plain(B, 'tB');
    await react(A, 'rA', { reactionTargetId: 'tA' });
    await react(B, 'rB', { reactionTargetId: 'tB' });

    const { body } = await feed(harness.admin);
    const reactions = reactionsOf(body);
    expect(reactions).toHaveLength(1);
    expect(reactions[0].receptions).toHaveLength(2);
    expect(reactions[0].reactionTargetRefs.sort()).toEqual([`mc:${A}:tA`, `mc:${B}:tB`]);
  });

  it('gives an empty ref list when the reaction is unmatched everywhere', async () => {
    await react(A, 'rA');
    const { body } = await feed(harness.admin);
    expect(reactionsOf(body)[0].reactionTargetRefs).toEqual([]);
  });

  it('shows a one-source viewer nothing derived from the other source', async () => {
    await plain(A, 'tA');
    await plain(B, 'tB');
    await react(A, 'rA', { reactionTargetId: 'tA' });
    await react(B, 'rB'); // unmatched on B
    await harness.grant(harness.limited.id, 'messages', 'read', B);

    const { body, text } = await feed(harness.limited);
    const reactions = reactionsOf(body);
    expect(reactions).toHaveLength(1);
    expect(reactions[0].receptions).toHaveLength(1);
    expect(reactions[0].receptions[0].sourceId).toBe(B);
    expect(reactions[0].reactionTargetRefs).toEqual([]);
    expect(plainOf(body)[0].meshcoreRowRefs).toEqual([`mc:${B}:tB`]);
    expect(text).not.toContain(A);
    expect(text).not.toContain('Alpha Radio');
    expect(text).not.toContain('tA');
    expect(text).not.toContain('rA');
  });

  it('shows a viewer who reads A only the A target ref and one reception', async () => {
    await plain(A, 'tA');
    await plain(B, 'tB');
    await react(A, 'rA', { reactionTargetId: 'tA' });
    await react(B, 'rB');
    await harness.grant(harness.limited.id, 'messages', 'read', A);

    const { body, text } = await feed(harness.limited);
    expect(reactionsOf(body)[0].reactionTargetRefs).toEqual([`mc:${A}:tA`]);
    expect(plainOf(body)[0].receptions).toHaveLength(1);
    expect(plainOf(body)[0].meshcoreRowRefs).toEqual([`mc:${A}:tA`]);
    expect(text).not.toContain(B);
    expect(text).not.toContain('Bravo Radio');
  });

  it('serves a channel-only grant and drops a reaction on an unreadable channel', async () => {
    await plain(A, 'tA');
    await react(A, 'rA', { reactionTargetId: 'tA' });
    await react(A, 'rHidden', { fromPublicKey: 'channel-2', text: '\u{1F389}', reactionEmoji: '\u{1F389}', reactionTargetHash: 'zzzz' });
    await harness.grant(harness.limited.id, 'channel_1', 'read', A);

    const { body } = await feed(harness.limited, '?channel=Ops');
    expect(reactionsOf(body)).toHaveLength(1);
    expect(reactionsOf(body)[0].reactionEmoji).toBe(THUMB);
    expect(reactionsOf(body)[0].reactionTargetRefs).toEqual([`mc:${A}:tA`]);
    expect(plainOf(body)).toHaveLength(1);
  });

  it('hides a keyed reaction row from a viewer who cannot use its key', async () => {
    // Only A holds the Ops key; the viewer reads B alone, so no channel
    // they can use holds it.
    await harness.db.channels.deleteChannel(1, B);
    await react(B, 'rKeyed', {
      fromPublicKey: `channel-${OPS_KEYED}`, messageType: 'channel',
      keySourceId: A, keyChannelIdx: 1, keyFingerprint: OPS_FP,
    });
    await harness.grant(harness.limited.id, 'messages', 'read', B);

    const { body, text } = await feed(harness.limited);
    expect(body).toEqual([]);
    expect(text).not.toContain(THUMB);
  });

  it('drops a reaction from an ignored reactor but keeps that reactor\'s plain message', async () => {
    await plain(A, 'tA');
    await plain(A, 'bobSays', { fromName: 'Bob', text: 'bob here', timestamp: T0 + 100 });
    await react(A, 'rA', { reactionTargetId: 'tA' });
    meshcoreMessageFilter.setState(A, [
      { sourceId: A, publicKey: 'b2'.repeat(32), name: 'Bob', mode: 'ignore', createdAt: 0, createdBy: null, hitCount: 0, lastHitAt: null },
    ], []);

    const { body } = await feed(harness.admin);
    expect(reactionsOf(body)).toHaveLength(0);
    expect(body.map((m: any) => m.text).sort()).toEqual(['bob here', 'hello mesh']);
  });

  it('never leaks the hash, the raw wire text or the target sender', async () => {
    await plain(A, 'tA');
    await react(A, 'rA', { reactionTargetId: 'tA' });
    const { text, body } = await feed(harness.admin);
    expect(text).not.toContain(HASH);
    expect(text).not.toContain('@[');
    expect(text).not.toContain('reactionTargetHash');
    expect(text).not.toContain('reactionRawText');
    expect(text).not.toContain('reactionTargetSender');
    expect(reactionsOf(body)[0].emoji).toBeNull();
  });
});
