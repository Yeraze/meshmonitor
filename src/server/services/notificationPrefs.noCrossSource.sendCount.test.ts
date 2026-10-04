/**
 * What removing the cross-source preference fallback does to notification
 * volume, counted.
 *
 * Two users, two Meshtastic sources (A and B), both users subscribed to Web
 * Push on both sources:
 *
 *   - user 1 saved settings on source A only. A typical tuned row: two
 *     channels on, one of them muted, direct messages off, emoji / MQTT /
 *     new-node / traceroute off, server events on, own keyword lists, Apprise
 *     on with a URL.
 *   - user 2 never saved anything.
 *
 * The same fifteen events are delivered on A and on B, through the REAL
 * delivery wrappers (web push, Apprise, desktop), the REAL filter and the REAL
 * notifications repository on an in-memory SQLite database. Only the push
 * client, the Apprise HTTP call and the OS notifier are stubbed.
 *
 * BEFORE is what `origin/main` (d4dfb15b0) produced for this exact file, run
 * unchanged there with `PREF_FALLBACK_BASELINE=1`. AFTER is what this branch
 * produces. Source A must not move at all for user 1: only the answer for a
 * source with no saved row changes.
 *
 * Each cell lists who was notified: `push:<userIds> apprise:<userIds>
 * desktop:<count>`.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => {
  process.env.ENABLE_DESKTOP_NOTIFICATIONS = 'true';
  return {
    repo: null as unknown as import('../../db/repositories/notifications.js').NotificationsRepository,
    sqlite: null as unknown as import('better-sqlite3').Database,
    notify: vi.fn(),
  };
});

vi.mock('../../services/database.js', async () => {
  const { createTestDb } = await import('../test-helpers/testDb.js');
  const { NotificationsRepository } = await import('../../db/repositories/notifications.js');
  const t = createTestDb();
  h.repo = new NotificationsRepository(t.db, 'sqlite');
  h.sqlite = t.sqlite;
  return {
    default: {
      notifications: h.repo,
      notificationsRepo: h.repo,
      settings: {
        getSetting: async () => null,
        getSettingForSource: async () => null,
        getLocalNodeNumForSource: async () => null,
      },
      sources: {
        getSource: async (id: string) => ({ id, name: id, type: 'meshtastic_tcp' }),
      },
      auth: { getAllUsers: async () => [{ id: 1, isActive: true }, { id: 2, isActive: true }] },
      getSettingAsync: async () => null,
      checkPermissionAsync: async () => true,
      waitForReady: async () => undefined,
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
vi.mock('node-notifier', () => ({ default: { notify: h.notify } }));

import { pushNotificationService } from './pushNotificationService.js';
import { appriseNotificationService } from './appriseNotificationService.js';
import { desktopNotificationService } from './desktopNotificationService.js';

const SOURCE_A = 'src-a';
const SOURCE_B = 'src-b';
const APPRISE_URL_USER_1 = 'json://example.invalid/user-1';

/** User 1's saved row on source A. User 1 has no other row; user 2 has none. */
const USER_1_ROW_ON_A = {
  enableWebPush: true,
  enableApprise: true,
  enabledChannels: [0, 1],
  enableDirectMessages: false,
  notifyOnEmoji: false,
  notifyOnMqtt: false,
  notifyOnNewNode: false,
  notifyOnTraceroute: false,
  notifyOnInactiveNode: false,
  notifyOnLowBattery: false,
  lowBatteryThreshold: 20,
  lowBatteryVoltageThreshold: 3300,
  notifyOnServerEvents: true,
  notifyOnWaypoint: false,
  waypointRadiusKm: 10,
  waypointCenterLat: null,
  waypointCenterLon: null,
  prefixWithNodeName: false,
  monitoredNodes: [],
  whitelist: ['urgent'],
  blacklist: ['spam'],
  appriseUrls: [APPRISE_URL_USER_1],
  mutedChannels: [{ channelId: 1, muteUntil: null }],
  mutedDMs: [],
  messageTitleTemplate: null,
  messageBodyTemplate: null,
};

