/**
 * appriseNotificationService.broadcastToPreferenceUsers — #4020 targeted vs.
 * untargeted delivery-path tests.
 *
 * Targeted (targetUserId set — the check service, e.g. lowBatteryNotification
 * Service, already decided this user should be notified):
 *   - iterates [targetUserId] directly instead of the any-row "who has
 *     Apprise enabled anywhere" list
 *   - does NOT re-gate on prefs[preferenceKey] (that flag can live on a
 *     different row than the one with the working Apprise URLs)
 *   - resolves { urls, prefixWithNodeName } via resolveAppriseTargetAsync
 *     (exact-source row -> '' row -> any remaining row)
 *
 * Untargeted (no targetUserId — new node / traceroute / server events):
 *   - unchanged: single-row, single-source gate via
 *     getUserNotificationPreferencesAsync, including prefs[preferenceKey]
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  waitForReadyMock: vi.fn().mockResolvedValue(undefined),
  getSettingMock: vi.fn(),
  getSettingForSourceMock: vi.fn(),
  checkPermissionAsyncMock: vi.fn(),
  getUserNotificationPreferencesAsyncMock: vi.fn(),
  getUsersWithServiceEnabledAsyncMock: vi.fn(),
  shouldFilterNotificationAsyncMock: vi.fn(),
  applyNodeNamePrefixAsyncMock: vi.fn(),
  resolveAppriseTargetAsyncMock: vi.fn(),
}));

vi.mock('../../services/database.js', () => ({
  default: {
    waitForReady: h.waitForReadyMock,
    settings: {
      getSetting: h.getSettingMock,
      getSettingForSource: h.getSettingForSourceMock,
    },
    checkPermissionAsync: h.checkPermissionAsyncMock,
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
vi.mock('../sourceManagerTypes.js', () => ({ getPrimaryMeshtasticManager: () => undefined }));

vi.mock('../utils/notificationFiltering.js', () => ({
  getUserNotificationPreferencesAsync: h.getUserNotificationPreferencesAsyncMock,
  getUsersWithServiceEnabledAsync: h.getUsersWithServiceEnabledAsyncMock,
  shouldFilterNotificationAsync: h.shouldFilterNotificationAsyncMock,
  applyNodeNamePrefixAsync: h.applyNodeNamePrefixAsyncMock,
  resolveAppriseTargetAsync: h.resolveAppriseTargetAsyncMock,
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { appriseNotificationService } from './appriseNotificationService.js';

const PAYLOAD = { title: 'Low battery', body: 'Node low', sourceId: 'src-a', sourceName: 'Source A' };

describe('appriseNotificationService.broadcastToPreferenceUsers (#4020)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    h.waitForReadyMock.mockResolvedValue(undefined);
    h.getSettingForSourceMock.mockImplementation(async (_src: string, key: string) => {
      if (key === 'apprise_url') return 'http://apprise.example.com';
      if (key === 'apprise_enabled') return 'true';
      return null;
    });
    h.getSettingMock.mockResolvedValue(null);
    h.checkPermissionAsyncMock.mockResolvedValue(true);
    h.applyNodeNamePrefixAsyncMock.mockImplementation(async (_uid: number, body: string) => body);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ sent_to: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    );
    await appriseNotificationService.waitForInit();
  });

  describe('targeted (targetUserId set)', () => {
    it('delivers using row-B URLs when the flag lives on row A (no preferenceKey re-gate)', async () => {
      // resolveAppriseTargetAsync is the sole authority for the targeted path —
      // it returns row-B's URLs regardless of which row has notifyOnLowBattery.
      h.resolveAppriseTargetAsyncMock.mockResolvedValue({ urls: ['discord://row-b'], prefixWithNodeName: false });

      const result = await appriseNotificationService.broadcastToPreferenceUsers(
        'notifyOnLowBattery',
        PAYLOAD,
        7,
        'src-a'
      );

      expect(h.resolveAppriseTargetAsyncMock).toHaveBeenCalledWith(7, 'src-a');
      // The any-row "who has apprise enabled" list must NOT be consulted for
      // a targeted call.
      expect(h.getUsersWithServiceEnabledAsyncMock).not.toHaveBeenCalled();
      // getUserNotificationPreferencesAsync (the single-row preferenceKey gate)
      // must NOT be consulted for a targeted call either.
      expect(h.getUserNotificationPreferencesAsyncMock).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledWith(
        'http://apprise.example.com/notify',
        expect.objectContaining({ body: expect.stringContaining('discord://row-b') })
      );
      expect(result.sent).toBe(1);
      expect(result.filtered).toBe(0);
    });

    it('filters when no row anywhere has a usable Apprise channel', async () => {
      h.resolveAppriseTargetAsyncMock.mockResolvedValue(null);

      const result = await appriseNotificationService.broadcastToPreferenceUsers(
        'notifyOnLowBattery',
        PAYLOAD,
        7,
        'src-a'
      );

      expect(result).toEqual({ sent: 0, failed: 0, filtered: 1 });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('still applies the per-source messages:read permission gate', async () => {
      h.checkPermissionAsyncMock.mockResolvedValue(false);
      h.resolveAppriseTargetAsyncMock.mockResolvedValue({ urls: ['discord://x'], prefixWithNodeName: false });

      const result = await appriseNotificationService.broadcastToPreferenceUsers(
        'notifyOnLowBattery',
        PAYLOAD,
        7,
        'src-a'
      );

      expect(result).toEqual({ sent: 0, failed: 0, filtered: 1 });
      expect(h.resolveAppriseTargetAsyncMock).not.toHaveBeenCalled();
    });

    it('prefixes with the node name using the resolved row\'s prefixWithNodeName, not a re-query', async () => {
      h.resolveAppriseTargetAsyncMock.mockResolvedValue({ urls: ['discord://row-b'], prefixWithNodeName: true });

      await appriseNotificationService.broadcastToPreferenceUsers('notifyOnLowBattery', PAYLOAD, 7, 'src-a');

      expect(h.applyNodeNamePrefixAsyncMock).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledWith(
        'http://apprise.example.com/notify',
        expect.objectContaining({ body: expect.stringContaining('[LocalNode] Node low') })
      );
    });
  });

  describe('untargeted (no targetUserId)', () => {
    it('delivers via the any-row list, using the single-row preferenceKey gate', async () => {
      h.getUsersWithServiceEnabledAsyncMock.mockResolvedValue([5]);
      h.getUserNotificationPreferencesAsyncMock.mockResolvedValue({
        enableApprise: true,
        notifyOnNewNode: true,
        appriseUrls: ['discord://untargeted'],
        prefixWithNodeName: false,
      });

      const result = await appriseNotificationService.broadcastToPreferenceUsers(
        'notifyOnNewNode',
        { ...PAYLOAD, title: 'New node' },
        undefined,
        'src-a'
      );

      expect(h.resolveAppriseTargetAsyncMock).not.toHaveBeenCalled();
      expect(result.sent).toBe(1);
    });

    it('filters when the exact-row preferenceKey is false, even if a \'\' row would have been usable', async () => {
      h.getUsersWithServiceEnabledAsyncMock.mockResolvedValue([5]);
      h.getUserNotificationPreferencesAsyncMock.mockResolvedValue({
        enableApprise: true,
        notifyOnNewNode: false, // opted out on this exact row
        appriseUrls: ['discord://x'],
        prefixWithNodeName: false,
      });

      const result = await appriseNotificationService.broadcastToPreferenceUsers(
        'notifyOnNewNode',
        { ...PAYLOAD, title: 'New node' },
        undefined,
        'src-a'
      );

      expect(result).toEqual({ sent: 0, failed: 0, filtered: 1 });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
