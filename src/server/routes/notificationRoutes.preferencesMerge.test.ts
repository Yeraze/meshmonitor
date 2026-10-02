/**
 * POST /push/preferences is a partial update: it merges the posted fields onto
 * the stored per-source row. Before this, every writer posted the whole row,
 * so the Notifications tab saving its stale copy reverted a channel/DM mute set
 * from the Channels view after the tab loaded.
 *
 * Runs the real session + requireAuth + requirePermission chain and the real
 * notifications repository against the harness DB.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { pushRouter } from './notificationRoutes.js';

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn().mockReturnValue(null),
    getAllManagers: vi.fn().mockReturnValue([]),
  },
}));

vi.mock('../meshtasticManager.js', () => ({
  fallbackManager: { getLocalNodeInfo: vi.fn().mockReturnValue(null) },
}));

const MESHCORE_SOURCE = 'rt-merge-meshcore';

describe('POST /push/preferences — partial update', () => {
  let harness: RouteTestHarness;

  const rowFor = (sourceId: string) =>
    harness.db.notifications.getUserPreferences(harness.limited.id, sourceId);

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: app => app.use('/push', pushRouter) });
    await harness.db.sources.deleteSource(MESHCORE_SOURCE).catch(() => {});
    await harness.db.sources.createSource({
      id: MESHCORE_SOURCE,
      name: 'MeshCore',
      type: 'meshcore',
      config: {},
      enabled: true,
    });
    await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceB);
    await harness.grant(harness.limited.id, 'messages', 'read', MESHCORE_SOURCE);
  });

  afterEach(async () => {
    await harness.db.sources.deleteSource(MESHCORE_SOURCE).catch(() => {});
    await harness.cleanup();
  });

  it('a settings save that omits the mute lists keeps the stored mutes', async () => {
    const agent = await harness.loginAs(harness.limited);
    // A mute set from the Channels view.
    await agent.post('/push/preferences').send({
      sourceId: harness.sourceA,
      mutedChannels: [{ channelId: 2, muteUntil: null }],
      mutedDMs: [{ nodeUuid: '!aaaa', muteUntil: null }],
    }).expect(200);

    // The Notifications tab saves its own fields only.
    const res = await agent.post('/push/preferences').send({
      sourceId: harness.sourceA,
      enableWebPush: false,
      whitelist: ['urgent'],
      notifyOnLowBattery: true,
      lowBatteryThreshold: 15,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });

    const row = await rowFor(harness.sourceA);
    expect(row).toMatchObject({
      enableWebPush: false,
      whitelist: ['urgent'],
      notifyOnLowBattery: true,
      lowBatteryThreshold: 15,
      mutedChannels: [{ channelId: 2, muteUntil: null }],
      mutedDMs: [{ nodeUuid: '!aaaa', muteUntil: null }],
    });
  });

  it('a mute save that sends one list keeps the other list and every setting', async () => {
    const agent = await harness.loginAs(harness.limited);
    await agent.post('/push/preferences').send({
      sourceId: harness.sourceA,
      enableApprise: true,
      appriseUrls: ['mailto://x'],
      blacklist: ['spam'],
      mutedDMs: [{ nodeUuid: '!aaaa', muteUntil: null }],
    }).expect(200);

    await agent.post('/push/preferences').send({
      sourceId: harness.sourceA,
      mutedChannels: [{ channelId: 5, muteUntil: 123 }],
    }).expect(200);

    expect(await rowFor(harness.sourceA)).toMatchObject({
      enableApprise: true,
      appriseUrls: ['mailto://x'],
      blacklist: ['spam'],
      mutedChannels: [{ channelId: 5, muteUntil: 123 }],
      mutedDMs: [{ nodeUuid: '!aaaa', muteUntil: null }],
    });
  });

  it('a first row with no default row fills unsent fields from the GET defaults', async () => {
    const agent = await harness.loginAs(harness.limited);
    await agent.post('/push/preferences').send({
      sourceId: harness.sourceA,
      mutedChannels: [{ channelId: 1, muteUntil: null }],
    }).expect(200);

    const defaults = (await agent.get('/push/preferences')).body;
    const row = await rowFor(harness.sourceA);
    expect(row).toMatchObject({
      enableWebPush: defaults.enableWebPush,
      enableDirectMessages: defaults.enableDirectMessages,
      notifyOnMqtt: true,
      whitelist: ['Hi', 'Help'],
      blacklist: ['Test', 'Copy'],
      waypointRadiusKm: 10,
      mutedChannels: [{ channelId: 1, muteUntil: null }],
      mutedDMs: [],
    });
  });

  it('a new per-source row inherits the default (\'\') row, mutes included, for a Meshtastic source', async () => {
    const agent = await harness.loginAs(harness.limited);
    await agent.post('/push/preferences').send({
      enableWebPush: false,
      appriseUrls: ['mailto://default'],
      mutedChannels: [{ channelId: 3, muteUntil: null }],
    }).expect(200);

    await agent.post('/push/preferences').send({
      sourceId: harness.sourceB,
      notifyOnNewNode: false,
    }).expect(200);

    expect(await rowFor(harness.sourceB)).toMatchObject({
      enableWebPush: false,
      appriseUrls: ['mailto://default'],
      notifyOnNewNode: false,
      mutedChannels: [{ channelId: 3, muteUntil: null }],
    });
    // The '' row is untouched.
    expect(await rowFor('')).toMatchObject({ notifyOnNewNode: true });
  });

  it('a new MeshCore row does not inherit the default row\'s Meshtastic-keyed mutes', async () => {
    const agent = await harness.loginAs(harness.limited);
    await agent.post('/push/preferences').send({
      enableWebPush: false,
      mutedChannels: [{ channelId: 1, muteUntil: null }],
      mutedDMs: [{ nodeUuid: '!aaaa', muteUntil: null }],
    }).expect(200);

    await agent.post('/push/preferences').send({
      sourceId: MESHCORE_SOURCE,
      mutedChannels: [{ channelId: 4, muteUntil: null }],
    }).expect(200);

    expect(await rowFor(MESHCORE_SOURCE)).toMatchObject({
      enableWebPush: false,
      mutedChannels: [{ channelId: 4, muteUntil: null }],
      mutedDMs: [],
    });
  });

  it('a save on one source leaves another source\'s row alone', async () => {
    const agent = await harness.loginAs(harness.limited);
    await agent.post('/push/preferences').send({
      sourceId: harness.sourceA,
      mutedChannels: [{ channelId: 1, muteUntil: null }],
    }).expect(200);
    await agent.post('/push/preferences').send({
      sourceId: harness.sourceB,
      mutedChannels: [{ channelId: 7, muteUntil: null }],
      enableWebPush: false,
    }).expect(200);

    expect(await rowFor(harness.sourceA)).toMatchObject({
      enableWebPush: true,
      mutedChannels: [{ channelId: 1, muteUntil: null }],
    });
    expect(await rowFor(harness.sourceB)).toMatchObject({
      enableWebPush: false,
      mutedChannels: [{ channelId: 7, muteUntil: null }],
    });
  });

  it('rejects a bad value in a partial body and writes nothing', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post('/push/preferences').send({
      sourceId: harness.sourceA,
      enableWebPush: 'yes',
    });
    expect(res.status).toBe(400);
    expect(await rowFor(harness.sourceA)).toBeNull();
  });

  it('denies a save on a source the user cannot read', async () => {
    await harness.revokeAll(harness.limited.id);
    await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);

    const res = await agent.post('/push/preferences').send({
      sourceId: harness.sourceB,
      mutedChannels: [{ channelId: 1, muteUntil: null }],
    });
    expect(res.status).toBe(403);
    expect(await rowFor(harness.sourceB)).toBeNull();
  });

  it('fails the save, rather than writing defaults, when the stored row cannot be read', async () => {
    const agent = await harness.loginAs(harness.limited);
    await agent.post('/push/preferences').send({
      sourceId: harness.sourceA,
      appriseUrls: ['mailto://keep'],
    }).expect(200);

    const repo = harness.db.notifications;
    const spy = vi.spyOn(repo, 'getUserPreferences').mockRejectedValueOnce(new Error('db down'));
    try {
      const res = await agent.post('/push/preferences').send({
        sourceId: harness.sourceA,
        mutedChannels: [{ channelId: 1, muteUntil: null }],
      });
      expect(res.status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect(await rowFor(harness.sourceA)).toMatchObject({
      appriseUrls: ['mailto://keep'],
      mutedChannels: [],
    });
  });
});
