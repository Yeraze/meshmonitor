/**
 * MeshCore reaction rows on the message routes (#5759 / #5761).
 *
 * A reaction row is a normal message row with `reactionEmoji` set, so the
 * routes return it with the other messages and pass its fields through. The
 * routes must (a) gate it by the same per-channel permission, (b) never expose
 * the internal `mc1Hash`, and (c) keep it out of the unread-dot timestamp.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { meshcoreMessageFilter } from '../services/meshcoreMessageFilter.js';

const SPAMMER = 'cc'.repeat(32);

const channelPage = [
  { id: 'm1', fromPublicKey: 'channel-0', fromName: 'Alice', text: 'Hello', timestamp: 100, senderTimestamp: 100 },
  {
    id: 'r1', fromPublicKey: 'channel-0', fromName: 'Bob', text: '\u{1F44D}', timestamp: 200,
    reactionEmoji: '\u{1F44D}', reactionFormat: 'mc1-channel', reactionTargetId: 'm1',
    reactionTargetHash: 'b45pc4ek', reactionTargetSender: 'Alice',
    reactionRawText: '@[Alice]\u{1F44D}\nb45pc4ek',
  },
  {
    id: 'r2', fromPublicKey: 'channel-0', fromName: 'Cara', text: '\u{2764}', timestamp: 300,
    reactionEmoji: '\u{2764}', reactionFormat: 'mc1-channel', reactionTargetId: null,
    reactionTargetHash: 'zzzzzzzz', reactionTargetSender: 'Alice',
    reactionRawText: '@[Alice]\u{2764}\nzzzzzzzz',
  },
];

const fakeManager = {
  isMeshCore: true,
  getLocalNode: () => ({ publicKey: 'aa'.repeat(32) }),
  getChannelMessages: vi.fn(async () => channelPage),
  getChannelMessageCounts: vi.fn(async (idxs: number[]) => Object.fromEntries(idxs.map((i) => [i, 1]))),
  getChannelLatestTimestamps: vi.fn(async (idxs: number[]) => Object.fromEntries(idxs.map((i) => [i, 100]))),
  getRecentMessages: vi.fn(() => []),
};

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: { getManager: vi.fn(() => fakeManager) },
}));
vi.mock('../sourceManagerTypes.js', () => ({
  isMeshCoreManager: (m: unknown) => !!m,
  isAnyMeshCoreManager: (m: unknown) => !!m,
  isMeshCoreMqttManager: () => false,
  isMeshtasticManager: () => false,
  getPrimaryMeshtasticManager: () => null,
}));

const { default: meshcoreRoutes } = await import('./meshcoreRoutes.js');

describe('MeshCore reaction rows on the message routes (#5759)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/:id/meshcore', meshcoreRoutes),
    });
  });
  afterEach(async () => {
    meshcoreMessageFilter.resetForTests();
    await harness.cleanup();
  });

  const chanUrl = (src: string, idx: number) => `/${src}/meshcore/messages/channel/${idx}`;

  it('returns the reaction fields to a viewer with channel_0:read, and never mc1Hash', async () => {
    await harness.grant(harness.limited.id, 'channel_0', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);

    const res = await agent.get(chanUrl(harness.sourceA, 0)).expect(200);
    const byId = Object.fromEntries(res.body.data.map((m: { id: string }) => [m.id, m]));
    expect(byId.r1).toMatchObject({
      text: '\u{1F44D}', reactionEmoji: '\u{1F44D}', reactionFormat: 'mc1-channel',
      reactionTargetId: 'm1', reactionTargetHash: 'b45pc4ek', reactionTargetSender: 'Alice',
      reactionRawText: '@[Alice]\u{1F44D}\nb45pc4ek',
    });
    expect(byId.r2.reactionTargetId).toBeNull();
    expect(byId.m1.senderTimestamp).toBe(100);
    for (const m of res.body.data) expect(m).not.toHaveProperty('mc1Hash');
  });

  it('is 403 without the channel grant, and a grant on source A opens nothing on B', async () => {
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.get(chanUrl(harness.sourceA, 0))).status).toBe(403);

    await harness.grant(harness.limited.id, 'channel_0', 'read', harness.sourceA);
    const granted = await harness.loginAs(harness.limited);
    expect((await granted.get(chanUrl(harness.sourceA, 0))).status).toBe(200);
    expect((await granted.get(chanUrl(harness.sourceB, 0))).status).toBe(403);
  });

  it('a reaction row never sets the unread timestamp of a channel', async () => {
    const agent = await harness.loginAs(harness.admin);
    // Ignore entries switch on the per-channel newest-page scan. Raw latest is 300
    // (a reaction row); the newest ordinary message is Alice's at 100.
    await agent.post(`/${harness.sourceA}/meshcore/ignored-nodes`)
      .send({ publicKey: SPAMMER, mode: 'ignore', name: 'Spammer' }).expect(200);
    fakeManager.getChannelLatestTimestamps.mockResolvedValueOnce({ 0: 300 });

    const res = await agent.get(`/${harness.sourceA}/meshcore/messages/channel-counts?channels=0`).expect(200);
    expect(res.body.latestTimestamps).toEqual({ 0: 100 });
    // The manager (repository) already leaves reaction rows out of counts.
    expect(res.body.counts).toEqual({ 0: 1 });
  });
});
