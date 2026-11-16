/**
 * Cross-source notification dedup, end to end (#5729).
 *
 * Runs the REAL notifier, dispatcher, delivery wrappers, filter and dedup
 * store. Only the edges are stubbed: the database, the `web-push` client,
 * `fetch` (the Apprise HTTP call) and the OS notifier. Nothing leaves the
 * process, and what each channel would have sent is read back from the stubs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fixturePrefs,
  subscriptionFor,
  type FixturePrefs,
  type FixtureState,
} from '../test-helpers/messageNotificationFixture.js';

const SOURCES: Record<string, { id: string; name: string; type: string }> = {
  'src-a': { id: 'src-a', name: 'Hilltop', type: 'meshtastic_tcp' },
  'src-b': { id: 'src-b', name: 'Valley', type: 'meshtastic_tcp' },
  'src-mqtt': { id: 'src-mqtt', name: 'Broker', type: 'mqtt_bridge' },
};

const h = vi.hoisted(() => {
  process.env.ENABLE_DESKTOP_NOTIFICATIONS = 'true';
  return {
    state: null as unknown as FixtureState,
    notify: vi.fn(),
    webPushSend: vi.fn(async (..._args: unknown[]) => ({})),
  };
});

vi.mock('../../services/database.js', async () => {
  const { buildDatabaseMock, emptyState } = await import('../test-helpers/messageNotificationFixture.js');
  h.state = emptyState();
  const base = buildDatabaseMock(h.state);
  return {
    default: {
      ...base,
      nodes: { getNode: async () => ({ nodeNum: 305419896, nodeId: '!12345678', longName: 'Alice Mobile', shortName: 'ALC' }) },
      nodesRepo: { getNode: async () => null },
      sources: { getSource: async (id: string) => SOURCES[id] ?? null },
      channels: { getChannelById: async () => ({ id: 0, name: 'LongFast' }) },
      channelDatabase: { getByIdAsync: async () => null },
    },
  };
});
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../meshtasticManager.js', () => ({
  fallbackManager: { getLocalNodeInfo: vi.fn(() => ({ longName: 'LocalNode' })), sourceId: 'src-a' },
}));
vi.mock('../sourceManagerRegistry.js', () => ({ sourceManagerRegistry: {} }));
vi.mock('../sourceManagerTypes.js', () => ({ getPrimaryMeshtasticManager: () => undefined }));
vi.mock('../utils/ownNodes.js', () => ({ isOwnNodeNum: () => false, getOwnNodeNums: () => [] }));
vi.mock('node-notifier', () => ({ default: { notify: h.notify } }));
vi.mock('web-push', () => ({
  sendNotification: h.webPushSend,
  generateVAPIDKeys: () => ({ publicKey: 'pub', privateKey: 'priv' }),
  setVapidDetails: () => undefined,
}));

import { pushNotificationService } from './pushNotificationService.js';
import { appriseNotificationService } from './appriseNotificationService.js';
import { notificationService } from './notificationService.js';
import { serverEventNotificationService } from './serverEventNotificationService.js';
import { sendMessagePushNotification } from './messagePushNotifier.js';
import { notificationDedup, notificationHold, NOTIFICATION_DEDUP_WINDOW_MS, dedupTag, packetDedupKey } from './notificationDedup.js';

const FROM = 305419896;
const TEXT = 'meet at the trailhead';
const T0 = new Date('2026-10-10T12:00:00Z').getTime();

interface WirePush {
  endpoint: string;
  title: string;
  body: string;
  tag?: string;
  renotify?: boolean;
  silent?: boolean;
  dedup?: unknown;
  message?: unknown;
  data?: { sourceId?: string };
}
interface AppriseCall { urls: string[]; title: string; body: string }

let fetchMock: ReturnType<typeof vi.fn>;

function pushes(): WirePush[] {
  return h.webPushSend.mock.calls.map((c) => ({
    endpoint: (c[0] as { endpoint: string }).endpoint,
    ...(JSON.parse(c[1] as string) as Omit<WirePush, 'endpoint'>),
  }));
}
function pushesTo(userId: number | 'anon'): WirePush[] {
  return pushes().filter((p) => p.endpoint.endsWith(`/${userId}`));
}
function appriseCalls(): AppriseCall[] {
  return fetchMock.mock.calls.map((c) => JSON.parse((c[1] as { body: string }).body) as AppriseCall);
}
function appriseTo(userId: number): AppriseCall[] {
  return appriseCalls().filter((c) => c.urls[0] === `json://example.invalid/u${userId}`);
}
function desktops(): Array<{ title: string; message: string }> {
  return h.notify.mock.calls.map((c) => c[0] as { title: string; message: string });
}
/**
 * Apprise and the desktop app hold each deduped event for 5 s, then send ONE
 * message listing every source that heard it (#5729). Sending the holds now
 * stands in for those 5 s passing, without moving the clock the 60 s window
 * tests read.
 */
