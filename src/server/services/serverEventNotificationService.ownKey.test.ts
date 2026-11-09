import { describe, it, expect, vi, beforeEach } from 'vitest';

const broadcast = vi.fn().mockResolvedValue(undefined);
vi.mock('./notificationService.js', () => ({
  notificationService: { broadcastToPreferenceUsers: (...a: unknown[]) => broadcast(...a) },
}));

import { serverEventNotificationService } from './serverEventNotificationService.js';

describe('notifyOwnKeyChanged (P7a #6254)', () => {
  beforeEach(() => broadcast.mockClear());

  it('broadcasts one warning under notifyOnServerEvents, with 8-char prefixes only', async () => {
    await serverEventNotificationService.notifyOwnKeyChanged('s1', 'Hilltop', 'aaaaaaaa11111111', 'bbbbbbbb22222222');
    expect(broadcast).toHaveBeenCalledTimes(1);
    const [pref, payload] = broadcast.mock.calls[0];
    expect(pref).toBe('notifyOnServerEvents');
    expect(payload).toMatchObject({ type: 'warning', sourceId: 's1', sourceName: 'Hilltop' });
    expect(payload.title).toContain('Hilltop');
    expect(payload.body).toContain('aaaaaaaa');
    expect(payload.body).toContain('bbbbbbbb');
    expect(payload.body).not.toContain('11111111');
  });

  it('does not throw when the broadcast fails', async () => {
    broadcast.mockRejectedValueOnce(new Error('x'));
    await expect(serverEventNotificationService.notifyOwnKeyChanged('s1', 'n', 'a', 'b')).resolves.toBeUndefined();
  });
});
