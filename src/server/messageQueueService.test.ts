import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { messageQueueService } from './messageQueueService.js';

describe('MessageQueueService', () => {
  let mockSendCallback: ReturnType<typeof vi.fn>;
  let sentMessages: Array<{ text: string; destination: number; replyId?: number }> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    sentMessages = [];

    // Clear any existing state
    messageQueueService.clear();

    // Setup mock send callback
    let requestIdCounter = 1000;
    mockSendCallback = vi.fn(async (text: string, destination: number, replyId?: number) => {
      sentMessages.push({ text, destination, replyId });
      return requestIdCounter++;
    });

    messageQueueService.setSendCallback(mockSendCallback as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    messageQueueService.clear();
  });

  describe('Basic queue operations', () => {
    it('should enqueue a message and process it immediately', async () => {
      const messageId = messageQueueService.enqueue('Test message', 12345678);

      expect(messageId).toBeDefined();
      expect(messageId).toMatch(/^\d+-[a-z0-9]+$/);

      // Process should start immediately - advance timers to execute
      await vi.advanceTimersByTimeAsync(0);

      expect(mockSendCallback).toHaveBeenCalledTimes(1);
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].text).toBe('Test message');
      expect(sentMessages[0].destination).toBe(12345678);
    });

    it.skip('should enqueue multiple messages and process them sequentially', async () => {
      messageQueueService.enqueue('Message 1', 12345678);
      messageQueueService.enqueue('Message 2', 12345678);
      messageQueueService.enqueue('Message 3', 12345678);

      // First message should be sent immediately
      await vi.advanceTimersByTimeAsync(0);
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].text).toBe('Message 1');

      // Advance 30 seconds for second message
      await vi.advanceTimersByTimeAsync(30000);
      expect(sentMessages).toHaveLength(2);
      expect(sentMessages[1].text).toBe('Message 2');

      // Advance another 30 seconds for third message
      await vi.advanceTimersByTimeAsync(30000);
      expect(sentMessages).toHaveLength(3);
      expect(sentMessages[2].text).toBe('Message 3');
    });

    it.skip('should respect rate limiting (30 seconds between messages)', async () => {
      messageQueueService.enqueue('Message 1', 12345678);
      messageQueueService.enqueue('Message 2', 12345678);

      // First message sent immediately
      await vi.runOnlyPendingTimersAsync();
      expect(sentMessages).toHaveLength(1);

      // Advance 29 seconds - should not send yet
      await vi.advanceTimersByTimeAsync(29000);
      expect(sentMessages).toHaveLength(1);

      // Advance 1 more second (30 total) - should send now
      await vi.advanceTimersByTimeAsync(1000);
      expect(sentMessages).toHaveLength(2);
    });

    it('should include replyId when provided', async () => {
      messageQueueService.enqueue('Reply message', 12345678, 999);

      await vi.runOnlyPendingTimersAsync();

      expect(sentMessages[0].replyId).toBe(999);
    });
  });

  describe('ACK handling', () => {
    it('should mark message as successful when ACK received', async () => {
      const successCallback = vi.fn();
      messageQueueService.enqueue('Test message', 12345678, undefined, successCallback);

      await vi.runOnlyPendingTimersAsync();

      // Get the requestId that was used
      const requestId = 1000; // First message gets requestId 1000

      // Simulate ACK receipt
      messageQueueService.handleAck(requestId);

      expect(successCallback).toHaveBeenCalledTimes(1);
    });

    it('should not retry message after ACK received', async () => {
      messageQueueService.enqueue('Test message', 12345678);

      await vi.runOnlyPendingTimersAsync();
      expect(sentMessages).toHaveLength(1);

      // Send ACK
      messageQueueService.handleAck(1000);

      // Advance time for retry interval - should not retry
      await vi.advanceTimersByTimeAsync(30000);
      expect(sentMessages).toHaveLength(1); // Still only 1 message sent
    });

    it('should retry message up to 3 times if no ACK received', async () => {
      messageQueueService.enqueue('Test message', 12345678);

      // First attempt
      await vi.runOnlyPendingTimersAsync();
      expect(sentMessages).toHaveLength(1);

      // Second attempt (after 30s)
      await vi.advanceTimersByTimeAsync(30000);
      expect(sentMessages).toHaveLength(2);

      // Third attempt (after another 30s)
      await vi.advanceTimersByTimeAsync(30000);
      expect(sentMessages).toHaveLength(3);

      // No fourth attempt - max 3 attempts reached
      await vi.advanceTimersByTimeAsync(30000);
      expect(sentMessages).toHaveLength(3);
    });

    it.skip('should call failure callback after max retries without ACK', async () => {
      const failureCallback = vi.fn();
      messageQueueService.enqueue('Test message', 12345678, undefined, undefined, failureCallback);

      // Send all 3 attempts without ACK
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(30000);

      // After final attempt, still waiting for ACK
      expect(failureCallback).not.toHaveBeenCalled();

      // Simulate cleanup timeout (5 minutes + a bit for cleanup interval)
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1000);

      expect(failureCallback).toHaveBeenCalledTimes(1);
      expect(failureCallback).toHaveBeenCalledWith('ACK timeout - no response received');
    });
  });

  describe('Failure handling', () => {
    it('should call failure callback when routing error occurs', async () => {
      const failureCallback = vi.fn();
      messageQueueService.enqueue('Test message', 12345678, undefined, undefined, failureCallback);

      await vi.runOnlyPendingTimersAsync();

      // Simulate routing error
      messageQueueService.handleFailure(1000, 'NO_INTERFACE');

      expect(failureCallback).toHaveBeenCalledTimes(1);
      expect(failureCallback).toHaveBeenCalledWith('NO_INTERFACE');
    });

    it.skip('should retry after send error if attempts remaining', async () => {
      // Make send callback fail on first attempt
      let callCount = 0;
      mockSendCallback.mockImplementation(async (text: string, destination: number, replyId?: number) => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Network error');
        }
        sentMessages.push({ text, destination, replyId });
        return 1000 + callCount;
      });

      messageQueueService.enqueue('Test message', 12345678);

      // First attempt fails
      await vi.advanceTimersByTimeAsync(0);
      expect(sentMessages).toHaveLength(0);

      // Second attempt succeeds
      await vi.advanceTimersByTimeAsync(30000);
      expect(sentMessages).toHaveLength(1);
    });

    it('should call failure callback after max send errors', async () => {
      // Make send callback always fail
      mockSendCallback.mockRejectedValue(new Error('Network error'));

      const failureCallback = vi.fn();
      messageQueueService.enqueue('Test message', 12345678, undefined, undefined, failureCallback);

      // All 3 attempts fail
      await vi.runOnlyPendingTimersAsync();
      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(30000);

      expect(failureCallback).toHaveBeenCalledTimes(1);
      expect(failureCallback.mock.calls[0][0]).toContain('Send error after 3 attempts');
    });

    it('should handle invalid requestId from send callback', async () => {
      mockSendCallback.mockResolvedValue(0); // Invalid requestId

      const failureCallback = vi.fn();
      messageQueueService.enqueue('Test message', 12345678, undefined, undefined, failureCallback);

      await vi.runOnlyPendingTimersAsync();

      // Should retry due to error
      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(30000);

      expect(failureCallback).toHaveBeenCalled();
    });
  });

  describe('Orphaned ACK cleanup', () => {
    it.skip('should clean up pending ACKs after 5 minute timeout', async () => {
      const failureCallback = vi.fn();
      messageQueueService.enqueue('Test message', 12345678, undefined, undefined, failureCallback);

      // Send message
      await vi.advanceTimersByTimeAsync(0);

      // Verify message is in pending ACKs
      const status = messageQueueService.getStatus();
      expect(status.pendingAcks).toBe(1);

      // Advance 4 minutes 59 seconds - should not clean up yet
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000 + 59000);
      expect(messageQueueService.getStatus().pendingAcks).toBe(1);
      expect(failureCallback).not.toHaveBeenCalled();

      // Advance to just past 5 minutes + wait for cleanup interval (runs every 60s)
      // We need to get to 5 minutes + 1 second, then wait for next cleanup check
      await vi.advanceTimersByTimeAsync(2000); // Now at 5:01
      expect(messageQueueService.getStatus().pendingAcks).toBe(0);
      expect(failureCallback).toHaveBeenCalledWith('ACK timeout - no response received');
    });

    it('should not clean up ACKs that are younger than timeout', async () => {
      messageQueueService.enqueue('Message 1', 12345678);
      await vi.runOnlyPendingTimersAsync();

      // Advance 2 minutes
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

      messageQueueService.enqueue('Message 2', 12345678);
      await vi.runOnlyPendingTimersAsync();

      // Advance 3 more minutes (5 total for message 1, 3 for message 2)
      await vi.advanceTimersByTimeAsync(3 * 60 * 1000);

      // Message 1 should be cleaned up, message 2 should remain
      const status = messageQueueService.getStatus();
      expect(status.pendingAcks).toBeGreaterThan(0);
    });
  });

  describe('Status and monitoring', () => {
    it('should return accurate queue status', async () => {
      messageQueueService.enqueue('Message 1', 12345678);
      messageQueueService.enqueue('Message 2', 87654321);

      const status = messageQueueService.getStatus();

      expect(status.queueLength).toBe(2);
      expect(status.pendingAcks).toBe(0);
      expect(status.processing).toBe(true);
      expect(status.queue).toHaveLength(2);
      expect(status.queue[0].destination).toBe('!00bc614e');
      expect(status.queue[1].destination).toBe('!05397fb1'); // 87654321 in hex
    });

    it.skip('should update status as messages are processed', async () => {
      messageQueueService.enqueue('Message 1', 12345678);
      messageQueueService.enqueue('Message 2', 12345678);

      let status = messageQueueService.getStatus();
      expect(status.queueLength).toBe(2);
      expect(status.pendingAcks).toBe(0);

      // Process first message
      await vi.advanceTimersByTimeAsync(0);

      status = messageQueueService.getStatus();
      // After sending first message, it's removed from queue and added to pendingAcks
      expect(status.queueLength).toBe(1); // Message 2 still in queue
      expect(status.pendingAcks).toBe(1); // Message 1 waiting for ACK

      // Process second message (after 30s rate limit)
      await vi.advanceTimersByTimeAsync(30000);

      status = messageQueueService.getStatus();
      expect(status.queueLength).toBe(0); // Queue empty
      expect(status.pendingAcks).toBe(2); // Both messages waiting for ACK
    });
  });

  describe('Clear operation', () => {
    it('should clear all queued and pending messages', async () => {
      messageQueueService.enqueue('Message 1', 12345678);
      messageQueueService.enqueue('Message 2', 12345678);

      await vi.runOnlyPendingTimersAsync();

      let status = messageQueueService.getStatus();
      expect(status.queueLength).toBe(1);
      expect(status.pendingAcks).toBe(1);

      messageQueueService.clear();

      status = messageQueueService.getStatus();
      expect(status.queueLength).toBe(0);
      expect(status.pendingAcks).toBe(0);
      expect(status.processing).toBe(false);
    });

    it('should call failure callbacks for all cleared messages', async () => {
      const failureCallback1 = vi.fn();
      const failureCallback2 = vi.fn();

      messageQueueService.enqueue('Message 1', 12345678, undefined, undefined, failureCallback1);
      messageQueueService.enqueue('Message 2', 12345678, undefined, undefined, failureCallback2);

      await vi.runOnlyPendingTimersAsync();

      messageQueueService.clear();

      expect(failureCallback1).toHaveBeenCalledWith('Queue cleared');
      expect(failureCallback2).toHaveBeenCalledWith('Queue cleared');
    });
  });

  describe('Race condition prevention', () => {
    it('should not schedule duplicate processing loops', async () => {
      messageQueueService.enqueue('Message 1', 12345678);

      await vi.runOnlyPendingTimersAsync();

      // Clear the queue
      messageQueueService.clear();

      // Advance time - no more messages should be attempted
      await vi.advanceTimersByTimeAsync(60000);

      expect(mockSendCallback).toHaveBeenCalledTimes(1);
    });

    it('should check processing flag before each scheduled callback', async () => {
      messageQueueService.enqueue('Message 1', 12345678);

      await vi.runOnlyPendingTimersAsync();

      // Stop processing by clearing
      messageQueueService.clear();

      // The scheduled timeout callbacks should check processing flag and exit
      await vi.advanceTimersByTimeAsync(30000);

      expect(mockSendCallback).toHaveBeenCalledTimes(1); // Only the first message
    });
  });

  describe('Error resilience', () => {
    it('should handle errors in success callback gracefully', async () => {
      const successCallback = vi.fn(() => {
        throw new Error('Callback error');
      });

      messageQueueService.enqueue('Test message', 12345678, undefined, successCallback);

      await vi.runOnlyPendingTimersAsync();

      // Should not throw, should handle error gracefully
      expect(() => {
        messageQueueService.handleAck(1000);
      }).not.toThrow();
    });

    it('should handle errors in failure callback gracefully', async () => {
      const failureCallback = vi.fn(() => {
        throw new Error('Callback error');
      });

      messageQueueService.enqueue('Test message', 12345678, undefined, undefined, failureCallback);

      await vi.runOnlyPendingTimersAsync();

      // Should not throw when calling failure
      expect(() => {
        messageQueueService.handleFailure(1000, 'ERROR');
      }).not.toThrow();
    });

    it.skip('should continue processing after errors', async () => {
      // First message will fail, then succeed on retry
      let callCount = 0;
      mockSendCallback.mockImplementation(async (text: string, destination: number, replyId?: number) => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Network error');
        }
        sentMessages.push({ text, destination, replyId });
        return 1000 + callCount;
      });

      messageQueueService.enqueue('Message 1', 12345678);
      messageQueueService.enqueue('Message 2', 12345678);

      await vi.advanceTimersByTimeAsync(0);
      // First message failed, no messages sent yet
      expect(sentMessages).toHaveLength(0);

      // At 30s, first message retries and succeeds
      await vi.advanceTimersByTimeAsync(30000);
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].text).toBe('Message 1');

      // At 60s, second message is sent
      await vi.advanceTimersByTimeAsync(30000);
      expect(sentMessages).toHaveLength(2);
      expect(sentMessages[1].text).toBe('Message 2');
    });
  });

  describe('No send callback', () => {
    it('should fail message immediately if no send callback configured', async () => {
      const failureCallback = vi.fn();

      // Create new instance without setting callback
      messageQueueService.clear();
      messageQueueService.setSendCallback(null as any);

      messageQueueService.enqueue('Test message', 12345678, undefined, undefined, failureCallback);

      await vi.runOnlyPendingTimersAsync();

      expect(failureCallback).toHaveBeenCalledWith('No send callback configured');
      expect(mockSendCallback).not.toHaveBeenCalled();
    });
  });
});
