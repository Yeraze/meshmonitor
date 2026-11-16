/**
 * Apprise and the desktop app: hold each deduped event 5 s, then send ONE
 * message that lists every source that heard it (#5729, decision 2). Web Push
 * keeps its immediate send + silent update.
 *
 * Real notifier, wrappers, filter, dedup and hold; fake timers; the database,
 * `web-push`, `fetch` and the OS notifier are stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fixturePrefs, subscriptionFor, type FixtureState } from '../test-helpers/messageNotificationFixture.js';

const SOURCES: Record<string, { id: string; name: string; type: string }> = {
  'src-a': { id: 'src-a', name: 'Hilltop', type: 'meshtastic_tcp' },
  'src-b': { id: 'src-b', name: 'Valley', type: 'meshtastic_tcp' },
  'src-c': { id: 'src-c', name: 'Ridge', type: 'meshtastic_tcp' },
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
  return {
    default: {
      ...buildDatabaseMock(h.state),
      nodes: { getNode: async () => ({ nodeNum: 305419896, nodeId: '!12345678', longName: 'Alice Mobile', shortName: 'ALC' }) },
      nodesRepo: { getNode: async () => null },
      sources: { getSource: async (id: string) => SOURCES[id] ?? null },
      channels: { getChannelById: async () => ({ id: 0, name: 'LongFast' }) },
      channelDatabase: { getByIdAsync: async () => null },
    },
  };
});
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../meshtasticManager.js', () => ({ fallbackManager: { getLocalNodeInfo: vi.fn(() => null), sourceId: 'src-a' } }));
vi.mock('../sourceManagerRegistry.js', () => ({ sourceManagerRegistry: {} }));
vi.mock('../sourceManagerTypes.js', () => ({ getPrimaryMeshtasticManager: () => undefined }));
vi.mock('../utils/ownNodes.js', () => ({ isOwnNodeNum: () => false, getOwnNodeNums: () => [] }));
vi.mock('node-notifier', () => ({ default: { notify: h.notify } }));
// The Apprise SSRF guard resolves the host; keep it off the network (and off
// real I/O, which fake timers cannot advance).
vi.mock('node:dns/promises', () => ({ lookup: vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]) }));
vi.mock('web-push', () => ({
  sendNotification: h.webPushSend,
  generateVAPIDKeys: () => ({ publicKey: 'pub', privateKey: 'priv' }),
  setVapidDetails: () => undefined,
}));

import { pushNotificationService } from './pushNotificationService.js';
import { appriseNotificationService } from './appriseNotificationService.js';
import { sendMessagePushNotification } from './messagePushNotifier.js';
import { notificationDedup, notificationHold, NOTIFICATION_COLLECT_HOLD_MS } from './notificationDedup.js';

let fetchMock: ReturnType<typeof vi.fn>;
const apprise = () => fetchMock.mock.calls.map((c) => JSON.parse((c[1] as { body: string }).body) as { title: string });
const desktop = () => h.notify.mock.calls.map((c) => (c[0] as { title: string }).title);
const pushes = () => h.webPushSend.mock.calls.map((c) => JSON.parse(c[1] as string) as { title: string; silent?: boolean });

async function hear(sourceId: string, packetId = 42) {
  await sendMessagePushNotification({
    message: { id: `${sourceId}_1_${packetId}`, fromNodeNum: 305419896, fromNodeId: '!12345678', channel: 0, portnum: 1, viaMqtt: false },
    messageText: 'meet at the trailhead',
    isDirectMessage: false,
    sourceId,
    localNodeNum: null,
  });
}

describe('Apprise / desktop collect-then-send (#5729)', () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date('2026-11-14T12:00:00Z'));
    await pushNotificationService.waitForInit();
    await appriseNotificationService.waitForInit();
    (pushNotificationService as unknown as { isConfigured: boolean }).isConfigured = true;
    notificationDedup.clear();
    notificationHold.clear();
    h.state.prefs.clear();
    h.state.subscriptions = [subscriptionFor(1, '__mesh__')];
    h.state.mesh = new Map();
    h.state.users = [{ id: 1, isActive: true }];
    h.state.appriseUsers = [1];
    for (const sourceId of Object.keys(SOURCES)) {
      h.state.prefs.set(`1|${sourceId}`, fixturePrefs({ appriseUrls: ['json://example.invalid/u1'] }));
    }
    h.notify.mockClear();
    h.webPushSend.mockClear();
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    notificationHold.clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('waits 5 s from the first copy, then sends one message naming every source', async () => {
    await hear('src-a');
    await vi.advanceTimersByTimeAsync(2_000);
    await hear('src-b');

    // Web Push is not held: first copy at once, then a silent update.
    expect(pushes().map((p) => p.silent)).toEqual([undefined, true]);

    await vi.advanceTimersByTimeAsync(NOTIFICATION_COLLECT_HOLD_MS - 2_000 - 1);
    expect(apprise()).toHaveLength(0);
    expect(desktop()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(apprise().map((m) => m.title)).toEqual(['LongFast · Hilltop, Valley']);
    expect(desktop()).toEqual(['LongFast · Hilltop, Valley']);
  });

  it('copies inside the hold never move the deadline; a copy after it is dropped, not re-sent', async () => {
    await hear('src-a');
    await vi.advanceTimersByTimeAsync(1_000);
    await hear('src-b');
    await vi.advanceTimersByTimeAsync(1_000);
    await hear('src-b'); // the same source again
    await vi.advanceTimersByTimeAsync(3_000); // 5 s after the FIRST copy
    expect(apprise()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await hear('src-c'); // inside the 60 s window, after the send
    await vi.advanceTimersByTimeAsync(NOTIFICATION_COLLECT_HOLD_MS * 4);

    expect(apprise().map((m) => m.title)).toEqual(['LongFast · Hilltop, Valley']);
    expect(desktop()).toEqual(['LongFast · Hilltop, Valley']);
  });

  it('a settings change during the hold does not re-arm it or add a send', async () => {
    await hear('src-a');
    await vi.advanceTimersByTimeAsync(2_000);
    // A save rewrites the user's rows; the hold reads none of them.
    h.state.prefs.set('1|src-a', fixturePrefs({ appriseUrls: ['json://example.invalid/u1'], notifyOnEmoji: false }));
    h.state.mesh = new Map([[1, { saved: true, pushSourceIds: null }]]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(apprise()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(NOTIFICATION_COLLECT_HOLD_MS * 4);
    expect(apprise()).toHaveLength(1);
  });

  it('graceful shutdown sends what is still held, once', async () => {
    await hear('src-a');
    await hear('src-b');
    await notificationHold.flushAll();
    expect(apprise().map((m) => m.title)).toEqual(['LongFast · Hilltop, Valley']);
    await vi.advanceTimersByTimeAsync(NOTIFICATION_COLLECT_HOLD_MS * 2);
    expect(apprise()).toHaveLength(1);
    expect(desktop()).toHaveLength(1);
  });

  it('two different packets are two holds and two messages', async () => {
    await hear('src-a', 42);
    await hear('src-b', 43);
    await vi.advanceTimersByTimeAsync(NOTIFICATION_COLLECT_HOLD_MS);
    expect(apprise().map((m) => m.title)).toEqual(['LongFast · Hilltop', 'LongFast · Valley']);
  });
});
