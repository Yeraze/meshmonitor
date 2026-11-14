/**
 * pushNotificationService.broadcastToPreferenceUsers — #4020 targeted vs.
 * untargeted delivery-path tests.
 *
 * Targeted (targetUserId set — the check service already decided this user
 * should be notified):
 *   - skips the prefs[preferenceKey] re-check (that flag can live on a
 *     different row than the one whose subscription we're sending to)
 *   - requires enableWebPush=true on ANY of the user's rows (via
 *     getUserPreferenceRows), not just the effective-source row
 *
 * Untargeted (no targetUserId):
 *   - unchanged: single-row, single-source gate via
 *     getUserNotificationPreferencesAsync, including prefs[preferenceKey]
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  getAllSubscriptionsMock: vi.fn(),
  checkPermissionAsyncMock: vi.fn(),
  getUserPreferenceRowsMock: vi.fn(),
  sendToSubscriptionMock: vi.fn(),
  getUserNotificationPreferencesAsyncMock: vi.fn(),
  applyNodeNamePrefixAsyncMock: vi.fn(),
  shouldFilterNotificationAsyncMock: vi.fn(),
  pushSourceAllowedAsyncMock: vi.fn(),
}));

vi.mock('../../services/database.js', () => ({
  default: {
    notificationsRepo: {
      getAllSubscriptions: h.getAllSubscriptionsMock,
      updateSubscriptionLastUsed: vi.fn(),
    },
    notifications: {
      getUserPreferenceRows: h.getUserPreferenceRowsMock,
    },
    settings: {
      getSetting: vi.fn().mockResolvedValue(null),
    },
    checkPermissionAsync: h.checkPermissionAsyncMock,
    waitForReady: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../meshtasticManager.js', () => ({
  fallbackManager: {
    getLocalNodeInfo: vi.fn(() => ({ longName: 'LocalNode' })),
  },
}));

vi.mock('../sourceManagerRegistry.js', () => ({ sourceManagerRegistry: {} }));
vi.mock('../utils/localNodeNameForSource.js', () => ({
  resolveLocalNodeNameForSource: vi.fn(async () => 'LocalNode'),
}));
vi.mock('../sourceManagerTypes.js', () => ({ getPrimaryMeshtasticManager: () => undefined }));

vi.mock('../utils/notificationFiltering.js', () => ({
  getUserNotificationPreferencesAsync: h.getUserNotificationPreferencesAsyncMock,
  shouldFilterNotificationAsync: h.shouldFilterNotificationAsyncMock,
  applyNodeNamePrefixAsync: h.applyNodeNamePrefixAsyncMock,
  pushSourceAllowedAsync: h.pushSourceAllowedAsyncMock,
  userReadsAnySourceAsync: vi.fn(async () => false),
}));

import { pushNotificationService } from './pushNotificationService.js';

const PAYLOAD = { title: 'Low battery', body: 'Node low', sourceId: 'src-a', sourceName: 'Source A' };

const SUB = {
  id: 1,
  userId: 7,
  sourceId: 'other-src',
  endpoint: 'https://push.example.com/x',
  p256dhKey: 'p',
  authKey: 'a',
};

describe('pushNotificationService.broadcastToPreferenceUsers (#4020)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    h.checkPermissionAsyncMock.mockResolvedValue(true);
    h.pushSourceAllowedAsyncMock.mockResolvedValue(true);
    h.applyNodeNamePrefixAsyncMock.mockImplementation(async (_uid: number, body: string) => body);
    // sendToSubscription hits web-push directly — stub isConfigured off so
    // sendToSubscription short-circuits to false without touching the real
    // webpush client, but we only care about the filtering path, so instead
    // spy on the service's own sendToSubscription.
    vi.spyOn(pushNotificationService, 'sendToSubscription').mockResolvedValue(true);
  });

  describe('targeted (targetUserId set)', () => {
    it('does not re-gate on prefs[preferenceKey] — delivers based on any-row enableWebPush + an existing subscription', async () => {
      h.getAllSubscriptionsMock.mockResolvedValue([SUB]);
      // The subscription's own source ('other-src') has NO preference row at
      // all; enableWebPush lives on a DIFFERENT row (the '' row).
      h.getUserPreferenceRowsMock.mockResolvedValue([
        { sourceId: '', prefs: { enableWebPush: true, notifyOnLowBattery: false } },
      ]);

      const result = await pushNotificationService.broadcastToPreferenceUsers(
        'notifyOnLowBattery',
        PAYLOAD,
        7,
        'src-a'
      );

      expect(h.getUserNotificationPreferencesAsyncMock).not.toHaveBeenCalled();
      expect(h.getUserPreferenceRowsMock).toHaveBeenCalledWith(7);
      expect(result.sent).toBe(1);
      expect(result.filtered).toBe(0);
    });

    it('filters when no row has enableWebPush=true', async () => {
      h.getAllSubscriptionsMock.mockResolvedValue([SUB]);
      h.getUserPreferenceRowsMock.mockResolvedValue([
        { sourceId: '', prefs: { enableWebPush: false, notifyOnLowBattery: true } },
      ]);

      const result = await pushNotificationService.broadcastToPreferenceUsers(
        'notifyOnLowBattery',
        PAYLOAD,
        7,
        'src-a'
      );

      expect(result).toEqual({ sent: 0, failed: 0, filtered: 1 });
    });

    it('still applies the per-source messages:read permission gate', async () => {
      h.getAllSubscriptionsMock.mockResolvedValue([SUB]);
      h.checkPermissionAsyncMock.mockResolvedValue(false);

      const result = await pushNotificationService.broadcastToPreferenceUsers(
        'notifyOnLowBattery',
        PAYLOAD,
        7,
        'src-a'
      );

      expect(result).toEqual({ sent: 0, failed: 0, filtered: 1 });
      expect(h.getUserPreferenceRowsMock).not.toHaveBeenCalled();
    });

    it('ignores other users\' subscriptions even if returned in the same list', async () => {
      h.getAllSubscriptionsMock.mockResolvedValue([SUB, { ...SUB, id: 2, userId: 99 }]);
      h.getUserPreferenceRowsMock.mockResolvedValue([
        { sourceId: '', prefs: { enableWebPush: true, notifyOnLowBattery: false } },
      ]);

      const result = await pushNotificationService.broadcastToPreferenceUsers(
        'notifyOnLowBattery',
        PAYLOAD,
        7,
        'src-a'
      );

      // Only user 7's subscription is targeted; user 99 is filtered out.
      expect(result.sent).toBe(1);
      expect(result.filtered).toBe(1);
    });
  });

  describe('untargeted (no targetUserId)', () => {
    it('keeps the original single-row, single-source gate', async () => {
      h.getAllSubscriptionsMock.mockResolvedValue([SUB]);
      h.getUserNotificationPreferencesAsyncMock.mockResolvedValue({
        enableWebPush: true,
        notifyOnNewNode: true,
      });

      const result = await pushNotificationService.broadcastToPreferenceUsers(
        'notifyOnNewNode',
        { ...PAYLOAD, title: 'New node' },
        undefined,
        'src-a'
      );

      expect(h.getUserPreferenceRowsMock).not.toHaveBeenCalled();
      expect(result.sent).toBe(1);
    });

    it('filters when the exact-row preferenceKey is false', async () => {
      h.getAllSubscriptionsMock.mockResolvedValue([SUB]);
      h.getUserNotificationPreferencesAsyncMock.mockResolvedValue({
        enableWebPush: true,
        notifyOnNewNode: false,
      });

      const result = await pushNotificationService.broadcastToPreferenceUsers(
        'notifyOnNewNode',
        { ...PAYLOAD, title: 'New node' },
        undefined,
        'src-a'
      );

      expect(result).toEqual({ sent: 0, failed: 0, filtered: 1 });
    });
  });

  // One subscription per browser for the whole mesh (#5729). An untargeted
  // broadcast is about one source, so it reaches a browser only when that
  // source is in the user's Web Push source list. (Before #5729 the list was
  // "the sources this browser subscribed on", one row per source; a browser
  // subscribed on A and B got B's pushes twice.)
  describe('which subscriptions a broadcast reaches', () => {
    const MESH_SUB = { ...SUB, id: 1, sourceId: '__mesh__' };

    it('untargeted: every subscription is a candidate; one push per browser', async () => {
      h.getAllSubscriptionsMock.mockResolvedValue([MESH_SUB]);
      h.getUserNotificationPreferencesAsyncMock.mockResolvedValue({ enableWebPush: true, notifyOnNewNode: true });

      const result = await pushNotificationService.broadcastToPreferenceUsers('notifyOnNewNode', PAYLOAD, undefined, 'src-a');

      expect(h.getAllSubscriptionsMock).toHaveBeenCalledWith(undefined);
      expect(h.pushSourceAllowedAsyncMock).toHaveBeenCalledWith(7, 'src-a');
      expect(result).toEqual({ sent: 1, failed: 0, filtered: 0 });
      expect(pushNotificationService.sendToSubscription).toHaveBeenCalledTimes(1);
    });

    it('untargeted: a source outside the user\'s Web Push sources gets nothing', async () => {
      h.getAllSubscriptionsMock.mockResolvedValue([MESH_SUB]);
      h.getUserNotificationPreferencesAsyncMock.mockResolvedValue({ enableWebPush: true, notifyOnNewNode: true });
      h.pushSourceAllowedAsyncMock.mockResolvedValue(false);

      const result = await pushNotificationService.broadcastToPreferenceUsers('notifyOnNewNode', PAYLOAD, undefined, 'src-a');

      expect(result).toEqual({ sent: 0, failed: 0, filtered: 1 });
      expect(pushNotificationService.sendToSubscription).not.toHaveBeenCalled();
    });

    it('untargeted: the source comes from the payload when no sourceId argument is given', async () => {
      h.getAllSubscriptionsMock.mockResolvedValue([MESH_SUB]);
      h.getUserNotificationPreferencesAsyncMock.mockResolvedValue({ enableWebPush: true, notifyOnServerEvents: true });

      const result = await pushNotificationService.broadcastToPreferenceUsers('notifyOnServerEvents', PAYLOAD);

      expect(h.pushSourceAllowedAsyncMock).toHaveBeenCalledWith(7, 'src-a');
      expect(result.sent).toBe(1);
    });

    it('targeted: every subscription of that user; the source list is not consulted (#4020)', async () => {
      h.getAllSubscriptionsMock.mockResolvedValue([MESH_SUB]);
      h.pushSourceAllowedAsyncMock.mockResolvedValue(false);
      h.getUserPreferenceRowsMock.mockResolvedValue([
        { sourceId: 'src-b', prefs: { enableWebPush: true, notifyOnLowBattery: true } },
      ]);

      const result = await pushNotificationService.broadcastToPreferenceUsers('notifyOnLowBattery', PAYLOAD, 7, 'src-a');

      expect(result).toEqual({ sent: 1, failed: 0, filtered: 0 });
    });
  });
});
