/**
 * Key-access gate (#5551) and mute handling across the shared delivery paths
 * (P11 #6253). Real delivery wrappers + real filter; the database, the push
 * client, Apprise and the OS notifier are stubbed.
 *
 * - a keyed MeshCore message reaches only recipients with access to its key
 *   (admin yes, key holder yes, other user no, anonymous push no);
 * - an unkeyed message is unchanged;
 * - `broadcastToPreferenceUsers` (mentions) honours `keyFingerprint` and
 *   `muteVenue` on push, Apprise and desktop;
 * - a muted DM (`nodeUuid`) is filtered; an expired mute is not.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fixturePrefs,
  subscriptionFor,
  type FixtureState,
} from '../test-helpers/messageNotificationFixture.js';

const h = vi.hoisted(() => {
  process.env.ENABLE_DESKTOP_NOTIFICATIONS = 'true';
  return { state: null as unknown as FixtureState, notify: vi.fn(), keys: new Map<number, string[] | 'all'>() };
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
// Which channel keys a user can read is the key-access module's job (tested
// there). Here it is a lookup table; the row test stays the real one.
vi.mock('../utils/meshcoreKeyAccess.js', () => ({
  resolveMeshcoreKeyAccess: async (user: { id: number }) => h.keys.get(user.id) ?? [],
  canSeeKeyedMessage: (access: 'all' | string[], row: { keyFingerprint?: string | null }) =>
    access === 'all' || !row.keyFingerprint || access.includes(row.keyFingerprint),
}));

import { pushNotificationService } from './pushNotificationService.js';
import { appriseNotificationService } from './appriseNotificationService.js';
import { desktopNotificationService } from './desktopNotificationService.js';
import { messageReadableByUserAsync } from '../utils/notificationFiltering.js';

const SOURCE = 'mc-a';
const SOURCE_NAME = 'Mesh A';
const FP = 'aabbccdd11223344';
const ADMIN = 1;
const HOLDER = 2;
const OUTSIDER = 3;

const payload = {
  title: 'T',
  body: 'B',
  sourceId: SOURCE,
  sourceName: SOURCE_NAME,
};
const ctx = (extra: Record<string, unknown> = {}) => ({
  messageText: 'hello',
  channelId: 0,
  isDirectMessage: false,
  sourceId: SOURCE,
  sourceName: SOURCE_NAME,
  ...extra,
});

function load() {
  h.state.prefs.clear();
  h.state.deniedUsers.clear();
  h.state.subscriptions = [];
  h.state.appriseUsers = [];
  h.keys.clear();
  h.keys.set(HOLDER, [FP]);
  h.keys.set(ADMIN, 'all');
  h.state.users = [
    { id: ADMIN, isActive: true, isAdmin: true },
    { id: HOLDER, isActive: true },
    { id: OUTSIDER, isActive: true },
  ];
  for (const u of h.state.users) {
    h.state.prefs.set(`${u.id}|${SOURCE}`, fixturePrefs({ notifyOnMention: true }));
    h.state.subscriptions.push(subscriptionFor(u.id, SOURCE));
    h.state.appriseUsers.push(u.id);
  }
  h.state.subscriptions.push(subscriptionFor(null, SOURCE));
}

describe('keyed messages and mutes on the shared delivery paths', () => {
  let pushSend: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    load();
    h.notify.mockClear();
    await appriseNotificationService.waitForInit();
    pushSend = vi.spyOn(pushNotificationService, 'sendToSubscription').mockResolvedValue(true);
    vi.spyOn(appriseNotificationService, 'sendNotificationToUrls').mockResolvedValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  const pushUsers = () => pushSend.mock.calls.map((c) => (c[0] as { userId: number | null }).userId);

  it('messageReadableByUserAsync: admin and key holder yes, outsider and anonymous no', async () => {
    expect(await messageReadableByUserAsync(ADMIN, SOURCE, FP)).toBe(true);
    expect(await messageReadableByUserAsync(HOLDER, SOURCE, FP)).toBe(true);
    expect(await messageReadableByUserAsync(OUTSIDER, SOURCE, FP)).toBe(false);
    expect(await messageReadableByUserAsync(null, SOURCE, FP)).toBe(false);
  });

  it('messageReadableByUserAsync: an unkeyed message only needs messages:read', async () => {
    expect(await messageReadableByUserAsync(OUTSIDER, SOURCE, null)).toBe(true);
    expect(await messageReadableByUserAsync(null, SOURCE)).toBe(true);
    h.state.deniedUsers.add(OUTSIDER);
    expect(await messageReadableByUserAsync(OUTSIDER, SOURCE, null)).toBe(false);
    // messages:read is still required with a key.
    h.state.deniedUsers.add(HOLDER);
    expect(await messageReadableByUserAsync(HOLDER, SOURCE, FP)).toBe(false);
  });

  it('keyed message: push reaches admin and holder only, never anonymous', async () => {
    const res = await pushNotificationService.broadcastWithFiltering(payload, ctx({ keyFingerprint: FP, channelId: 0 }));
    expect(pushUsers().sort()).toEqual([ADMIN, HOLDER]);
    expect(res).toEqual({ sent: 2, failed: 0, filtered: 2 });
  });

  it('keyed message: Apprise reaches admin and holder only', async () => {
    const res = await appriseNotificationService.broadcastWithFiltering(payload, ctx({ keyFingerprint: FP }));
    expect(res.sent).toBe(2);
    expect(res.filtered).toBe(1);
  });

  it('keyed message: desktop skips an outsider and shows once for the first eligible user', async () => {
    h.state.users = [{ id: OUTSIDER, isActive: true }, { id: HOLDER, isActive: true }];
    const res = await desktopNotificationService.broadcastWithFiltering(payload, ctx({ keyFingerprint: FP }));
    expect(res).toEqual({ sent: 1, failed: 0, filtered: 1 });
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it('unkeyed message: unchanged (everyone with the channel on, anonymous included)', async () => {
    await pushNotificationService.broadcastWithFiltering(payload, ctx());
    expect(pushUsers().sort()).toEqual([null, ADMIN, HOLDER, OUTSIDER].sort());
  });

  it('broadcastToPreferenceUsers honours keyFingerprint on push, Apprise and desktop', async () => {
    const keyed = { ...payload, keyFingerprint: FP };
    const push = await pushNotificationService.broadcastToPreferenceUsers('notifyOnMention', keyed, undefined, SOURCE);
    const apprise = await appriseNotificationService.broadcastToPreferenceUsers('notifyOnMention', keyed, undefined, SOURCE);
    expect(pushUsers().sort()).toEqual([ADMIN, HOLDER]);
    expect(push.sent).toBe(2);
    expect(apprise.sent).toBe(2);

    h.state.users = [{ id: OUTSIDER, isActive: true }];
    const desktop = await desktopNotificationService.broadcastToPreferenceUsers('notifyOnMention', keyed, SOURCE);
    expect(desktop.sent).toBe(0);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('broadcastToPreferenceUsers: the key fingerprint never goes on the wire', async () => {
    await pushNotificationService.broadcastToPreferenceUsers('notifyOnMention', { ...payload, keyFingerprint: FP, muteVenue: { isDirectMessage: false, channelId: 1 } }, undefined, SOURCE);
    for (const c of pushSend.mock.calls) {
      const wire = c[1] as Record<string, unknown>;
      expect(wire.keyFingerprint).toBeUndefined();
      expect(wire.muteVenue).toBeUndefined();
    }
    expect(pushSend).toHaveBeenCalled();
  });

  it('a mute beats a mention: muted channel, muted room key, expired mute', async () => {
    h.state.prefs.set(`${HOLDER}|${SOURCE}`, fixturePrefs({
      notifyOnMention: true,
      mutedChannels: [{ channelId: 4, muteUntil: null }],
      mutedDMs: [{ nodeUuid: 'room-key', muteUntil: Date.now() + 60_000 }, { nodeUuid: 'old-key', muteUntil: Date.now() - 1000 }],
    }));
    const run = async (muteVenue: { isDirectMessage: boolean; channelId?: number; muteKey?: string }) => {
      pushSend.mockClear();
      await pushNotificationService.broadcastToPreferenceUsers('notifyOnMention', { ...payload, muteVenue }, undefined, SOURCE);
      return pushUsers();
    };
    expect(await run({ isDirectMessage: false, channelId: 4 })).not.toContain(HOLDER);
    expect(await run({ isDirectMessage: true, muteKey: 'room-key' })).not.toContain(HOLDER);
    expect(await run({ isDirectMessage: true, muteKey: 'old-key' })).toContain(HOLDER);
    expect(await run({ isDirectMessage: false, channelId: 5 })).toContain(HOLDER);
    // Other users hold no mute.
    expect(await run({ isDirectMessage: false, channelId: 4 })).toContain(ADMIN);
  });

  it('a muted DM (nodeUuid) is filtered on push and Apprise; an expired mute is not', async () => {
    h.state.prefs.set(`${HOLDER}|${SOURCE}`, fixturePrefs({
      mutedDMs: [{ nodeUuid: '!aaaa0001', muteUntil: null }, { nodeUuid: '!bbbb0002', muteUntil: Date.now() - 1000 }],
    }));
    const dm = (nodeUuid: string) => ctx({ isDirectMessage: true, channelId: -1, nodeUuid });

    await pushNotificationService.broadcastWithFiltering(payload, dm('!aaaa0001'));
    expect(pushUsers()).not.toContain(HOLDER);
    expect(pushUsers()).toContain(ADMIN);
    const ap = await appriseNotificationService.broadcastWithFiltering(payload, dm('!aaaa0001'));
    expect(ap.sent).toBe(2);

    pushSend.mockClear();
    await pushNotificationService.broadcastWithFiltering(payload, dm('!bbbb0002'));
    expect(pushUsers()).toContain(HOLDER);

    // A DM with no mute key cannot match a DM rule.
    pushSend.mockClear();
    await pushNotificationService.broadcastWithFiltering(payload, ctx({ isDirectMessage: true, channelId: -1 }));
    expect(pushUsers()).toContain(HOLDER);
  });
});
