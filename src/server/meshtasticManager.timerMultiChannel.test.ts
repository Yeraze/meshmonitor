/**
 * Meshtastic Timer Triggers — multi-channel send (#6230).
 *
 * A timer can target several channels. The dispatch enqueues one automation
 * send per channel; the message queue (SEND_INTERVAL_MS) spaces every send, so
 * a multi-channel timer never bursts — the existing per-source TX gap is reused
 * and no new cadence is added. These tests assert one enqueue per channel (the
 * spacing is the queue's, not a direct `sendTextMessage` burst) and that the
 * "no mesh output" (none) choice still sends nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MeshtasticManager } from './meshtasticManager.js';
import databaseService from '../services/database.js';

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

const { enqueueMock } = vi.hoisted(() => ({ enqueueMock: vi.fn() }));
vi.mock('./messageQueueService.js', () => {
  const mockInstance = {
    enqueue: enqueueMock,
    setSendCallback: vi.fn(),
    clear: vi.fn(),
    getStatus: vi.fn(() => ({ queueLength: 0, pendingAcks: 0, processing: false })),
  };
  function MessageQueueService() { return mockInstance as any; }
  return { messageQueueService: mockInstance, MessageQueueService };
});

// The channel argument enqueue() receives (6th positional arg, index 5).
const enqueuedChannels = () => enqueueMock.mock.calls.map((c) => c[5]);

describe('MeshtasticManager timer multi-channel text (#6230)', () => {
  let manager: MeshtasticManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new MeshtasticManager('src-timer');
    // Token expansion and send-callback both touch the device/DB; stub the
    // token pass so the test exercises only the per-channel enqueue loop.
    (manager as any).replaceAnnouncementTokens = vi.fn(async (m: string) => m);
  });

  it('enqueues one send per channel, not one direct broadcast', async () => {
    const sendSpy = vi.spyOn(manager, 'sendTextMessage');
    await (manager as any).executeTimerTextMessage('t1', 'Daily', 'hello', [0, 2]);

    // Two queue items (spaced by the queue), and never a direct send that would
    // bypass the per-source TX gap.
    expect(enqueueMock).toHaveBeenCalledTimes(2);
    expect(enqueuedChannels()).toEqual([0, 2]);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('reuses the queue for three channels', async () => {
    await (manager as any).executeTimerTextMessage('t1', 'Daily', 'hello', [0, 1, 7]);
    expect(enqueueMock).toHaveBeenCalledTimes(3);
    expect(enqueuedChannels()).toEqual([0, 1, 7]);
  });

  it('sends a single channel exactly once (back-compat)', async () => {
    await (manager as any).executeTimerTextMessage('t1', 'Daily', 'hello', [3]);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueuedChannels()).toEqual([3]);
  });

  it('drops a defensive none and sends nothing when only none is present', async () => {
    await (manager as any).executeTimerTextMessage('t1', 'Daily', 'hello', ['none']);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('marks the run successful via the per-source key', async () => {
    vi.mocked(databaseService.settings.getSettingForSource).mockResolvedValue(
      JSON.stringify([{ id: 't1', name: 'Daily', cronExpression: '* * * * *', channels: [0, 2], enabled: true }]),
    );
    await (manager as any).executeTimerTextMessage('t1', 'Daily', 'hello', [0, 2]);
    expect(databaseService.settings.setSourceSetting).toHaveBeenCalledWith('src-timer', 'timerTriggers', expect.any(String));
  });
});
