/**
 * A source the user never configured answers with the built-in defaults, never
 * another source's row.
 *
 * Before this, `GET /push/preferences?sourceId=B` for a user whose only row was
 * on source A returned A's row: the server fell back to
 * `getUserPreferences(userId, '')`, and with an empty source id the repository
 * dropped the source filter and returned the user's first row of any source.
 * The settings page for B then showed A's channel ticks, keywords and toggles,
 * and the first save on B copied them into B's new row.
 *
 * Real session + requireAuth + requirePermission, real resolver, real
 * notifications repository against the harness DB.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { pushRouter } from './notificationRoutes.js';
import { defaultNotificationPreferences } from '../../utils/notificationDefaults.js';

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn().mockReturnValue(null),
    getAllManagers: vi.fn().mockReturnValue([]),
  },
}));

vi.mock('../meshtasticManager.js', () => ({
  fallbackManager: { getLocalNodeInfo: vi.fn().mockReturnValue(null) },
}));

const MESHCORE_SOURCE = 'rt-nocross-meshcore';

/** Every field set away from its default, so a borrowed value shows anywhere. */
const ROW_A = {
  enableWebPush: false,
  enableApprise: true,
  enabledChannels: [0, 3],
  enableDirectMessages: false,
  notifyOnEmoji: false,
  notifyOnMqtt: false,
  notifyOnNewNode: true,
  notifyOnTraceroute: true,
  notifyOnInactiveNode: true,
  notifyOnLowBattery: true,
  lowBatteryThreshold: 7,
  lowBatteryVoltageThreshold: 3111,
  notifyOnServerEvents: true,
  notifyOnWaypoint: true,
  waypointRadiusKm: 42,
  waypointCenterLat: 12.5,
  waypointCenterLon: -45.25,
  prefixWithNodeName: true,
  monitoredNodes: ['!aaaa0001'],
  whitelist: ['alpha'],
  blacklist: ['spam-a'],
  appriseUrls: ['mailto://a@example.com'],
  mutedChannels: [{ channelId: 3, muteUntil: null }],
  mutedDMs: [{ nodeUuid: '!aaaa0002', muteUntil: null }],
  messageTitleTemplate: 'A {{ senderName }}',
  messageBodyTemplate: 'A {{ text }}',
};

const DEFAULTS = defaultNotificationPreferences();