async function flushHolds(): Promise<void> {
  await notificationHold.flushAll();
}

/** Every string any channel sent, for "this name must appear nowhere" checks. */
function everythingSentTo(userId: number): string {
  return JSON.stringify([pushesTo(userId), appriseTo(userId)]);
}

/**
 * A user with a saved row on each listed source, and ONE browser subscription
 * for the whole mesh whose Web Push source list is those sources (#5729: what
 * migration 235 leaves for a browser that was subscribed on each of them).
 */
function addUser(userId: number, sources: Record<string, Partial<FixturePrefs>>) {
  h.state.users.push({ id: userId, isActive: true });
  h.state.appriseUsers.push(userId);
  for (const [sourceId, prefs] of Object.entries(sources)) {
    h.state.prefs.set(`${userId}|${sourceId}`, fixturePrefs({ appriseUrls: [`json://example.invalid/u${userId}`], ...prefs }));
  }
  h.state.subscriptions.push(subscriptionFor(userId, '__mesh__'));
  h.state.mesh?.set(userId, { saved: false, pushSourceIds: Object.keys(sources) });
}

/** One source hearing a text packet, through the real notifier. */
async function hear(sourceId: string, over: { packetId?: number; portnum?: number; viaMqtt?: boolean; from?: number } = {}) {
  const from = over.from ?? FROM;
  const packetId = over.packetId ?? 42;
  await sendMessagePushNotification({
    message: {
      id: `${sourceId}_${from}_${packetId}`,
      fromNodeNum: from,
      fromNodeId: '!12345678',
      channel: 0,
      portnum: over.portnum ?? 1,
      viaMqtt: over.viaMqtt ?? false,
    },
    messageText: TEXT,
    isDirectMessage: false,
    sourceId,
    localNodeNum: null,
  });
}

