import { describe, it, expect, vi, beforeEach } from 'vitest';

const broadcast = vi.fn().mockResolvedValue(undefined);
vi.mock('./notificationService.js', () => ({
  notificationService: { broadcastToPreferenceUsers: (...a: unknown[]) => broadcast(...a) },
}));

import { serverEventNotificationService as svc } from './serverEventNotificationService.js';

describe('connection events (P11 S6)', () => {
  beforeEach(() => broadcast.mockClear());

  it('first connect is silent; a drop then reconnect gives one of each, with neutral wording', async () => {
    await svc.notifyNodeConnected('mc1', 'Hill');
    expect(broadcast).not.toHaveBeenCalled();
    await svc.notifyNodeDisconnected('mc1', 'Hill');
    await svc.notifyNodeDisconnected('mc1', 'Hill'); // repeat is deduped
    await svc.notifyNodeConnected('mc1', 'Hill');
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast.mock.calls[0][1].body).toBe("Lost connection to the source's radio");
    expect(broadcast.mock.calls[1][1].body).toMatch(/^Connection to the radio restored/);
    expect(JSON.stringify(broadcast.mock.calls)).not.toMatch(/Meshtastic/);
  });
});
