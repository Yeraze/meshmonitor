import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MeshtasticManager } from './meshtasticManager.js';
import databaseService from '../services/database.js';

// Regression: "Timed Events are happening across all sources and not just the
// one intended." updateTimerTriggerResult READ the per-source key
// (getSettingForSource(this.sourceId, 'timerTriggers')) but WROTE the
// un-namespaced GLOBAL key (setSetting('timerTriggers', ...)). On every fire it
// copied that source's trigger list into the global key, which then bled into
// other sources via the settings GET-merge — so a timer configured for one
// source ran on all of them. Read and write must both be source-scoped (the
// per-source helpers deliberately do NOT fall back to global; see #2839).

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

describe('MeshtasticManager - timer trigger result persistence is source-scoped', () => {
  const TRIGGER = {
    id: 'trig-1',
    name: 'Daily ping',
    cronExpression: '0 9 * * *',
    responseType: 'text',
    response: 'hi',
    channel: 0,
    enabled: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes the updated trigger list to the per-source key, not the global key', async () => {
    const manager = new MeshtasticManager('source-b');

    // The source has its own trigger list under source:source-b:timerTriggers.
    vi.mocked(databaseService.settings.getSettingForSource).mockResolvedValue(
      JSON.stringify([TRIGGER]),
    );

    await (manager as any).updateTimerTriggerResult('trig-1', 'success');

    // Read was source-scoped...
    expect(databaseService.settings.getSettingForSource).toHaveBeenCalledWith('source-b', 'timerTriggers');

    // ...and the write MUST be source-scoped too (this is the fix).
    expect(databaseService.settings.setSourceSetting).toHaveBeenCalledTimes(1);
    const [sourceId, key, value] = vi.mocked(databaseService.settings.setSourceSetting).mock.calls[0];
    expect(sourceId).toBe('source-b');
    expect(key).toBe('timerTriggers');
    const persisted = JSON.parse(value);
    expect(persisted[0].lastResult).toBe('success');
    expect(persisted[0].lastRun).toBeGreaterThan(0);

    // It must NOT poison the un-namespaced global key (the original bug).
    expect(databaseService.settings.setSetting).not.toHaveBeenCalledWith(
      'timerTriggers',
      expect.anything(),
    );
  });

  it('records an error result against the per-source key', async () => {
    const manager = new MeshtasticManager('source-a');
    vi.mocked(databaseService.settings.getSettingForSource).mockResolvedValue(
      JSON.stringify([TRIGGER]),
    );

    await (manager as any).updateTimerTriggerResult('trig-1', 'error', 'send failed');

    expect(databaseService.settings.setSourceSetting).toHaveBeenCalledTimes(1);
    const [sourceId, key, value] = vi.mocked(databaseService.settings.setSourceSetting).mock.calls[0];
    expect(sourceId).toBe('source-a');
    expect(key).toBe('timerTriggers');
    const persisted = JSON.parse(value);
    expect(persisted[0].lastResult).toBe('error');
    expect(persisted[0].lastError).toBe('send failed');
    expect(databaseService.settings.setSetting).not.toHaveBeenCalledWith(
      'timerTriggers',
      expect.anything(),
    );
  });
});