describe('cross-source notification dedup (#5729)', () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    await pushNotificationService.waitForInit();
    await appriseNotificationService.waitForInit();
    (pushNotificationService as unknown as { isConfigured: boolean }).isConfigured = true;

    notificationDedup.clear();
    notificationHold.clear();
    h.state.prefs.clear();
    h.state.deniedUsers.clear();
    h.state.deniedPairs = new Set();
    h.state.subscriptions = [];
    h.state.mesh = new Map();
    h.state.appriseUsers = [];
    h.state.users = [];
    h.notify.mockClear();
    h.webPushSend.mockClear();
    h.webPushSend.mockImplementation(async () => ({}));
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe('two sources hear one packet', () => {
    it('user allowed on both: one notification on every channel, and Web Push names both sources', async () => {
      addUser(1, { 'src-a': {}, 'src-b': {} });

      await hear('src-a');
      await hear('src-b');

      // Web Push: the first copy alerts; the second replaces it, silently.
      const push = pushesTo(1);
      expect(push).toHaveLength(2);
      expect(push[0].title).toBe('LongFast · Hilltop');
      expect(push[0].silent).toBeUndefined();
      expect(push[1].title).toBe('LongFast · Hilltop, Valley');
      expect(push[1].silent).toBe(true);
      expect(push[1].body).toBe(push[0].body);
      // Same tag + renotify:false is what makes the second one an update.
      const tag = dedupTag(packetDedupKey(FROM, 42, 1) as string);
      expect(push.map((p) => p.tag)).toEqual([tag, tag]);
      expect(push.map((p) => p.renotify)).toEqual([false, false]);

      // Apprise and desktop cannot update: they hold the event for 5 s, then
      // send ONE message that lists both sources (#5729).
      expect(appriseTo(1)).toHaveLength(0);
      expect(desktops()).toHaveLength(0);
      await flushHolds();
      expect(appriseTo(1)).toHaveLength(1);
      expect(appriseTo(1)[0].title).toBe('LongFast · Hilltop, Valley');
      expect(desktops()).toHaveLength(1);
      expect(desktops()[0].title).toBe('LongFast · Hilltop, Valley');
    });

    it('the three channels agree: each alerts the user exactly once', async () => {
      addUser(1, { 'src-a': {}, 'src-b': {} });
      await hear('src-a');
      await hear('src-b');
      await hear('src-a'); // the same source again
      await hear('src-b');
      await flushHolds();

      const alerting = pushesTo(1).filter((p) => p.silent !== true);
      expect(alerting).toHaveLength(1);
      expect(pushesTo(1)).toHaveLength(2); // + one silent update, no more
      expect(appriseTo(1)).toHaveLength(1);
      expect(desktops()).toHaveLength(1);
    });

    it('Web Push goes out at once; Apprise and desktop wait for the hold', async () => {
      addUser(1, { 'src-a': {}, 'src-b': {} });
      await hear('src-a');
      expect(pushesTo(1)).toHaveLength(1);
      expect(appriseTo(1)).toHaveLength(0);
      expect(desktops()).toHaveLength(0);
      await flushHolds();
      expect(appriseTo(1).map((c) => c.title)).toEqual(['LongFast · Hilltop']);
      expect(desktops()).toHaveLength(1);
    });

    it('server-only fields never reach the browser', async () => {
      addUser(1, { 'src-a': {}, 'src-b': {} });
      await hear('src-a');
      await hear('src-b');
      for (const p of pushesTo(1)) {
        expect(p.dedup).toBeUndefined();
        expect(p.message).toBeUndefined();
      }
    });

    it('three sources: the update lists them in the order they heard it', async () => {
      addUser(1, { 'src-a': {}, 'src-b': {}, 'src-mqtt': {} });
      await hear('src-b');
      await hear('src-mqtt', { viaMqtt: true });
      await hear('src-a');
      expect(pushesTo(1).map((p) => p.title)).toEqual([
        'LongFast · Valley',
        'LongFast · Valley, Broker',
        'LongFast · Valley, Broker, Hilltop',
      ]);
      await flushHolds();
      expect(appriseTo(1).map((c) => c.title)).toEqual(['LongFast · Valley, Broker, Hilltop']);
    });

    it('the update keeps the first source\'s template', async () => {
      addUser(1, {
        'src-a': { messageTitleTemplate: 'A-style {{ sourceName }}' },
        'src-b': { messageTitleTemplate: 'B-style {{ sourceName }}' },
      });
      await hear('src-a');
      await hear('src-b');
      expect(pushesTo(1).map((p) => p.title)).toEqual(['A-style Hilltop', 'A-style Hilltop, Valley']);
    });
  });

  describe('a user who can read only one source (the two-source rule)', () => {
    it('gets one notification naming only that source', async () => {
      addUser(1, { 'src-a': {}, 'src-b': {} });
      h.state.deniedPairs?.add('1|src-b');

      await hear('src-a');
      await hear('src-b');

      expect(pushesTo(1)).toHaveLength(1);
      expect(pushesTo(1)[0].title).toBe('LongFast · Hilltop');
      await flushHolds();
      expect(appriseTo(1).map((c) => c.title)).toEqual(['LongFast · Hilltop']);
      expect(everythingSentTo(1)).not.toContain('Valley');
      expect(everythingSentTo(1)).not.toContain('src-b');
    });

    it('still gets it when the source they cannot read hears the packet first', async () => {
      addUser(1, { 'src-a': {}, 'src-b': {} });
      h.state.deniedPairs?.add('1|src-a');

      await hear('src-a');
      expect(pushesTo(1)).toHaveLength(0);
      expect(appriseTo(1)).toHaveLength(0);

      await hear('src-b');
      expect(pushesTo(1)).toHaveLength(1);
      expect(pushesTo(1)[0].title).toBe('LongFast · Valley');
      expect(pushesTo(1)[0].silent).toBeUndefined();
      await flushHolds();
      expect(appriseTo(1).map((c) => c.title)).toEqual(['LongFast · Valley']);
      expect(everythingSentTo(1)).not.toContain('Hilltop');
    });

    it('never learns a source from another user\'s copy', async () => {
      addUser(1, { 'src-a': {}, 'src-b': {} }); // reads both
      addUser(2, { 'src-b': {} }); // reads only Valley
      h.state.deniedPairs?.add('2|src-a');

      await hear('src-a');
      await hear('src-b');

      expect(pushesTo(1).map((p) => p.title)).toEqual(['LongFast · Hilltop', 'LongFast · Hilltop, Valley']);
      expect(pushesTo(2).map((p) => p.title)).toEqual(['LongFast · Valley']);
      await flushHolds();
      expect(appriseTo(1).map((c) => c.title)).toEqual(['LongFast · Hilltop, Valley']);
      expect(appriseTo(2).map((c) => c.title)).toEqual(['LongFast · Valley']);
      expect(everythingSentTo(2)).not.toContain('Hilltop');
      expect(everythingSentTo(2)).not.toContain('src-a');
    });
  });

  describe('desktop: one machine, the hold belongs to the first user', () => {
    it('never lists a source the hold\'s user cannot read', async () => {
      addUser(1, { 'src-a': {}, 'src-b': {} });
      addUser(2, { 'src-a': {}, 'src-b': {} });
      h.state.deniedPairs?.add('1|src-b'); // user 1 (first) reads only Hilltop

      await hear('src-a');
      await hear('src-b');
      await flushHolds();

      expect(desktops().map((d) => d.title)).toEqual(['LongFast · Hilltop']);
    });
  });

  describe('each source\'s own filter still decides', () => {
    it('channel off on one source: only the other source counts and is named', async () => {
      addUser(1, { 'src-a': { enabledChannels: [] }, 'src-b': {} });

      await hear('src-a');
      expect(pushesTo(1)).toHaveLength(0);
      expect(appriseTo(1)).toHaveLength(0);
      expect(desktops()).toHaveLength(0);

      await hear('src-b');
      expect(pushesTo(1).map((p) => p.title)).toEqual(['LongFast · Valley']);
      await flushHolds();
      expect(appriseTo(1).map((c) => c.title)).toEqual(['LongFast · Valley']);
      expect(desktops().map((d) => d.title)).toEqual(['LongFast · Valley']);
    });

    it('filtered on both sources: nothing is sent', async () => {
      addUser(1, { 'src-a': { blacklist: ['trailhead'] }, 'src-b': { mutedChannels: [{ channelId: 0, muteUntil: null }] } });
      await hear('src-a');
      await hear('src-b');
      await flushHolds();
      expect(pushesTo(1)).toHaveLength(0);
      expect(appriseTo(1)).toHaveLength(0);
      expect(desktops()).toHaveLength(0);
    });

    it('a channel switch is per source: Web Push off on A does not stop Apprise on A', async () => {
      addUser(1, { 'src-a': { enableWebPush: false }, 'src-b': {} });
      await hear('src-a');
      await hear('src-b');
      // Push: A's copy never counted, so B's is the first and names only B.
      expect(pushesTo(1).map((p) => p.title)).toEqual(['LongFast · Valley']);
      // Apprise: both copies passed, so its one message lists both.
      await flushHolds();
      expect(appriseTo(1).map((c) => c.title)).toEqual(['LongFast · Hilltop, Valley']);
    });

    it('a source outside the user\'s Web Push source list is not pushed', async () => {
      addUser(1, { 'src-a': {}, 'src-b': {} });
      h.state.mesh = new Map([[1, { saved: false, pushSourceIds: ['src-a'] }]]);
      await hear('src-a');
      await hear('src-b');
      expect(pushesTo(1).map((p) => p.title)).toEqual(['LongFast · Hilltop']);
    });
  });

  describe('what counts as the same event', () => {
    it('a different packet id is a separate notification', async () => {
      addUser(1, { 'src-a': {}, 'src-b': {} });
      await hear('src-a', { packetId: 42 });
      await hear('src-b', { packetId: 43 });
      expect(pushesTo(1).map((p) => p.silent)).toEqual([undefined, undefined]);
      expect(new Set(pushesTo(1).map((p) => p.tag)).size).toBe(2);
      await flushHolds();
      expect(appriseTo(1)).toHaveLength(2);
      expect(desktops()).toHaveLength(2);
    });

    it('a different portnum is a separate notification', async () => {
      addUser(1, { 'src-a': {}, 'src-b': {} });
      await hear('src-a', { portnum: 1 }); // TEXT_MESSAGE_APP
      await hear('src-b', { portnum: 72 }); // ATAK_PLUGIN
      expect(pushesTo(1).filter((p) => p.silent !== true)).toHaveLength(2);
      await flushHolds();
      expect(appriseTo(1)).toHaveLength(2);
      expect(desktops()).toHaveLength(2);
    });

    it('a different sender is a separate notification', async () => {
      addUser(1, { 'src-a': {}, 'src-b': {} });
      await hear('src-a', { from: 1000 });
      await hear('src-b', { from: 1001 });
      await flushHolds();
      expect(appriseTo(1)).toHaveLength(2);
    });

    it('a copy after the window is a separate notification', async () => {
      addUser(1, { 'src-a': {}, 'src-b': {} });
      await hear('src-a');
      await flushHolds(); // its 5 s hold ended long before the window did
      vi.setSystemTime(T0 + NOTIFICATION_DEDUP_WINDOW_MS + 1);
      await hear('src-b');
      await flushHolds();

      expect(pushesTo(1).map((p) => p.title)).toEqual(['LongFast · Hilltop', 'LongFast · Valley']);
      expect(pushesTo(1).map((p) => p.silent)).toEqual([undefined, undefined]);
      expect(appriseTo(1)).toHaveLength(2);
      expect(desktops()).toHaveLength(2);
    });

    it('a copy just inside the window is collapsed', async () => {
      addUser(1, { 'src-a': {}, 'src-b': {} });
      await hear('src-a');
      await flushHolds(); // sent after its 5 s hold
      vi.setSystemTime(T0 + NOTIFICATION_DEDUP_WINDOW_MS - 1);
      await hear('src-b');
      await flushHolds();
      // Too late to join the sent message, still inside the window: dropped.
      expect(appriseTo(1).map((c) => c.title)).toEqual(['LongFast · Hilltop']);
      expect(desktops()).toHaveLength(1);
    });

    it('a row with no packet id is never deduped', async () => {
      addUser(1, { 'src-a': {}, 'src-b': {} });
      // The ingest paths fall back to Date.now() when a packet has no id.
      await sendMessagePushNotification({
        message: { id: `src-a_${FROM}_${T0}`, fromNodeNum: FROM, channel: 0, portnum: 1 },
        messageText: TEXT, isDirectMessage: false, sourceId: 'src-a', localNodeNum: null,
      });
      await sendMessagePushNotification({
        message: { id: `src-b_${FROM}_${T0}`, fromNodeNum: FROM, channel: 0, portnum: 1 },
        messageText: TEXT, isDirectMessage: false, sourceId: 'src-b', localNodeNum: null,
      });
      await flushHolds();
      expect(appriseTo(1)).toHaveLength(2);
      expect(pushesTo(1).every((p) => p.tag === undefined)).toBe(true);
    });
  });

  describe('MQTT echo', () => {
    it('an MQTT copy of a packet a radio source already delivered is collapsed', async () => {
      addUser(1, { 'src-a': {}, 'src-mqtt': {} });
      await hear('src-a');
      await hear('src-mqtt', { viaMqtt: true });

      expect(pushesTo(1).filter((p) => p.silent !== true)).toHaveLength(1);
      await flushHolds();
      expect(appriseTo(1)).toHaveLength(1);
      expect(appriseTo(1)[0].title).toBe('LongFast · Hilltop, Broker');
      expect(desktops()).toHaveLength(1);
    });

    it('the MQTT copy arriving first collapses the radio copy too', async () => {
      addUser(1, { 'src-a': {}, 'src-mqtt': {} });
      await hear('src-mqtt', { viaMqtt: true });
      await hear('src-a');
      await flushHolds();
      expect(appriseTo(1)).toHaveLength(1);
      expect(appriseTo(1)[0].title).toBe('LongFast · Broker, Hilltop');
      expect(desktops()).toHaveLength(1);
    });

    it('with MQTT alerts off, a filtered MQTT copy does not use up the radio copy', async () => {
      addUser(1, { 'src-a': {}, 'src-mqtt': { notifyOnMqtt: false } });
      await hear('src-mqtt', { viaMqtt: true });
      expect(appriseTo(1)).toHaveLength(0);
      await hear('src-a');
      await flushHolds();
      expect(appriseTo(1).map((c) => c.title)).toEqual(['LongFast · Hilltop']);
      expect(pushesTo(1).map((p) => p.title)).toEqual(['LongFast · Hilltop']);
    });

    it('one source hearing its own packet back is collapsed', async () => {
      addUser(1, { 'src-a': {} });
      await hear('src-a');
      await hear('src-a', { viaMqtt: true });
      await flushHolds();
      expect(pushesTo(1)).toHaveLength(1);
      expect(appriseTo(1)).toHaveLength(1);
      expect(desktops()).toHaveLength(1);
    });
  });

  describe('a failed first delivery', () => {
    it('Web Push: lets the next source\'s copy through as a normal alert', async () => {
      addUser(1, { 'src-a': {}, 'src-b': {} });
      h.webPushSend.mockRejectedValueOnce(Object.assign(new Error('push service down'), { statusCode: 503 }));
      await hear('src-a');
      await hear('src-b');
      const delivered = pushesTo(1).slice(1);
      expect(delivered).toHaveLength(1);
      expect(delivered[0].title).toBe('LongFast · Valley');
      expect(delivered[0].silent).toBeUndefined();
    });

    it('desktop: lets the next source\'s copy through', async () => {
      addUser(1, { 'src-a': {}, 'src-b': {} });
      h.notify.mockImplementationOnce(() => { throw new Error('no notifier'); });
      await hear('src-a');
      await flushHolds(); // the held message fails
      await hear('src-b');
      await flushHolds();
      expect(desktops().map((d) => d.title)).toEqual(['LongFast · Hilltop', 'LongFast · Valley']);
    });

    it('Apprise: lets the next source\'s copy through', async () => {
      addUser(1, { 'src-a': {}, 'src-b': {} });
      fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: 'down' }), text: async () => 'down' });
      await hear('src-a');
      await flushHolds(); // the held message fails
      await hear('src-b');
      await flushHolds();
      expect(appriseTo(1).map((c) => c.title)).toEqual(['LongFast · Hilltop', 'LongFast · Valley']);
    });
  });

  describe('source-health notifications are about the source: never deduped', () => {
    it('a server-event alert goes out once per source', async () => {
      addUser(1, { 'src-a': { notifyOnServerEvents: true }, 'src-b': { notifyOnServerEvents: true } });

      await serverEventNotificationService.notifyServerStart({ version: '9.9.9', features: [] }, 'src-a', 'Hilltop');
      await serverEventNotificationService.notifyServerStart({ version: '9.9.9', features: [] }, 'src-b', 'Valley');

      expect(pushesTo(1).map((p) => p.title)).toEqual([
        'MeshMonitor Started (v9.9.9) · Hilltop',
        'MeshMonitor Started (v9.9.9) · Valley',
      ]);
      expect(pushesTo(1).every((p) => p.tag === undefined && p.silent === undefined)).toBe(true);
      expect(appriseTo(1)).toHaveLength(2);
      expect(desktops()).toHaveLength(2);
      expect(notificationDedup.size).toBe(0);
    });

    it('identical alerts with no dedup key are all sent', async () => {
      addUser(1, { 'src-a': { notifyOnServerEvents: true } });
      const payload = { title: 'Node disconnected', body: 'link down', sourceId: 'src-a', sourceName: 'Hilltop' };
      await notificationService.broadcastToPreferenceUsers('notifyOnServerEvents', payload);
      await notificationService.broadcastToPreferenceUsers('notifyOnServerEvents', payload);
      expect(pushesTo(1)).toHaveLength(2);
      expect(appriseTo(1)).toHaveLength(2);
    });
  });

  describe('other mesh events with a natural key', () => {
    it('MeshCore new device heard by two sources: one alert, Web Push names both', async () => {
      addUser(1, { 'src-a': { notifyOnNewNode: true }, 'src-b': { notifyOnNewNode: true } });
      const key = 'ab'.repeat(32);

      await notificationService.notifyNewMeshCoreNode(key, 'Ridge Repeater', 'Repeater', 'src-a', 'Hilltop');
      await notificationService.notifyNewMeshCoreNode(key, 'Ridge Repeater', 'Repeater', 'src-b', 'Valley');

      expect(pushesTo(1).map((p) => p.body)).toEqual([
        'Ridge Repeater detected by Hilltop - Repeater',
        'Ridge Repeater detected by Hilltop, Valley - Repeater',
      ]);
      expect(pushesTo(1).map((p) => p.silent)).toEqual([undefined, true]);
      await flushHolds();
      expect(appriseTo(1).map((c) => c.body)).toEqual(['Ridge Repeater detected by Hilltop, Valley - Repeater']);
      expect(desktops().map((d) => d.message)).toEqual(['Ridge Repeater detected by Hilltop, Valley - Repeater']);
    });

    it('MeshCore new device: a user with the alert on for one source is told about that source only', async () => {
      addUser(1, { 'src-a': { notifyOnNewNode: false }, 'src-b': { notifyOnNewNode: true } });
      const key = 'cd'.repeat(32);
      await notificationService.notifyNewMeshCoreNode(key, 'Ridge Repeater', undefined, 'src-a', 'Hilltop');
      await notificationService.notifyNewMeshCoreNode(key, 'Ridge Repeater', undefined, 'src-b', 'Valley');
      expect(pushesTo(1).map((p) => p.body)).toEqual(['Ridge Repeater detected by Valley']);
      expect(everythingSentTo(1)).not.toContain('Hilltop');
    });

    it('two different MeshCore devices are two alerts', async () => {
      addUser(1, { 'src-a': { notifyOnNewNode: true } });
      await notificationService.notifyNewMeshCoreNode('11'.repeat(32), 'One', undefined, 'src-a', 'Hilltop');
      await notificationService.notifyNewMeshCoreNode('22'.repeat(32), 'Two', undefined, 'src-a', 'Hilltop');
      await flushHolds();
      expect(appriseTo(1)).toHaveLength(2);
    });

    it('a targeted alert (waypoint) heard by two sources: one alert per user', async () => {
      addUser(1, { 'src-a': { notifyOnWaypoint: true }, 'src-b': { notifyOnWaypoint: true } });
      const waypoint = (sourceId: string, sourceName: string) => ({
        title: 'Camp',
        body: `[${sourceName}] water here`,
        sourceId,
        sourceName,
        dedup: {
          key: 'waypoint:777',
          merged: (names: string[]) => ({ title: 'Camp', body: `[${names.join(', ')}] water here` }),
        },
      });

      await notificationService.broadcastToPreferenceUsers('notifyOnWaypoint', waypoint('src-a', 'Hilltop'), 1);
      await notificationService.broadcastToPreferenceUsers('notifyOnWaypoint', waypoint('src-b', 'Valley'), 1);

      // The targeted path reaches every subscription row of the user. Both
      // rows are one browser, so it is alerted once and updated once.
      expect(pushesTo(1).map((p) => p.body)).toEqual(['[Hilltop] water here', '[Hilltop, Valley] water here']);
      expect(pushesTo(1).map((p) => p.silent)).toEqual([undefined, true]);
      await flushHolds();
      expect(appriseTo(1).map((c) => c.body)).toEqual(['[Hilltop, Valley] water here']);
    });

    it('an event with no merged text sends the first copy and drops the rest', async () => {
      addUser(1, { 'src-a': { notifyOnNewNode: true }, 'src-b': { notifyOnNewNode: true } });
      const p = (sourceId: string, sourceName: string) => ({
        title: 'T', body: `seen by ${sourceName}`, sourceId, sourceName, dedup: { key: 'plain:1' },
      });
      await notificationService.broadcastToPreferenceUsers('notifyOnNewNode', p('src-a', 'Hilltop'));
      await notificationService.broadcastToPreferenceUsers('notifyOnNewNode', p('src-b', 'Valley'));
      expect(pushesTo(1).map((x) => x.body)).toEqual(['seen by Hilltop']);
      await flushHolds();
      expect(appriseTo(1).map((c) => c.body)).toEqual(['seen by Hilltop']);
    });
  });

  describe('new Meshtastic node: per user, from the first source THEY can read (#5729, decision 5)', () => {
    const announce = (sourceId: string, sourceName: string, knownOnSourceIds: string[]) =>
      notificationService.notifyNewNode('!0000beef', 'Ridge Node', 'RDG', 9, 2, sourceId, sourceName, { nodeNum: 0xbeef, knownOnSourceIds });

    it('a user who reads only the later source still hears of it; a user who reads both hears once', async () => {
      addUser(1, { 'src-a': { notifyOnNewNode: true }, 'src-b': { notifyOnNewNode: true } });
      addUser(2, { 'src-b': { notifyOnNewNode: true } });
      h.state.deniedPairs?.add('2|src-a');

      await announce('src-a', 'Hilltop', []);
      // Much later (outside the dedup window), B completes the same node.
      vi.setSystemTime(T0 + NOTIFICATION_DEDUP_WINDOW_MS * 10);
      await announce('src-b', 'Valley', ['src-a']);
      await flushHolds();

      expect(pushesTo(1).map((p) => p.body)).toEqual([expect.stringContaining('detected by Hilltop')]);
      expect(pushesTo(2).map((p) => p.body)).toEqual([expect.stringContaining('detected by Valley')]);
      expect(appriseTo(1).map((c) => c.body)).toEqual([expect.stringContaining('detected by Hilltop')]);
      expect(appriseTo(2).map((c) => c.body)).toEqual([expect.stringContaining('detected by Valley')]);
      expect(everythingSentTo(2)).not.toContain('Hilltop');
    });

    it('two sources completing it at once: one alert per user, naming both', async () => {
      addUser(1, { 'src-a': { notifyOnNewNode: true }, 'src-b': { notifyOnNewNode: true } });
      await announce('src-a', 'Hilltop', []);
      await announce('src-b', 'Valley', []);
      await flushHolds();
      expect(pushesTo(1).filter((p) => p.silent !== true)).toHaveLength(1);
      expect(appriseTo(1).map((c) => c.body)).toEqual([expect.stringContaining('detected by Hilltop, Valley')]);
    });
  });

  describe('the shared store stays bounded', () => {
    it('holds one entry per recipient per event, not one per copy', async () => {
      addUser(1, { 'src-a': {}, 'src-b': {} });
      for (let i = 0; i < 5; i++) {
        await hear('src-a');
        await hear('src-b');
      }
      // push (one browser) + apprise (one user) + desktop (one machine).
      expect(notificationDedup.size).toBe(3);
    });

    it('old events are dropped as new ones arrive', async () => {
      addUser(1, { 'src-a': {} });
      for (let i = 1; i <= 20; i++) await hear('src-a', { packetId: i });
      expect(notificationDedup.size).toBe(60);
      vi.setSystemTime(T0 + NOTIFICATION_DEDUP_WINDOW_MS + 1);
      await hear('src-a', { packetId: 999 });
      expect(notificationDedup.size).toBe(3);
    });
  });
});
