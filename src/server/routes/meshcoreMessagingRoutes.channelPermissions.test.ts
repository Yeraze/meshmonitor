/**
 * MeshCore channel messages — per-channel permission gating.
 *
 * The bug: the MeshCore channel *list* (`/api/channels/all`) gates on
 * `channel_${idx}`, but the channel *messages* route gated on the global
 * `messages` resource. Granting a user "Public: Read" on a MeshCore source
 * therefore showed the channel in the sidebar with nothing in it — the list
 * call returned 200 and every message call returned 403.
 *
 * Uses the real-middleware harness rather than mocked permission lambdas,
 * because the thing under test *is* the permission logic: a fake
 * `checkPermissionAsync` would happily pass while the real SQL denied.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

// A stand-in MeshCore manager: the guard requires a registered manager of the
// right type before any handler runs.
const fakeManager = {
  isMeshCore: true,
  getChannelMessages: vi.fn().mockResolvedValue([
    { id: 'm1', text: 'hello public', channelIdx: 0, timestamp: 100 },
  ]),
  getChannelMessageCounts: vi.fn().mockImplementation(async (idxs: number[]) =>
    Object.fromEntries(idxs.map((i) => [i, 10 + i])),
  ),
  getChannelLatestTimestamps: vi.fn().mockImplementation(async (idxs: number[]) =>
    Object.fromEntries(idxs.map((i) => [i, 1000 + i])),
  ),
  getMessages: vi.fn().mockResolvedValue([]),
};

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: { getManager: vi.fn(() => fakeManager) },
}));
vi.mock('../sourceManagerTypes.js', () => ({
  isMeshCoreManager: (m: unknown) => !!m,
  isMeshtasticManager: () => false,
  getPrimaryMeshtasticManager: () => null,
}));

const { default: meshcoreRoutes } = await import('./meshcoreRoutes.js');

describe('MeshCore channel messages — per-channel permissions', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/:id/meshcore', meshcoreRoutes),
    });
  });
  afterEach(async () => { await harness.cleanup(); });

  const chanUrl = (src: string, idx: number) => `/${src}/meshcore/messages/channel/${idx}`;

  describe('the reported bug', () => {
    it('channel_0:read alone is enough to read channel 0', async () => {
      // Exactly the grant an operator makes via "Public: Read". Before the fix
      // this returned 403 asking for `messages`.
      await harness.grant(harness.limited.id, 'channel_0', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);

      const res = await agent.get(chanUrl(harness.sourceA, 0));
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });

    it('works for the anonymous user, not just logged-in ones', async () => {
      // The reported case was anonymous. optionalAuth falls back to the
      // anonymous row, so the grant must be honoured there too.
      await harness.grant(harness.anonymous.id, 'channel_0', 'read', harness.sourceA);
      const agent = await harness.loginAs(null);

      const res = await agent.get(chanUrl(harness.sourceA, 0));
      expect(res.status).toBe(200);
    });
  });

  describe('still denies what it should', () => {
    it('a grant on channel 0 does not open channel 3', async () => {
      await harness.grant(harness.limited.id, 'channel_0', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);

      const res = await agent.get(chanUrl(harness.sourceA, 3));
      expect(res.status).toBe(403);
    });

    it('names the per-channel resource in the 403, not `messages`', async () => {
      // Reporting `messages` is what made this hard to diagnose: the operator
      // had granted the channel and the error pointed at a different resource.
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(chanUrl(harness.sourceA, 3));
      expect(res.body.required).toEqual({ resource: 'channel_3', action: 'read' });
    });

    it('a grant on one source does not leak into another', async () => {
      await harness.grant(harness.limited.id, 'channel_0', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);

      expect((await agent.get(chanUrl(harness.sourceA, 0))).status).toBe(200);
      expect((await agent.get(chanUrl(harness.sourceB, 0))).status).toBe(403);
    });

    it('does not open the DM list, which is not a channel', async () => {
      // DMs stay on `messages` — a channel grant must not expose private
      // conversations.
      await harness.grant(harness.limited.id, 'channel_0', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);

      const res = await agent.get(`/${harness.sourceA}/meshcore/messages`);
      expect(res.status).toBe(403);
    });
  });

  describe('backwards compatibility', () => {
    it('a legacy `messages:read` grant still reads channels', async () => {
      // The check is a union on purpose. Requiring `channel_${idx}` alone would
      // revoke access from every existing install that granted only `messages`.
      await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);

      expect((await agent.get(chanUrl(harness.sourceA, 0))).status).toBe(200);
      expect((await agent.get(chanUrl(harness.sourceA, 5))).status).toBe(200);
    });

    it('channels above 7 fall back to `messages` (no channel_8 resource exists)', async () => {
      await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);

      const res = await agent.get(chanUrl(harness.sourceA, 12));
      expect(res.status).toBe(200);
    });

    it('a channel_0 grant does NOT reach channels above 7', async () => {
      await harness.grant(harness.limited.id, 'channel_0', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);

      const res = await agent.get(chanUrl(harness.sourceA, 12));
      expect(res.status).toBe(403);
    });
  });

  describe('channel-counts filters instead of refusing', () => {
    const countsUrl = (src: string, chans: string) =>
      `/${src}/meshcore/messages/channel-counts?channels=${chans}`;

    it('returns counts only for the channels the user may read', async () => {
      // A single all-or-nothing gate would 403 this whole request just because
      // channels 1 and 2 are not readable, hiding channel 0's badge too.
      await harness.grant(harness.limited.id, 'channel_0', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);

      const res = await agent.get(countsUrl(harness.sourceA, '0,1,2'));
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.counts)).toEqual(['0']);
    });

    it('returns an empty map rather than 403 when nothing is readable', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(countsUrl(harness.sourceA, '0,1,2'));
      expect(res.status).toBe(200);
      expect(res.body.counts).toEqual({});
    });

    it('admins see every requested channel', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(countsUrl(harness.sourceA, '0,1,2'));
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.counts).sort()).toEqual(['0', '1', '2']);
    });
  });

  describe('writes', () => {
    it('channel_0:write allows clearing channel 0', async () => {
      (fakeManager as unknown as { clearChannelMessages?: unknown }).clearChannelMessages =
        vi.fn().mockResolvedValue(3);
      await harness.grant(harness.limited.id, 'channel_0', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);

      const res = await agent.delete(chanUrl(harness.sourceA, 0));
      expect(res.status).not.toBe(403);
    });

    it('read alone does not permit clearing', async () => {
      await harness.grant(harness.limited.id, 'channel_0', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);

      const res = await agent.delete(chanUrl(harness.sourceA, 0));
      expect(res.status).toBe(403);
    });
  });
});
