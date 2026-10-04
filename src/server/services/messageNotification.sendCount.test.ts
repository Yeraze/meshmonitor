/**
 * Templates must not change HOW MANY notifications go out (#5593).
 *
 * Rendering happens after the filter decision, so for the same message and
 * the same recipients the sent/failed/filtered counts must be identical:
 *
 *   1. with no template saved (the new default), and
 *   2. with a custom template saved for every recipient — including templates
 *      built to trip a filter if filters ever read the rendered string.
 *
 * The expected numbers below are also what the pre-#5593 code produces for
 * this exact matrix: this file was run unchanged against `origin/main`
 * (which ignores the extra `message` field and the two template prefs) and
 * passed with the same counts. So the counts are "before" as well as "after".
 *
 * Real delivery wrappers + real filter; only the database, the push client,
 * the Apprise HTTP call and the OS notifier are stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fixturePrefs,
  subscriptionFor,
  type FixturePrefs,
  type FixtureState,
} from '../test-helpers/messageNotificationFixture.js';

const h = vi.hoisted(() => {
  process.env.ENABLE_DESKTOP_NOTIFICATIONS = 'true';
  return { state: null as unknown as FixtureState, notify: vi.fn() };
});

vi.mock('../../services/database.js', async () => {
  const { buildDatabaseMock, emptyState } = await import('../test-helpers/messageNotificationFixture.js');
  h.state = emptyState();
  return { default: buildDatabaseMock(h.state) };
});
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../meshtasticManager.js', () => ({
  fallbackManager: { getLocalNodeInfo: vi.fn(() => ({ longName: 'LocalNode' })), sourceId: 'src-a' },
}));
vi.mock('../sourceManagerRegistry.js', () => ({ sourceManagerRegistry: {} }));
vi.mock('../sourceManagerTypes.js', () => ({ getPrimaryMeshtasticManager: () => undefined }));
vi.mock('node-notifier', () => ({ default: { notify: h.notify } }));

import { pushNotificationService } from './pushNotificationService.js';
import { appriseNotificationService } from './appriseNotificationService.js';
import { desktopNotificationService } from './desktopNotificationService.js';

const SOURCE = 'src-a';
const SOURCE_NAME = 'Home Base';
const TEXT = 'urgent spam check';

const payload = {
  title: 'New Meshtastic Message',
  body: `LongFast • ${SOURCE_NAME}\nAlice Mobile: ${TEXT}`,
  sourceId: SOURCE,
  sourceName: SOURCE_NAME,
  message: {
    sourceName: SOURCE_NAME,
    channelName: 'LongFast',
    senderName: 'Alice Mobile',
    senderShortName: 'ALC',
    text: TEXT,
    serviceLabel: 'Meshtastic',
    isDM: false,
  },
};

const filterContext = {
  messageText: TEXT,
  channelId: 0,
  isDirectMessage: false,
  sourceId: SOURCE,
  sourceName: SOURCE_NAME,
};

/**
 * The recipient matrix. One row per user; `why` says what the filter should
 * do with them.
 */
const RECIPIENTS: Array<{ id: number; why: string; prefs: Partial<FixturePrefs>; denied?: boolean }> = [
  { id: 1, why: 'channel enabled → sent', prefs: {} },
  { id: 2, why: 'channel not enabled → filtered', prefs: { enabledChannels: [3] } },
  { id: 3, why: 'blacklist word in the text → filtered', prefs: { blacklist: ['spam'] } },
  { id: 4, why: 'whitelist word in the text beats a disabled channel → sent', prefs: { enabledChannels: [], whitelist: ['urgent'] } },
  { id: 5, why: 'blacklist word only in the source name → sent', prefs: { blacklist: ['Home'] } },
  { id: 6, why: 'no messages:read on the source → filtered', prefs: {}, denied: true },
  { id: 7, why: 'web push off, Apprise on with no URLs → filtered on both', prefs: { enableWebPush: false, appriseUrls: [] } },
  { id: 8, why: 'channel muted → filtered', prefs: { mutedChannels: [{ channelId: 0, muteUntil: null }] } },
  { id: 9, why: 'whitelist word only in the channel name → filtered (channel off)', prefs: { enabledChannels: [], whitelist: ['LongFast'] } },
];