type MessageEvent = { kind: 'message'; text: string; channelId: number; isDirectMessage: boolean; viaMqtt?: boolean };
type PreferenceEvent = { kind: 'preference'; key: 'notifyOnNewNode' | 'notifyOnTraceroute' | 'notifyOnServerEvents' };

const EVENTS: Record<string, MessageEvent | PreferenceEvent> = {
  'channel 0, plain text': { kind: 'message', text: 'Morning all', channelId: 0, isDirectMessage: false },
  'channel 1, plain text': { kind: 'message', text: 'Morning all', channelId: 1, isDirectMessage: false },
  'channel 5, plain text': { kind: 'message', text: 'Morning all', channelId: 5, isDirectMessage: false },
  'channel 5, "urgent" (user 1 allow word)': { kind: 'message', text: 'urgent: road closed', channelId: 5, isDirectMessage: false },
  'channel 0, "spam" (user 1 block word)': { kind: 'message', text: 'buy spam now', channelId: 0, isDirectMessage: false },
  'channel 0, via MQTT': { kind: 'message', text: 'Morning all', channelId: 0, isDirectMessage: false, viaMqtt: true },
  'channel 0, emoji only': { kind: 'message', text: '👍', channelId: 0, isDirectMessage: false },
  'channel 5, "Help" (default allow word)': { kind: 'message', text: 'Help needed at the gate', channelId: 5, isDirectMessage: false },
  'channel 5, "Is this thing on" (contains "hi")': { kind: 'message', text: 'Is this thing on', channelId: 5, isDirectMessage: false },
  'channel 0, "Radio test" (default block word)': { kind: 'message', text: 'Radio test 1 2 3', channelId: 0, isDirectMessage: false },
  'direct message, plain text': { kind: 'message', text: 'Are you there?', channelId: -1, isDirectMessage: true },
  'direct message, emoji only': { kind: 'message', text: '👍', channelId: -1, isDirectMessage: true },
  'new node': { kind: 'preference', key: 'notifyOnNewNode' },
  'traceroute': { kind: 'preference', key: 'notifyOnTraceroute' },
  'server event': { kind: 'preference', key: 'notifyOnServerEvents' },
};

type Matrix = Record<string, string>;

/** Measured on origin/main (d4dfb15b0): run this file with PREF_FALLBACK_BASELINE=1. */
const BEFORE: Record<string, Matrix> = {
  [SOURCE_A]: {},
  [SOURCE_B]: {},
};

/** This branch. */
const AFTER: Record<string, Matrix> = {
  [SOURCE_A]: {},
  [SOURCE_B]: {},
};

const BASELINE_RUN = process.env.PREF_FALLBACK_BASELINE === '1';

