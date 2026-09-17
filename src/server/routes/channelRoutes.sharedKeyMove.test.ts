/**
 * Channel edits must not "move" message history between two channels that
 * share a PSK (discussion #5183).
 *
 * The route layer kept its own PSK-only move detector. Channel 0 and a
 * secondary channel on the same key — both on the default `AQ==`, very common
 * — matched each other, the reverse match was dropped as a duplicate, and the
 * result applied as a one-way move: editing or adding ANY channel rewrote the
 * secondary's whole history into Channel 0, permanently.
 *
 * Real-middleware harness; the only mock is the device manager, so the channel
 * PUT runs its real snapshot → detect → migrate path against real SQLite.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const setChannelConfig = vi.fn().mockResolvedValue(undefined);
vi.mock('../utils/resolveSourceManager.js', () => ({
  resolveSourceManager: () => ({ setChannelConfig, sourceId: 'rt-source-a' }),
}));

import channelRoutes from './channelRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const DEFAULT_KEY = 'AQ==';
const OTHER_KEY = Buffer.alloc(32, 7).toString('base64');

describe('channel PUT with two channels on the same key (#5183)', () => {
  let harness: RouteTestHarness;
  let packetId = 1000;
  // The harness shares one :memory: DB across tests, so rows from earlier tests
  // survive. Tag each test's messages and only look at this test's rows.
  let run = 0;
  let tag = '';

  async function seedChannel(sourceId: string, id: number, name: string, psk: string | null, role: number) {
    await harness.db.channels.upsertChannel({ id, name, psk: psk ?? undefined, role }, sourceId, { allowBlankName: true });
  }

  async function seedMessage(sourceId: string, channel: number, text: string) {
    const id = packetId++;
    await harness.db.messages.insertMessage(
      {
        id: `${sourceId}_1111_${id}`,
        fromNodeNum: 1111,
        toNodeNum: 0xffffffff,
        fromNodeId: '!00000457',
        toNodeId: '!ffffffff',
        text: `${tag} ${text}`,
        channel,
        portnum: 1,
        timestamp: Date.now(),
        createdAt: Date.now(),
      } as never,
      sourceId,
    );
  }

  const channelTexts = async (sourceId: string, channel: number) =>
    (await harness.db.messages.getMessagesByChannel(channel, 500, 0, sourceId))
      .map((m) => m.text as string)
      .filter((t) => t.startsWith(`${tag} `))
      .map((t) => t.slice(tag.length + 1))
      .sort();

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', channelRoutes) });
    setChannelConfig.mockClear();
    tag = `run${++run}`;
    for (const src of [harness.sourceA, harness.sourceB]) {
      await seedChannel(src, 0, 'LongFast', DEFAULT_KEY, 1);
      await seedChannel(src, 3, 'Friends', DEFAULT_KEY, 2);
      await seedChannel(src, 6, '', null, 0);
      await seedMessage(src, 0, `${src} primary`);
      await seedMessage(src, 3, `${src} friends 1`);
      await seedMessage(src, 3, `${src} friends 2`);
    }
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('adding an unrelated channel leaves the shared-key channel history where it was', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent
      .put('/6')
      .send({ sourceId: harness.sourceA, name: 'NewChan', psk: OTHER_KEY, role: 2 });
    expect(res.status).toBe(200);
    expect(setChannelConfig).toHaveBeenCalledTimes(1);

    const a = harness.sourceA;
    expect(await channelTexts(a, 3)).toEqual([`${a} friends 1`, `${a} friends 2`]);
    expect(await channelTexts(a, 0)).toEqual([`${a} primary`]);
  });

  it("never touches another source's messages", async () => {
    const agent = await harness.loginAs(harness.admin);
    await agent.put('/6').send({ sourceId: harness.sourceA, name: 'NewChan', psk: OTHER_KEY, role: 2 });

    const b = harness.sourceB;
    expect(await channelTexts(b, 3)).toEqual([`${b} friends 1`, `${b} friends 2`]);
    expect(await channelTexts(b, 0)).toEqual([`${b} primary`]);
  });

  it('renaming the shared-key secondary does not move its history either', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.put('/3').send({ sourceId: harness.sourceA, name: 'Pals' });
    expect(res.status).toBe(200);

    const a = harness.sourceA;
    expect(await channelTexts(a, 3)).toEqual([`${a} friends 1`, `${a} friends 2`]);
    expect(await channelTexts(a, 0)).toEqual([`${a} primary`]);
  });
});
