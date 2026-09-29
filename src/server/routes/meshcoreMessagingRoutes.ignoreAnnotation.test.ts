/**
 * Read-time Ignore / Block annotation on MeshCore message reads (#5408).
 * The ignored state is computed from the CURRENT lists, never stored on the
 * row, so removing an entry makes the same stored messages render normally.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { meshcoreMessageFilter } from '../services/meshcoreMessageFilter.js';

const SELF = 'aa'.repeat(32);
const SPAMMER = 'cc'.repeat(32);

const channelPage = [
  { id: 'm1', fromPublicKey: 'channel-0', fromName: 'Alice', text: 'hello', timestamp: 100 },
  { id: 'm2', fromPublicKey: 'channel-0', fromName: 'Spammer', text: 'buy', timestamp: 200 },
  { id: 'm3', fromPublicKey: 'channel-0', fromName: 'Spammer', text: 'buy more', timestamp: 300 },
];

const fakeManager = {
  isMeshCore: true,
  getLocalNode: () => ({ publicKey: SELF }),
  getRecentMessages: vi.fn(() => [
    { id: 'd1', fromPublicKey: SPAMMER.slice(0, 12), toPublicKey: SELF, text: 'dm spam', timestamp: 50 },
    { id: 'd2', fromPublicKey: SELF, toPublicKey: SPAMMER, text: 'reply', timestamp: 60 },
  ]),
  getChannelMessages: vi.fn(async () => channelPage),
  getChannelMessageCounts: vi.fn(async (idxs: number[]) => Object.fromEntries(idxs.map((i) => [i, 3]))),
  getChannelLatestTimestamps: vi.fn(async (idxs: number[]) => Object.fromEntries(idxs.map((i) => [i, 300]))),
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

describe('MeshCore message reads — ignore annotation (#5408)', () => {
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

  it('channel history flags the matching messages and unflags them once the entry is removed', async () => {
    const agent = await harness.loginAs(harness.admin);
    await agent.post(`/${harness.sourceA}/meshcore/ignored-nodes`).send({ publicKey: SPAMMER, mode: 'ignore', name: 'Spammer' }).expect(200);

    const res = await agent.get(`/${harness.sourceA}/meshcore/messages/channel/0`).expect(200);
    expect(res.body.data.map((m: { filtered?: string }) => m.filtered ?? null)).toEqual([null, 'ignore', 'ignore']);

    // The same list on the other source is untouched (per-source scope).
    const other = await agent.get(`/${harness.sourceB}/meshcore/messages/channel/0`).expect(200);
    expect(other.body.data.every((m: { filtered?: string }) => !m.filtered)).toBe(true);

    await agent.delete(`/${harness.sourceA}/meshcore/ignored-nodes/${SPAMMER}`).expect(200);
    const after = await agent.get(`/${harness.sourceA}/meshcore/messages/channel/0`).expect(200);
    expect(after.body.data.every((m: { filtered?: string }) => !m.filtered)).toBe(true);
  });

  it('recent messages flag a DM by key prefix but never our own sends', async () => {
    const agent = await harness.loginAs(harness.admin);
    await agent.post(`/${harness.sourceA}/meshcore/ignored-nodes`).send({ publicKey: SPAMMER, mode: 'block' }).expect(200);
    const res = await agent.get(`/${harness.sourceA}/meshcore/messages`).expect(200);
    expect(res.body.data.map((m: { id: string; filtered?: string }) => [m.id, m.filtered ?? null])).toEqual([
      ['d1', 'block'],
      ['d2', null],
    ]);
  });

  it('unread latest timestamps skip ignored messages', async () => {
    const agent = await harness.loginAs(harness.admin);
    const before = await agent.get(`/${harness.sourceA}/meshcore/messages/channel-counts?channels=0`).expect(200);
    expect(before.body.latestTimestamps).toEqual({ 0: 300 });

    await agent.post(`/${harness.sourceA}/meshcore/ignored-nodes`).send({ publicKey: SPAMMER, mode: 'ignore', name: 'Spammer' }).expect(200);
    const after = await agent.get(`/${harness.sourceA}/meshcore/messages/channel-counts?channels=0`).expect(200);
    // Newest non-ignored message is Alice's at 100.
    expect(after.body.latestTimestamps).toEqual({ 0: 100 });
    // Counts stay totals.
    expect(after.body.counts).toEqual({ 0: 3 });
  });
});
