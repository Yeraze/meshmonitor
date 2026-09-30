/**
 * pushNotificationService.sendToSubscription — dead-endpoint cleanup (#5493).
 *
 * Unsubscribe is per source now, but when the push service says the ENDPOINT
 * is gone (404/410) or invalid (other 4xx), every source's row for it is dead,
 * so cleanup must still remove all of them: removeSubscription(endpoint) with
 * no sourceId.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  sendNotification: vi.fn(),
  removeSubscription: vi.fn(),
}));

vi.mock('web-push', () => ({
  default: {
    sendNotification: h.sendNotification,
    setVapidDetails: vi.fn(),
    generateVAPIDKeys: vi.fn(() => ({ publicKey: 'pub', privateKey: 'priv' })),
  },
}));

vi.mock('../../services/database.js', () => ({
  default: {
    notificationsRepo: {
      removeSubscription: h.removeSubscription,
      updateSubscriptionLastUsed: vi.fn(),
    },
    settings: { getSetting: vi.fn().mockResolvedValue(null), setSetting: vi.fn() },
    waitForReady: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../meshtasticManager.js', () => ({ fallbackManager: { getLocalNodeInfo: vi.fn() } }));
vi.mock('../sourceManagerRegistry.js', () => ({ sourceManagerRegistry: {} }));
vi.mock('../sourceManagerTypes.js', () => ({ getPrimaryMeshtasticManager: () => undefined }));

import { pushNotificationService } from './pushNotificationService.js';

const SUB = {
  id: 1,
  userId: 7,
  sourceId: 'src-a',
  endpoint: 'https://push.example.com/dead',
  p256dhKey: 'p',
  authKey: 'a',
} as any;

describe('pushNotificationService.sendToSubscription dead-endpoint cleanup (#5493)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Force the configured path; VAPID setup is not under test here.
    (pushNotificationService as any).isConfigured = true;
    h.removeSubscription.mockResolvedValue(undefined);
  });

  it.each([404, 410, 400, 403])('status %i removes every source row for the endpoint', async (statusCode) => {
    h.sendNotification.mockRejectedValue(Object.assign(new Error('push failed'), { statusCode }));

    const ok = await pushNotificationService.sendToSubscription(SUB, { title: 't', body: 'b' });

    expect(ok).toBe(false);
    expect(h.removeSubscription).toHaveBeenCalledTimes(1);
    // Endpoint only, no sourceId: the endpoint is dead for every source.
    expect(h.removeSubscription).toHaveBeenCalledWith(SUB.endpoint, undefined);
  });

  it.each([413, 429, 500])('status %i keeps the subscription', async (statusCode) => {
    h.sendNotification.mockRejectedValue(Object.assign(new Error('push failed'), { statusCode }));

    await pushNotificationService.sendToSubscription(SUB, { title: 't', body: 'b' });

    expect(h.removeSubscription).not.toHaveBeenCalled();
  });
});
