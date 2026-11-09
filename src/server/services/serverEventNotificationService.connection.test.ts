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

  it("link 'broker' uses broker wording and never says radio (#6307)", async () => {
    await svc.notifyNodeConnected('mqtt1', 'Feed', 'broker');
    await svc.notifyNodeDisconnected('mqtt1', 'Feed', 'broker');
    await svc.notifyNodeConnected('mqtt1', 'Feed', 'broker');
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast.mock.calls[0][1].body).toBe('Lost connection to the MQTT broker');
    expect(broadcast.mock.calls[0][1].title).toBe('MQTT Broker Disconnected · Feed');
    expect(broadcast.mock.calls[1][1].body).toMatch(/^Connection to the MQTT broker restored/);
    expect(JSON.stringify(broadcast.mock.calls)).not.toMatch(/radio/i);
  });
});
