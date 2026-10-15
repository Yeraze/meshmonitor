import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MeshtasticManager } from './meshtasticManager.js';
import databaseService from '../services/database.js';

// Regression: updateGeofenceTriggerResult READ the per-source key
// (getSettingForSource(this.sourceId, 'geofenceTriggers')) but WROTE the
// un-namespaced GLOBAL key (setSetting('geofenceTriggers', ...)) — the same
// bug the timer-trigger writer had (see the timerTriggerScope test). Each fire
// copied this source's geofence list into the global key, where it bled into
// other sources. Read and write must both be source-scoped (#2839).

vi.mock('../services/database.js', () => ({
  default: {
    settings: {
      getSetting: vi.fn().mockResolvedValue(null),
      setSetting: vi.fn().mockResolvedValue(undefined),
      getSettingForSource: vi.fn().mockResolvedValue(null),
      setSourceSetting: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

vi.mock('./messageQueueService.js', () => {
  const mockInstance = {
    enqueue: vi.fn(),
    setSendCallback: vi.fn(),
    clear: vi.fn(),
    getStatus: vi.fn(() => ({ queueLength: 0, pendingAcks: 0, processing: false })),
  };
  function MessageQueueService() { return mockInstance as any; }
  return { messageQueueService: mockInstance, MessageQueueService };
});

describe('MeshtasticManager - geofence trigger result persistence is source-scoped', () => {
  const TRIGGER = {
    id: 'geo-1',
    name: 'Zone',
    enabled: true,
    shape: { type: 'circle', center: { lat: 26, lng: -80 }, radiusKm: 1 },
    event: 'entry',
    nodeFilter: { type: 'all' },
    responseType: 'text',
    response: 'hi',
    channel: 0,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes the result to the per-source key, not the global key', async () => {
    const manager = new MeshtasticManager('source-b');
    vi.mocked(databaseService.settings.getSettingForSource).mockResolvedValue(JSON.stringify([TRIGGER]));

    await (manager as any).updateGeofenceTriggerResult('geo-1', 'error', 'send failed');

    expect(databaseService.settings.getSettingForSource).toHaveBeenCalledWith('source-b', 'geofenceTriggers');
    expect(databaseService.settings.setSourceSetting).toHaveBeenCalledTimes(1);
    const [sourceId, key, value] = vi.mocked(databaseService.settings.setSourceSetting).mock.calls[0];
    expect(sourceId).toBe('source-b');
    expect(key).toBe('geofenceTriggers');
    const persisted = JSON.parse(value);
    expect(persisted[0].lastResult).toBe('error');
    expect(persisted[0].lastError).toBe('send failed');
    expect(databaseService.settings.setSetting).not.toHaveBeenCalledWith('geofenceTriggers', expect.anything());
  });
});
