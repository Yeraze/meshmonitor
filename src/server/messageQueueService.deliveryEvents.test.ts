/**
 * MessageQueueService delivery-diagnostics event-timeline recording
 * (#4816 Phase 3 WP2a): 'retry' on a resend, 'timeout' on the orphaned-ack
 * cleanup path.
 *
 * Unlike messageQueueService.test.ts (which exercises the legacy singleton,
 * constructed with sourceId=null — the events-recording branches are gated
 * on a real sourceId), these tests construct a per-source instance directly,
 * matching how MeshtasticManager actually wires it up
 * (`new MessageQueueService(this.sourceId)`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockGetSettingForSourceSync, mockGetMessageByRequestIdAsync, mockRecordEvent } = vi.hoisted(() => ({
  mockGetSettingForSourceSync: vi.fn(),
  mockGetMessageByRequestIdAsync: vi.fn(),
  mockRecordEvent: vi.fn(),
}));

vi.mock('../services/database.js', () => ({
  default: {
    getSettingForSourceSync: mockGetSettingForSourceSync,
    getMessageByRequestIdAsync: mockGetMessageByRequestIdAsync,
    messageEvents: {
      recordEvent: mockRecordEvent,
    },
  },
}));

import { MessageQueueService } from './messageQueueService.js';

const SOURCE_ID = 'src-under-test';

describe('MessageQueueService - delivery-diagnostics event recording (#4816 Phase 3)', () => {
  let queue: MessageQueueService;
  let mockSendCallback: ReturnType<typeof vi.fn>;
  let requestIdCounter: number;

  beforeEach(() => {
    vi.useFakeTimers();
    mockGetSettingForSourceSync.mockReset().mockReturnValue(null);
    mockGetMessageByRequestIdAsync.mockReset();
    mockRecordEvent.mockReset().mockResolvedValue(undefined);

    requestIdCounter = 1000;
    mockSendCallback = vi.fn(async () => requestIdCounter++);

    queue = new MessageQueueService(SOURCE_ID);
    queue.setSendCallback(mockSendCallback as any);
  });

  afterEach(() => {
    queue.clear();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('does NOT record a retry event on the first (non-retry) attempt', async () => {
    mockGetMessageByRequestIdAsync.mockResolvedValue({ id: 'msg-1' });
    queue.enqueue('hello', 0x11223344);

    await vi.advanceTimersByTimeAsync(0); // attempt 1

    expect(mockSendCallback).toHaveBeenCalledTimes(1);
    expect(mockRecordEvent).not.toHaveBeenCalled();
  });

  it('records a retry event with the correct attempt number on resend', async () => {
    mockGetMessageByRequestIdAsync.mockImplementation(async (requestId: number) => ({
      id: `msg-for-${requestId}`,
    }));
    queue.enqueue('hello', 0x11223344);

    await vi.advanceTimersByTimeAsync(0);      // attempt 1 (requestId 1000) - no retry event
    await vi.advanceTimersByTimeAsync(90000);  // attempt 2 (requestId 1001) - retry event, attempt=2

    expect(mockSendCallback).toHaveBeenCalledTimes(2);
    expect(mockRecordEvent).toHaveBeenCalledTimes(1);
    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: SOURCE_ID,
        messageId: 'msg-for-1001',
        eventType: 'retry',
        provenance: 'observed',
        detail: JSON.stringify({ attempt: 2 }),
      }),
    );
  });

  it('a recordEvent throw during retry does not break the resend path', async () => {
    mockGetMessageByRequestIdAsync.mockResolvedValue({ id: 'msg-1' });
    mockRecordEvent.mockRejectedValue(new Error('db unavailable'));
    queue.enqueue('hello', 0x11223344);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(90000);

    // Second send still happened despite the diagnostics failure.
    expect(mockSendCallback).toHaveBeenCalledTimes(2);
  });

  it('records a timeout event when the ack-wait window is orphaned', async () => {
    mockGetMessageByRequestIdAsync.mockResolvedValue({ id: 'msg-timeout-1' });
    const failureCallback = vi.fn();
    queue.enqueue('hello', 0x11223344, undefined, undefined, failureCallback);

    // Exhaust all 3 attempts (T, T+90s, T+180s), then wait past the 5-minute
    // orphan cleanup window (cleanup runs every 60s).
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(90000);
    await vi.advanceTimersByTimeAsync(90000);
    expect(failureCallback).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(360000);

    expect(failureCallback).toHaveBeenCalledWith('ACK timeout - no response received');
    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: SOURCE_ID,
        messageId: 'msg-timeout-1',
        eventType: 'timeout',
        provenance: 'inferred',
      }),
    );
  });

  it('a recordEvent throw during timeout cleanup does not suppress the failure callback', async () => {
    mockGetMessageByRequestIdAsync.mockResolvedValue({ id: 'msg-timeout-2' });
    mockRecordEvent.mockRejectedValue(new Error('db unavailable'));
    const failureCallback = vi.fn();
    queue.enqueue('hello', 0x11223344, undefined, undefined, failureCallback);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(90000);
    await vi.advanceTimersByTimeAsync(90000);
    await vi.advanceTimersByTimeAsync(360000);

    expect(failureCallback).toHaveBeenCalledWith('ACK timeout - no response received');
  });

  it('does not record a retry/timeout event when resolving the message row fails', async () => {
    mockGetMessageByRequestIdAsync.mockResolvedValue(null); // no matching row
    queue.enqueue('hello', 0x11223344);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(90000);

    expect(mockRecordEvent).not.toHaveBeenCalled();
  });
});
