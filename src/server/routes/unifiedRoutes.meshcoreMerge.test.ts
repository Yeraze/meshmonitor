/**
 * GET /api/unified/messages — cross-source merge of MeshCore receptions (#5587).
 *
 * Real-middleware harness (createRouteTestApp): real sessions, real permission
 * rows, real `meshcore_messages` / `channels` rows. The merge must run AFTER
 * the per-source permission checks and the keyed-row gate, so the permission
 * cases here exercise real SQL.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import unifiedRoutes from './unifiedRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { channelKeyFingerprint, keyedChannelIndex } from '../services/meshcoreFrameIngest.js';

const COMPANION = 'mcmerge-companion';
const REPEATER = 'mcmerge-repeater';
const OTHER = 'mcmerge-other';
const MC_SOURCES = [
  { id: COMPANION, name: 'Hilltop Companion' },
  { id: REPEATER, name: 'Valley Repeater' },
  { id: OTHER, name: 'Third Radio' },
];

const SECRET_OPS = Buffer.alloc(16, 0x11);
const SECRET_ELSE = Buffer.alloc(16, 0x22);
const OPS_HEX = SECRET_OPS.toString('hex');
const OPS_FP = channelKeyFingerprint(OPS_HEX);
const OPS_KEYED = keyedChannelIndex(OPS_HEX);

const SEC = 1_790_000_000;
const T0 = SEC * 1000;

const ALICE_KEY = 'a1'.repeat(32);
const BOB_KEY = 'b2'.repeat(32);

describe('GET /api/unified/messages — MeshCore cross-source merge (#5587)', () => {
  let harness: RouteTestHarness;
  let seq = 0;

  /** A channel message as the companion path stores it (device slot 1). */
  const companionRow = (sourceId: string, over: Record<string, unknown> = {}) =>
    harness.db.meshcore.insertMessage(
      {
        id: `cmp-${++seq}`,
        fromPublicKey: 'channel-1',
        fromName: 'Alice',
        toPublicKey: null,
        text: 'hello mesh',
        timestamp: T0,
        messageType: 'text',
        hopCount: 1,
        createdAt: T0 + 300,
        ...over,
      } as never,
      sourceId,
    );

  /** The same message as the repeater path stores it (#5551 keyed row). */
  const repeaterRow = (over: Record<string, unknown> = {}) =>
    harness.db.meshcore.insertMessage(
      {
        id: `rpt_${REPEATER}_${++seq}`,
        fromPublicKey: `channel-${OPS_KEYED}`,
        fromName: 'Alice',
        toPublicKey: null,
        text: 'hello mesh',
        timestamp: T0,
        messageType: 'channel',
        hopCount: 0,
        keySourceId: COMPANION,
        keyChannelIdx: 1,
        keyFingerprint: OPS_FP,
        createdAt: T0 + 900,
        ...over,
      } as never,
      REPEATER,
    );

  beforeEach(async () => {
    seq = 0;
    harness = await createRouteTestApp({
      useOptionalAuth: false,
      mount: (app) => app.use('/api/unified', unifiedRoutes),
    });
    for (const s of MC_SOURCES) {
      await harness.db.sources.deleteSource(s.id).catch(() => {});
      await harness.db.sources.createSource({ id: s.id, name: s.name, type: 'meshcore', config: {}, enabled: true });
    }
    // The companion holds "Ops" in slot 1. OTHER also has a slot 1 named
    // "Ops", but with a DIFFERENT secret: same index, different channel.
    await harness.db.channels.upsertChannel(
      { id: 1, name: 'Ops', role: 2, psk: SECRET_OPS.toString('base64') } as never, COMPANION);
    await harness.db.channels.upsertChannel(
      { id: 1, name: 'Ops', role: 2, psk: SECRET_ELSE.toString('base64') } as never, OTHER);
  });

  afterEach(async () => {
    for (const s of MC_SOURCES) {
      await harness.db.meshcore.deleteAllMessagesForSource(s.id).catch(() => {});
      await harness.db.channels.deleteChannel(1, s.id).catch(() => {});
      await harness.db.channels.deleteChannel(5, s.id).catch(() => {});
      await harness.db.sources.deleteSource(s.id).catch(() => {});
    }
    await harness.cleanup();
  });

  const feed = async (user: Parameters<RouteTestHarness['loginAs']>[0], query = '') => {
    const agent = await harness.loginAs(user);
    const res = await agent.get(`/api/unified/messages${query}`);
    expect(res.status).toBe(200);
    return res;
  };
  const heardBy = (m: any): string[] => m.receptions.map((r: any) => r.sourceName).sort();

  it('merges a companion row and a repeater-keyed row for the same message', async () => {
    await companionRow(COMPANION);
    await repeaterRow();

    for (const query of ['', '?channel=Ops']) {
      const { body } = await feed(harness.admin, query);
      expect(body).toHaveLength(1);
      expect(body[0].text).toBe('hello mesh');
      expect(body[0].fromNodeLongName).toBe('Alice');
      expect(body[0].channelName).toBe('Ops');
      expect(heardBy(body[0])).toEqual(['Hilltop Companion', 'Valley Repeater']);
      // One reception per source, each with its own radio metadata.
      expect(body[0].receptions.map((r: any) => r.hopCount).sort()).toEqual([0, 1]);
      expect(body[0].createdAt).toBe(T0 + 300);
    }
  });

  it('merges when the same channel sits in different slots on two companions', async () => {
    await harness.db.channels.upsertChannel(
      { id: 5, name: 'Ops', role: 2, psk: OPS_HEX } as never, REPEATER);
    await companionRow(COMPANION);
    await companionRow(REPEATER, { fromPublicKey: 'channel-5', createdAt: T0 + 700 });

    const { body } = await feed(harness.admin);
    expect(body).toHaveLength(1);
    expect(heardBy(body[0])).toEqual(['Hilltop Companion', 'Valley Repeater']);
  });

  it('does not merge different channels that share an index', async () => {
    await companionRow(COMPANION);
    await companionRow(OTHER);

    const { body } = await feed(harness.admin);
    expect(body).toHaveLength(2);
    expect(body.map(heardBy).sort()).toEqual([['Hilltop Companion'], ['Third Radio']]);
    expect(body[0].dedupKey).not.toBe(body[1].dedupKey);
  });

  it('keeps the same text sent twice by one sender as two rows', async () => {
    await companionRow(COMPANION);
    await repeaterRow();
    await companionRow(COMPANION, { timestamp: T0 + 4000, createdAt: T0 + 4300 });
    await repeaterRow({ timestamp: T0 + 4000, createdAt: T0 + 4900 });

    const { body } = await feed(harness.admin);
    expect(body).toHaveLength(2);
    for (const m of body) expect(heardBy(m)).toEqual(['Hilltop Companion', 'Valley Repeater']);
    expect(body.map((m: any) => m.timestamp).sort()).toEqual([T0, T0 + 4000]);
  });

  it('keeps two clock-less copies heard by ONE source as two rows', async () => {
    // Receipt-clock timestamps (ms part set): the sender had no usable clock.
    await companionRow(COMPANION, { timestamp: T0 + 211, createdAt: T0 + 211 });
    await companionRow(COMPANION, { timestamp: T0 + 3377, createdAt: T0 + 3377 });

    const { body } = await feed(harness.admin);
    expect(body).toHaveLength(2);
  });

  it('merges our own sent channel message with its echo heard by another source', async () => {
    await harness.db.meshcore.insertMessage(
      {
        id: 'sent-1790000000123-abc',
        fromPublicKey: ALICE_KEY,
        fromName: 'Alice',
        toPublicKey: 'channel-1',
        text: 'hello mesh',
        timestamp: T0 + 123,
        senderTimestamp: SEC,
        messageType: 'text',
        createdAt: T0 + 123,
      } as never,
      COMPANION,
    );
    await repeaterRow();

    const { body } = await feed(harness.admin);
    expect(body).toHaveLength(1);
    expect(heardBy(body[0])).toEqual(['Hilltop Companion', 'Valley Repeater']);
    // The sent row came first, so it leads: the real sender key is kept.
    expect(body[0].fromNodeId).toBe(ALICE_KEY);
  });

  it('merges a DM sent by one source with the copy another source received', async () => {
    await harness.db.meshcore.insertMessage(
      {
        id: 'sent-1790000000250-dm',
        fromPublicKey: ALICE_KEY,
        fromName: 'Alice',
        toPublicKey: BOB_KEY,
        text: 'direct hello',
        timestamp: T0 + 250,
        messageType: 'text',
        createdAt: T0 + 250,
      } as never,
      COMPANION,
    );
    await harness.db.meshcore.insertMessage(
      {
        id: 'dm-rx-1',
        fromPublicKey: ALICE_KEY.slice(0, 12),
        toPublicKey: BOB_KEY,
        text: 'direct hello',
        timestamp: T0,
        messageType: 'text',
        createdAt: T0 + 2600,
      } as never,
      OTHER,
    );

    const { body } = await feed(harness.admin);
    expect(body).toHaveLength(1);
    expect(body[0].channel).toBe(-1);
    expect(heardBy(body[0])).toEqual(['Hilltop Companion', 'Third Radio']);
  });

  describe('permissions', () => {
    it('shows a one-source viewer one reception and no trace of the other source', async () => {
      await companionRow(COMPANION);
      await repeaterRow();
      await harness.grant(harness.limited.id, 'messages', 'read', COMPANION);

      const admin = await feed(harness.admin);
      const limited = await feed(harness.limited);
      expect(limited.body).toHaveLength(1);
      expect(limited.body[0].receptions).toHaveLength(1);
      expect(limited.body[0].receptions[0].sourceId).toBe(COMPANION);
      expect(limited.text).not.toContain(REPEATER);
      expect(limited.text).not.toContain('Valley Repeater');
      // The key is content-derived, so it names no source and is the same
      // row the admin sees.
      expect(limited.body[0].dedupKey).toBe(admin.body[0].dedupKey);
    });

    it('hides the keyed repeater row from a viewer without access to its key', async () => {
      await companionRow(COMPANION);
      await repeaterRow();
      // Reads the repeater source, but no channel anywhere holds the Ops key
      // for this viewer.
      await harness.grant(harness.limited.id, 'messages', 'read', REPEATER);

      const limited = await feed(harness.limited);
      expect(limited.body).toEqual([]);
      expect(limited.text).not.toContain('hello mesh');
    });

    it('lists the repeater reception alone when only it is readable, under the same key', async () => {
      await companionRow(COMPANION);
      await repeaterRow();
      await harness.grant(harness.limited.id, 'messages', 'read', REPEATER);
      // Key access without message access on the companion source.
      await harness.grant(harness.limited.id, 'channel_1', 'read', COMPANION);

      const admin = await feed(harness.admin);
      const limited = await feed(harness.limited);
      expect(limited.body).toHaveLength(1);
      expect(heardBy(limited.body[0])).toEqual(['Valley Repeater']);
      expect(limited.text).not.toContain('Hilltop Companion');
      expect(limited.body[0].dedupKey).toBe(admin.body[0].dedupKey);
    });

    it('returns nothing to an anonymous viewer', async () => {
      await companionRow(COMPANION);
      await repeaterRow();
      const anon = await feed(null);
      expect(anon.body).toEqual([]);
    });
  });

  describe('pagination', () => {
    /** Message `k`: the companion hears it at `a`, the repeater at `b` (createdAt). */
    const pair = async (k: number, a: number, b: number) => {
      const sent = T0 + k * 60_000;
      await companionRow(COMPANION, { text: `msg ${k}`, timestamp: sent, createdAt: a });
      await repeaterRow({ text: `msg ${k}`, timestamp: sent, createdAt: b });
    };

    it('keeps keys stable across pages and keeps both receptions on a row that straddles the cursor', async () => {
      // msg 1's repeater copy (2100) lands AFTER msg 2's first copy (2000),
      // which is where the page-1 cursor falls.
      await pair(1, T0 + 1900, T0 + 2100);
      await pair(2, T0 + 2000, T0 + 2050);
      await pair(3, T0 + 3000, T0 + 3200);

      const all = (await feed(harness.admin, '?limit=50')).body;
      expect(all.map((m: any) => m.text)).toEqual(['msg 3', 'msg 2', 'msg 1']);
      const keyOf = new Map<string, string>(all.map((m: any) => [m.text, m.dedupKey]));

      const page1 = (await feed(harness.admin, '?limit=2')).body;
      expect(page1.map((m: any) => m.text)).toEqual(['msg 3', 'msg 2']);
      const cursor = page1[page1.length - 1].createdAt;
      expect(cursor).toBe(T0 + 2000);

      const page2 = (await feed(harness.admin, `?limit=2&before=${cursor}`)).body;
      expect(page2.map((m: any) => m.text)).toEqual(['msg 1']);
      expect(heardBy(page2[0])).toEqual(['Hilltop Companion', 'Valley Repeater']);

      for (const m of [...page1, ...page2]) expect(m.dedupKey).toBe(keyOf.get(m.text));
      // No row appears on both pages.
      expect(new Set([...page1, ...page2].map((m: any) => m.dedupKey)).size).toBe(3);
    });

    it('keeps the key of a clock-less row when its second reception arrives on a later poll', async () => {
      await companionRow(COMPANION, { id: 'first-heard', timestamp: T0 + 211, createdAt: T0 + 211 });
      const poll1 = (await feed(harness.admin)).body;
      expect(poll1).toHaveLength(1);
      expect(poll1[0].receptions).toHaveLength(1);

      await repeaterRow({ timestamp: T0 + 2755, createdAt: T0 + 2755 });
      const poll2 = (await feed(harness.admin)).body;
      expect(poll2).toHaveLength(1);
      expect(poll2[0].receptions).toHaveLength(2);
      expect(poll2[0].dedupKey).toBe(poll1[0].dedupKey);
    });
  });
});