/**
 * A template built to change the outcome if any filter read the rendered
 * string: it hides the text (so "spam"/"urgent" vanish) and adds the words
 * other users filter on ("Home", "LongFast", "urgent", "spam").
 */
const HOSTILE_TEMPLATES: Pick<FixturePrefs, 'messageTitleTemplate' | 'messageBodyTemplate'> = {
  messageTitleTemplate: 'urgent spam Home {{ channelName }} {{ sourceName }}',
  messageBodyTemplate: '{{ senderName }} LongFast urgent',
};

const EXPECTED = {
  // 9 user subscriptions + 1 anonymous. Sent: users 1, 4, 5 + anonymous.
  webPush: { sent: 4, failed: 0, filtered: 6 },
  // 9 Apprise users. Sent: 1, 4, 5.
  apprise: { sent: 3, failed: 0, filtered: 6 },
  // One desktop machine: a single notification for the first eligible user.
  desktop: { sent: 1, failed: 0, filtered: 0 },
};

function loadMatrix(templates: Partial<FixturePrefs>) {
  h.state.prefs.clear();
  h.state.deniedUsers.clear();
  h.state.subscriptions = [];
  h.state.appriseUsers = [];
  h.state.users = [];
  for (const r of RECIPIENTS) {
    h.state.prefs.set(`${r.id}|${SOURCE}`, fixturePrefs({ ...r.prefs, ...templates }));
    h.state.subscriptions.push(subscriptionFor(r.id, SOURCE));
    h.state.appriseUsers.push(r.id);
    h.state.users.push({ id: r.id, isActive: true });
    if (r.denied) h.state.deniedUsers.add(r.id);
  }
  h.state.subscriptions.push(subscriptionFor(null, SOURCE));
}

describe('message notification send counts are unchanged by templates (#5593)', () => {
  let pushSend: ReturnType<typeof vi.spyOn>;
  let appriseSend: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    h.notify.mockClear();
    await appriseNotificationService.waitForInit();
    pushSend = vi.spyOn(pushNotificationService, 'sendToSubscription').mockResolvedValue(true);
    appriseSend = vi.spyOn(appriseNotificationService, 'sendNotificationToUrls').mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function run(templates: Partial<FixturePrefs>) {
    loadMatrix(templates);
    pushSend.mockClear();
    appriseSend.mockClear();
    h.notify.mockClear();
    const webPush = await pushNotificationService.broadcastWithFiltering(payload, filterContext);
    const apprise = await appriseNotificationService.broadcastWithFiltering(payload, filterContext);
    const desktop = await desktopNotificationService.broadcastWithFiltering(payload, filterContext);
    return {
      counts: { webPush, apprise, desktop },
      calls: {
        webPush: pushSend.mock.calls.length,
        apprise: appriseSend.mock.calls.length,
        desktop: h.notify.mock.calls.length,
      },
      pushRecipients: pushSend.mock.calls.map((c) => (c[0] as { userId: number | null }).userId),
      appriseRecipients: appriseSend.mock.calls.map((c) => (c[1] as string[]).length),
    };
  }

  it('default templates: the counts match the pre-#5593 baseline', async () => {
    const result = await run({});
    expect(result.counts).toEqual(EXPECTED);
    expect(result.calls).toEqual({ webPush: 4, apprise: 3, desktop: 1 });
    expect(result.pushRecipients).toEqual([1, 4, 5, null]);
  });

  it('custom templates built to trip the filters: the counts and recipients are identical', async () => {
    const before = await run({});
    const after = await run(HOSTILE_TEMPLATES);
    expect(after.counts).toEqual(before.counts);
    expect(after.calls).toEqual(before.calls);
    expect(after.pushRecipients).toEqual(before.pushRecipients);
    expect(after.counts).toEqual(EXPECTED);
  });

  it('a mix of default and custom recipients: still the same counts', async () => {
    loadMatrix({});
    for (const id of [1, 3, 5, 7, 9]) {
      const key = `${id}|${SOURCE}`;
      h.state.prefs.set(key, { ...h.state.prefs.get(key)!, ...HOSTILE_TEMPLATES });
    }
    const webPush = await pushNotificationService.broadcastWithFiltering(payload, filterContext);
    const apprise = await appriseNotificationService.broadcastWithFiltering(payload, filterContext);
    expect({ webPush, apprise }).toEqual({ webPush: EXPECTED.webPush, apprise: EXPECTED.apprise });
  });
});