describe('notification preferences never cross sources', () => {
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

  it('the fixture row differs from the defaults in every field', () => {
    const same = (Object.keys(DEFAULTS) as Array<keyof typeof DEFAULTS>)
      .filter(k => JSON.stringify(DEFAULTS[k]) === JSON.stringify((ROW_A as Record<string, unknown>)[k]));
    expect(same).toEqual([]);
    expect(Object.keys(ROW_A).sort()).toEqual(Object.keys(DEFAULTS).sort());
  });

  describe('GET /push/preferences', () => {
    it('a never-configured source returns the defaults, not the configured source\'s values', async () => {
      const agent = await harness.loginAs(harness.limited);
      await agent.post('/push/preferences').send({ sourceId: harness.sourceA, ...ROW_A }).expect(200);

      const res = await agent.get(`/push/preferences?sourceId=${harness.sourceB}`).expect(200);

      expect(res.body).toEqual({ ...DEFAULTS, usingDefaults: true, sourceFallback: false });
      // Field by field, so a failure names the field that crossed.
      for (const field of Object.keys(ROW_A) as Array<keyof typeof ROW_A>) {
        expect(res.body[field], field).not.toEqual(ROW_A[field]);
      }
      // Reading B created nothing.
      expect(await rowFor(harness.sourceB)).toBeNull();
    });

    it('the configured source still returns its own row', async () => {
      const agent = await harness.loginAs(harness.limited);
      await agent.post('/push/preferences').send({ sourceId: harness.sourceA, ...ROW_A }).expect(200);

      const res = await agent.get(`/push/preferences?sourceId=${harness.sourceA}`).expect(200);
      expect(res.body).toEqual({ ...ROW_A, usingDefaults: false, sourceFallback: false });
    });

    it('a read with no sourceId returns the defaults, not a source\'s row', async () => {
      const agent = await harness.loginAs(harness.limited);
      await agent.post('/push/preferences').send({ sourceId: harness.sourceA, ...ROW_A }).expect(200);

      const res = await agent.get('/push/preferences').expect(200);
      expect(res.body).toEqual({ ...DEFAULTS, usingDefaults: true, sourceFallback: false });
    });

    it('a brand-new user gets the same defaults on every source', async () => {
      const agent = await harness.loginAs(harness.limited);
      for (const sourceId of [harness.sourceA, harness.sourceB, MESHCORE_SOURCE]) {
        const res = await agent.get(`/push/preferences?sourceId=${sourceId}`).expect(200);
        expect(res.body, sourceId).toEqual({ ...DEFAULTS, usingDefaults: true, sourceFallback: false });
      }
    });

    it('one user\'s row is never another user\'s answer', async () => {
      const limited = await harness.loginAs(harness.limited);
      await limited.post('/push/preferences').send({ sourceId: harness.sourceA, ...ROW_A }).expect(200);

      const admin = await harness.loginAs(harness.admin);
      const res = await admin.get(`/push/preferences?sourceId=${harness.sourceA}`).expect(200);
      expect(res.body).toEqual({ ...DEFAULTS, usingDefaults: true, sourceFallback: false });
    });
  });

  describe('the legacy unsourced (\'\') row', () => {
    // A row saved with no source id. It is not a source's row. Only its
    // ACTIVE mutes carry to a Meshtastic source with no row (#5487).
    const LEGACY = {
      ...ROW_A,
      mutedChannels: [{ channelId: 2, muteUntil: null }, { channelId: 6, muteUntil: 1000 }],
      mutedDMs: [{ nodeUuid: '!legacy01', muteUntil: null }],
    };

    it('lends a Meshtastic source its active mutes and nothing else', async () => {
      const agent = await harness.loginAs(harness.limited);
      await agent.post('/push/preferences').send(LEGACY).expect(200);

      const res = await agent.get(`/push/preferences?sourceId=${harness.sourceB}`).expect(200);
      expect(res.body).toEqual({
        ...DEFAULTS,
        mutedChannels: [{ channelId: 2, muteUntil: null }], // the expired rule is dropped
        mutedDMs: [{ nodeUuid: '!legacy01', muteUntil: null }],
        usingDefaults: true,
        sourceFallback: true,
      });
    });

    it('lends a MeshCore source nothing', async () => {
      const agent = await harness.loginAs(harness.limited);
      await agent.post('/push/preferences').send(LEGACY).expect(200);

      const res = await agent.get(`/push/preferences?sourceId=${MESHCORE_SOURCE}`).expect(200);
      expect(res.body).toEqual({ ...DEFAULTS, usingDefaults: true, sourceFallback: false });
    });

    it('is still what a read with no sourceId returns', async () => {
      const agent = await harness.loginAs(harness.limited);
      await agent.post('/push/preferences').send(LEGACY).expect(200);

      const res = await agent.get('/push/preferences').expect(200);
      expect(res.body).toEqual({ ...LEGACY, usingDefaults: false, sourceFallback: false });
    });

    it('does not override a source that has its own row', async () => {
      const agent = await harness.loginAs(harness.limited);
      await agent.post('/push/preferences').send(LEGACY).expect(200);
      await agent.post('/push/preferences').send({ sourceId: harness.sourceB, mutedChannels: [] }).expect(200);

      const res = await agent.get(`/push/preferences?sourceId=${harness.sourceB}`).expect(200);
      expect(res.body.mutedChannels).toEqual([]);
      expect(res.body.usingDefaults).toBe(false);
      expect(res.body.sourceFallback).toBe(false);
    });
  });

  describe('POST /push/preferences', () => {
    it('the first save on a never-configured source creates its row from the defaults', async () => {
      const agent = await harness.loginAs(harness.limited);
      await agent.post('/push/preferences').send({ sourceId: harness.sourceA, ...ROW_A }).expect(200);
      expect(await rowFor(harness.sourceB)).toBeNull();

      // The tab sends only what it edits; here, two fields.
      await agent.post('/push/preferences').send({
        sourceId: harness.sourceB,
        enabledChannels: [5],
        notifyOnNewNode: true,
      }).expect(200);

      // B's new row: the two posted fields, the defaults for the rest. Nothing of A's.
      expect(await rowFor(harness.sourceB)).toEqual({ ...DEFAULTS, enabledChannels: [5], notifyOnNewNode: true });
      // A is untouched.
      expect(await rowFor(harness.sourceA)).toEqual(ROW_A);

      const res = await agent.get(`/push/preferences?sourceId=${harness.sourceB}`).expect(200);
      expect(res.body).toEqual({
        ...DEFAULTS,
        enabledChannels: [5],
        notifyOnNewNode: true,
        usingDefaults: false,
        sourceFallback: false,
      });
    });

    it('a save with no sourceId creates the \'\' row from the defaults, not from a source\'s row', async () => {
      const agent = await harness.loginAs(harness.limited);
      await agent.post('/push/preferences').send({ sourceId: harness.sourceA, ...ROW_A }).expect(200);

      await agent.post('/push/preferences').send({ mutedChannels: [{ channelId: 9, muteUntil: null }] }).expect(200);

      expect(await rowFor('')).toEqual({ ...DEFAULTS, mutedChannels: [{ channelId: 9, muteUntil: null }] });
      expect(await rowFor(harness.sourceA)).toEqual(ROW_A);
    });

    it('turning a service off on one source leaves it as it was on the others', async () => {
      const agent = await harness.loginAs(harness.limited);
      await agent.post('/push/preferences').send({
        sourceId: harness.sourceA,
        enableWebPush: true,
        enableApprise: true,
        appriseUrls: ['mailto://a@example.com'],
      }).expect(200);

      await agent.post('/push/preferences').send({
        sourceId: harness.sourceB,
        enableWebPush: false,
      }).expect(200);

      expect(await rowFor(harness.sourceA)).toMatchObject({
        enableWebPush: true,
        enableApprise: true,
        appriseUrls: ['mailto://a@example.com'],
      });
      // B: web push off as posted; Apprise is the default (off, no URLs), not A's.
      expect(await rowFor(harness.sourceB)).toMatchObject({
        enableWebPush: false,
        enableApprise: false,
        appriseUrls: [],
      });
      // A third source, never saved, still reads the defaults.
      const res = await agent.get(`/push/preferences?sourceId=${MESHCORE_SOURCE}`).expect(200);
      expect(res.body).toMatchObject({ enableWebPush: true, enableApprise: false, appriseUrls: [], usingDefaults: true });
    });
  });
});
