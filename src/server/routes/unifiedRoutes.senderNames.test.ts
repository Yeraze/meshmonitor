/**
 * GET /api/unified/messages resolves sender names for the senders on the page
 * (`nodes.getNodeNamesByNums`) instead of loading every node on each source.
 *
 * Each case compares the route's names to the OLD answer, built the old way:
 * `nodes.getAllNodes(source)` per source, keyed by nodeNum, first-seen source
 * wins and a later reception fills a blank name. Real auth and SQL via
 * createRouteTestApp.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import unifiedRoutes from './unifiedRoutes.js';
import { createRouteTestApp, type RouteTestHarness, type SeededUser } from '../test-helpers/routeTestApp.js';

const BROADCAST = 0xffffffff;
const T0 = 1_760_000_000_000;
const idOf = (n: number) => `!${n.toString(16).padStart(8, '0')}`;

const NAMED = 0x1001; // named on A and (differently) on B
const BLANK_ON_A = 0x1002; // a row on A with no names; named on B
const NO_ROW = 0x1003; // no node row anywhere
const SHORT_ONLY = 0x1004; // shortName only on A

describe('GET /api/unified/messages sender names', () => {
  let harness: RouteTestHarness;

  const addMessage = async (sourceId: string, from: number, packetId: number, text: string, createdAt: number) => {
    await harness.db.messages.insertMessage(
      {
        id: `${sourceId}_${from}_${packetId}`,
        fromNodeNum: from,
        toNodeNum: BROADCAST,
        fromNodeId: idOf(from),
        toNodeId: idOf(BROADCAST),
        text,
        channel: 0,
        portnum: 1,
        timestamp: createdAt,
        rxTime: createdAt,
        createdAt,
      },
      sourceId,
    );
  };

  const node = (nodeNum: number, sourceId: string, longName: string | null, shortName: string | null) =>
    harness.db.nodes.upsertNode({ nodeNum, nodeId: idOf(nodeNum), longName, shortName } as never, sourceId);

  /** The names the old whole-source load would have attached to each entry. */
  const legacyNames = async (entries: any[]) => {
    const maps = new Map<string, Map<number, { longName?: string; shortName?: string }>>();
    for (const sourceId of [harness.sourceA, harness.sourceB]) {
      const m = new Map<number, { longName?: string; shortName?: string }>();
      for (const n of await harness.db.nodes.getAllNodes(sourceId)) {
        m.set(Number(n.nodeNum), { longName: n.longName ?? undefined, shortName: n.shortName ?? undefined });
      }
      maps.set(sourceId, m);
    }
    return entries.map((e) => {
      let longName: string | undefined;
      let shortName: string | undefined;
      for (const r of e.receptions as Array<{ sourceId: string }>) {
        const sender = maps.get(r.sourceId)?.get(e.fromNodeNum);
        if (!longName && sender?.longName) longName = sender.longName;
        if (!shortName && sender?.shortName) shortName = sender.shortName;
      }
      return { text: e.text, longName, shortName };
    });
  };

  const fetchAndCompare = async (user: SeededUser) => {
    const agent = await harness.loginAs(user);
    const res = await agent.get('/api/unified/messages?channel=Primary&limit=100');
    expect(res.status).toBe(200);
    const got = res.body.map((e: any) => ({ text: e.text, longName: e.fromNodeLongName, shortName: e.fromNodeShortName }));
    expect(got).toEqual(await legacyNames(res.body));
    return Object.fromEntries(got.map((g: any) => [g.text, g]));
  };

  beforeEach(async () => {
    harness = await createRouteTestApp({
      useOptionalAuth: false,
      mount: (app) => app.use('/api/unified', unifiedRoutes),
    });
    for (const s of [harness.sourceA, harness.sourceB]) {
      await harness.db.messages.deleteAllMessages(s);
      await harness.db.channels.upsertChannel({ id: 0, name: 'Primary', role: 1 }, s);
    }

    await node(NAMED, harness.sourceA, 'Named A', 'NA');
    await node(NAMED, harness.sourceB, 'Named B', 'NB');
    await node(BLANK_ON_A, harness.sourceA, null, null);
    await node(BLANK_ON_A, harness.sourceB, 'Blank B', 'BB');
    await node(SHORT_ONLY, harness.sourceA, null, 'SO');
    // Nodes nobody on the page sent from: the old path loaded these too.
    for (let i = 0; i < 50; i++) await node(0x2000 + i, harness.sourceA, `bystander ${i}`, 'BY');

    await addMessage(harness.sourceA, NAMED, 1, 'named on A', T0 + 1);
    await addMessage(harness.sourceB, NAMED, 2, 'named on B', T0 + 2);
    // Same packet heard on both: A has a blank row, B fills it in.
    await addMessage(harness.sourceA, BLANK_ON_A, 3, 'blank then filled', T0 + 3);
    await addMessage(harness.sourceB, BLANK_ON_A, 3, 'blank then filled', T0 + 3);
    await addMessage(harness.sourceA, NO_ROW, 4, 'no node row', T0 + 4);
    await addMessage(harness.sourceA, SHORT_ONLY, 5, 'short only', T0 + 5);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const s of [harness.sourceA, harness.sourceB]) {
      await harness.db.messages.deleteAllMessages(s).catch(() => {});
    }
    await harness.cleanup();
  });

  it('admin: same names as the whole-source load, without loading every node', async () => {
    const getAllNodes = vi.spyOn(harness.db.nodes, 'getAllNodes');
    const byText = await fetchAndCompare(harness.admin);
    // fetchAndCompare's own legacy read calls getAllNodes twice; the route none.
    expect(getAllNodes).toHaveBeenCalledTimes(2);

    expect(byText['named on A']).toMatchObject({ longName: 'Named A', shortName: 'NA' });
    expect(byText['named on B']).toMatchObject({ longName: 'Named B', shortName: 'NB' });
    expect(byText['blank then filled']).toMatchObject({ longName: 'Blank B', shortName: 'BB' });
    expect(byText['no node row'].longName).toBeUndefined();
    expect(byText['short only']).toMatchObject({ shortName: 'SO' });
    expect(byText['short only'].longName).toBeUndefined();
  });

  it('limited reader of source A only: names come from A alone', async () => {
    await harness.grant(harness.limited.id, 'channel_0', 'read', harness.sourceA);
    const byText = await fetchAndCompare(harness.limited);
    expect(Object.keys(byText).sort()).toEqual(['blank then filled', 'named on A', 'no node row', 'short only']);
    // B's names never reach a reader without access to B.
    expect(byText['blank then filled'].longName).toBeUndefined();
  });

  it('a failed name lookup on one source still returns its messages, unnamed', async () => {
    const real = harness.db.nodes.getNodeNamesByNums.bind(harness.db.nodes);
    vi.spyOn(harness.db.nodes, 'getNodeNamesByNums').mockImplementation(async (nums, sourceIds) => {
      if (sourceIds.includes(harness.sourceA)) throw new Error('boom');
      return real(nums, sourceIds);
    });
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/api/unified/messages?channel=Primary&limit=100');
    expect(res.status).toBe(200);
    const byText = Object.fromEntries(res.body.map((e: any) => [e.text, e]));
    expect(byText['named on A'].fromNodeLongName).toBeUndefined();
    expect(byText['named on B'].fromNodeLongName).toBe('Named B');
  });
});
