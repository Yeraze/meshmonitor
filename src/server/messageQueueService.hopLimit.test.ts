/**
 * MessageQueueService hop-limit override (#5121).
 *
 * A zero-hop send carries no ACK request, so no ACK will ever resolve it. The
 * queue must send it exactly once and report success on handoff — not park it
 * waiting for an ACK and then resend it blind.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockGetSettingForSourceSync } = vi.hoisted(() => ({
  mockGetSettingForSourceSync: vi.fn(),
}));

vi.mock('../services/database.js', () => ({
  default: { getSettingForSourceSync: mockGetSettingForSourceSync },
}));

import { messageQueueService } from './messageQueueService.js';

describe('MessageQueueService hop-limit override (#5121)', () => {
  let sendCallback: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockGetSettingForSourceSync.mockReset();
    mockGetSettingForSourceSync.mockReturnValue(null);
    messageQueueService.clear();
    let requestId = 5000;
    sendCallback = vi.fn(async () => requestId++);
    messageQueueService.setSendCallback(sendCallback as never);
  });

  afterEach(() => {
    messageQueueService.clear();
    vi.useRealTimers();
  });

  it('passes the override through to the send callback', async () => {
    messageQueueService.enqueue('hi', 0, undefined, undefined, undefined, 2, 1, undefined, 1);
    await vi.advanceTimersByTimeAsync(10);
    expect(sendCallback).toHaveBeenCalledTimes(1);
    // (text, destination, replyId, channel, emoji, hopLimitOverride)
    expect(sendCallback.mock.calls[0]).toEqual(['hi', 0, undefined, 2, undefined, 1]);
  });

  it('passes undefined when no override is set, so existing sends are unchanged', async () => {
    messageQueueService.enqueue('hi', 0, undefined, undefined, undefined, 2, 1);
    await vi.advanceTimersByTimeAsync(10);
    expect(sendCallback.mock.calls[0][5]).toBeUndefined();
  });

  it('sends a zero-hop DM once and reports success without waiting for an ACK', async () => {
    const onSuccess = vi.fn();
    const onFailure = vi.fn();
    // A DM that would otherwise get 3 attempts.
    messageQueueService.enqueue('hi', 0x1234, undefined, onSuccess, onFailure, undefined, 3, undefined, 0);
    await vi.advanceTimersByTimeAsync(10);

    expect(sendCallback).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onFailure).not.toHaveBeenCalled();

    // Well past the 90s retry interval and the 5-minute orphan sweep: no
    // resend, and no late failure report.
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(sendCallback).toHaveBeenCalledTimes(1);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('still retries a nonzero-override DM that never gets an ACK', async () => {
    messageQueueService.enqueue('hi', 0x1234, undefined, undefined, undefined, undefined, 2, undefined, 2);
    await vi.advanceTimersByTimeAsync(10);
    expect(sendCallback).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    expect(sendCallback).toHaveBeenCalledTimes(2);
  });
});