describe('notification volume with a row on source A only', () => {
  let pushSend: ReturnType<typeof vi.spyOn>;
  let appriseSend: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    const now = Date.now();
    h.sqlite.exec(`
      INSERT INTO users (id, username, password_hash, auth_provider, is_admin, is_active, mfa_enabled, created_at, updated_at)
      VALUES
        (1, 'tuned-on-a', 'hash', 'local', 0, 1, 0, ${now}, ${now}),
        (2, 'never-saved', 'hash', 'local', 0, 1, 0, ${now}, ${now})
    `);
    await h.repo.saveUserPreferences(1, USER_1_ROW_ON_A, SOURCE_A);
    for (const userId of [1, 2]) {
      for (const sourceId of [SOURCE_A, SOURCE_B]) {
        await h.repo.saveSubscription({
          userId,
          sourceId,
          endpoint: `https://push.example.invalid/${userId}`,
          p256dhKey: 'p',
          authKey: 'a',
        });
      }
    }
  });

  beforeEach(async () => {
    await appriseNotificationService.waitForInit();
    pushSend = vi.spyOn(pushNotificationService, 'sendToSubscription').mockResolvedValue(true);
    appriseSend = vi.spyOn(appriseNotificationService, 'sendNotificationToUrls').mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function deliver(sourceId: string, event: MessageEvent | PreferenceEvent): Promise<string> {
    pushSend.mockClear();
    appriseSend.mockClear();
    h.notify.mockClear();
    const payload = { title: 'T', body: 'B', sourceId, sourceName: sourceId };

    if (event.kind === 'message') {
      const ctx = {
        messageText: event.text,
        channelId: event.channelId,
        isDirectMessage: event.isDirectMessage,
        viaMqtt: event.viaMqtt,
        sourceId,
        sourceName: sourceId,
      };
      await pushNotificationService.broadcastWithFiltering(payload, ctx);
      await appriseNotificationService.broadcastWithFiltering(payload, ctx);
      await desktopNotificationService.broadcastWithFiltering(payload, ctx);
    } else {
      await pushNotificationService.broadcastToPreferenceUsers(event.key, payload, undefined, sourceId);
      await appriseNotificationService.broadcastToPreferenceUsers(event.key, payload, undefined, sourceId);
      await desktopNotificationService.broadcastToPreferenceUsers(event.key, payload, sourceId);
    }

    const pushUsers = pushSend.mock.calls
      .map((c) => (c[0] as { userId: number }).userId)
      .sort()
      .join(',');
    const appriseUsers = appriseSend.mock.calls
      .map((c) => ((c[1] as string[]).includes(APPRISE_URL_USER_1) ? 1 : 2))
      .join(',');
    return `push:${pushUsers || '-'} apprise:${appriseUsers || '-'} desktop:${h.notify.mock.calls.length}`;
  }

  async function measure(sourceId: string): Promise<Matrix> {
    const out: Matrix = {};
    for (const [label, event] of Object.entries(EVENTS)) {
      out[label] = await deliver(sourceId, event);
    }
    return out;
  }

  /** Notifications that reach `userId` over web push across a whole matrix. */
  const pushCount = (matrix: Matrix, userId: number): number =>
    Object.values(matrix).filter((cell) => cell.split(' ')[0].slice('push:'.length).split(',').includes(String(userId))).length;
  const appriseCount = (matrix: Matrix): number =>
    Object.values(matrix).filter((cell) => !cell.includes('apprise:-')).length;
  const desktopCount = (matrix: Matrix): number =>
    Object.values(matrix).filter((cell) => cell.endsWith('desktop:1')).length;

  it('source A, where user 1 saved settings', async () => {
    const actual = await measure(SOURCE_A);
    if (process.env.PREF_FALLBACK_PRINT === '1') console.log(`MATRIX ${SOURCE_A} ${JSON.stringify(actual)}`);
    expect(actual).toEqual((BASELINE_RUN ? BEFORE : AFTER)[SOURCE_A]);
  });

  it('source B, which neither user ever configured', async () => {
    const actual = await measure(SOURCE_B);
    if (process.env.PREF_FALLBACK_PRINT === '1') console.log(`MATRIX ${SOURCE_B} ${JSON.stringify(actual)}`);
    expect(actual).toEqual((BASELINE_RUN ? BEFORE : AFTER)[SOURCE_B]);
  });

  it('the totals, before and after', () => {
    const totals = (m: Record<string, Matrix>) => ({
      'A push user 1': pushCount(m[SOURCE_A], 1),
      'A push user 2': pushCount(m[SOURCE_A], 2),
      'A apprise': appriseCount(m[SOURCE_A]),
      'A desktop': desktopCount(m[SOURCE_A]),
      'B push user 1': pushCount(m[SOURCE_B], 1),
      'B push user 2': pushCount(m[SOURCE_B], 2),
      'B apprise': appriseCount(m[SOURCE_B]),
      'B desktop': desktopCount(m[SOURCE_B]),
    });
    expect(totals(BEFORE)).toEqual({});
    expect(totals(AFTER)).toEqual({});
  });
});
