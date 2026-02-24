/**
 * Message Queue Service
 *
 * Manages outgoing automated messages (Auto-Responder and Auto-Acknowledge) with:
 * - Rate limiting (max 1 message per 30 seconds)
 * - Retry logic (up to 3 attempts until ACK received)
 * - Queue processing with proper timing
 */

import { logger } from '../utils/logger.js';

export interface QueuedMessage {
  id: string;
  text: string;
  destination: number; // Node number for DMs, or 0 for channel messages
  channel?: number; // Channel index (0-7) for channel messages, undefined for DMs
  replyId?: number;
  attempts: number;
  maxAttempts: number;
  enqueuedAt: number;
  lastAttemptAt?: number;
  requestId?: number; // The message ID from the last send attempt
  pendingAckSince?: number; // Timestamp when added to pendingAcks (for cleanup)
  onSuccess?: () => void;
  onFailure?: (reason: string) => void;
}

class MessageQueueService {
  private queue: QueuedMessage[] = [];
  private processing = false;
  private lastSendTime = 0;
  private readonly SEND_INTERVAL_MS = 30000; // 30 seconds between sends
  private readonly RETRY_INTERVAL_MS = 30000; // 30 seconds between retry attempts
  private readonly MAX_ATTEMPTS = 3;
  private readonly PENDING_ACK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes - cleanup orphaned ACKs

  // Track pending messages waiting for ACK
  private pendingAcks = new Map<number, QueuedMessage>();

  // Cleanup interval for orphaned ACKs
  private cleanupInterval?: ReturnType<typeof setInterval>;

  // Reference to meshtasticManager for sending messages
  private sendCallback?: (text: string, destination: number, replyId?: number, channel?: number) => Promise<number>;

  /**
   * Set the callback function for sending messages
   * This should be MeshtasticManager.sendTextMessage
   */
  setSendCallback(callback: (text: string, destination: number, replyId?: number, channel?: number) => Promise<number>) {
    this.sendCallback = callback;
  }

  /**
   * Record an external send to update rate limiting
   * Call this after sending a message outside the queue (e.g., tapback)
   * to ensure queued messages respect the send interval
   */
  recordExternalSend() {
    this.lastSendTime = Date.now();
    logger.debug('📝 Recorded external send for rate limiting');
  }

  /**
   * Add a message to the queue
   * For DMs: destination = node number, channel = undefined
   * For channels: destination = 0, channel = channel index (0-7)
   * @param maxAttemptsOverride - Override the default max attempts (1 for channels, 3 for DMs).
   *                              Use 1 to disable retries, or 3 for retry with verification.
   */
  enqueue(text: string, destination: number, replyId?: number, onSuccess?: () => void, onFailure?: (reason: string) => void, channel?: number, maxAttemptsOverride?: number): string {
    const messageId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Channel messages don't support ACKs, so only attempt once
    // For DMs, use override if provided, otherwise default to MAX_ATTEMPTS
    const maxAttempts = maxAttemptsOverride !== undefined
      ? maxAttemptsOverride
      : (channel !== undefined ? 1 : this.MAX_ATTEMPTS);

    const queuedMessage: QueuedMessage = {
      id: messageId,
      text,
      destination,
      channel,
      replyId,
      attempts: 0,
      maxAttempts,
      enqueuedAt: Date.now(),
      onSuccess,
      onFailure
    };

    this.queue.push(queuedMessage);
    const target = channel !== undefined ? `channel ${channel}` : `node !${destination.toString(16).padStart(8, '0')}`;
    logger.info(`📬 Enqueued automated message ${messageId} to ${target} (queue length: ${this.queue.length})`);

    // Start processing if not already running
    if (!this.processing) {
      this.startProcessing();
    }

    return messageId;
  }

  /**
   * Start the queue processing loop
   */
  private startProcessing() {
    if (this.processing) {
      return;
    }

    this.processing = true;
    logger.info('▶️  Started message queue processing');

    // Start cleanup interval if not already running
    if (!this.cleanupInterval) {
      this.startCleanupInterval();
    }

    // Process immediately, then continue with interval
    this.processQueue();
  }

  /**
   * Stop the queue processing loop
   */
  private stopProcessing() {
    this.processing = false;
    logger.info('⏸️  Stopped message queue processing');

    // Stop cleanup interval when processing stops
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
  }

  /**
   * Start periodic cleanup of orphaned pending ACKs
   */
  private startCleanupInterval() {
    // Run cleanup every minute
    this.cleanupInterval = setInterval(() => {
      this.cleanupOrphanedAcks();
    }, 60000);
  }

  /**
   * Clean up pending ACKs that have been waiting too long
   */
  private cleanupOrphanedAcks() {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [requestId, message] of this.pendingAcks.entries()) {
      if (message.pendingAckSince) {
        const age = now - message.pendingAckSince;
        if (age > this.PENDING_ACK_TIMEOUT_MS) {
          logger.warn(`🧹 Cleaning up orphaned ACK for message ${message.id} (requestId: ${requestId}, age: ${Math.round(age / 1000)}s)`);
          this.pendingAcks.delete(requestId);

          // Call failure callback if present with error handling
          if (message.onFailure) {
            try {
              message.onFailure('ACK timeout - no response received');
            } catch (error) {
              logger.error(`Error calling onFailure during cleanup for message ${message.id}:`, error);
            }
          }

          cleanedCount++;
        }
      }
    }

    if (cleanedCount > 0) {
      logger.info(`🧹 Cleaned up ${cleanedCount} orphaned pending ACK(s)`);
    }
  }

  /**
   * Process the queue - send next message if timing allows
   */
  private async processQueue() {
    // Double-check processing flag to prevent race conditions
    if (!this.processing) {
      return;
    }

    try {
      const now = Date.now();
      const timeSinceLastSend = now - this.lastSendTime;

      // Check if we can send (rate limiting)
      if (timeSinceLastSend < this.SEND_INTERVAL_MS && this.lastSendTime > 0) {
        // Wait until we can send, but check processing flag before scheduling
        const waitTime = this.SEND_INTERVAL_MS - timeSinceLastSend;
        logger.debug(`⏳ Rate limit: waiting ${Math.round(waitTime / 1000)}s before next send`);
        setTimeout(() => {
          if (this.processing) {
            this.processQueue();
          }
        }, waitTime);
        return;
      }

      // Check for messages that need retry
      const retryMessage = this.findMessageForRetry(now);
      if (retryMessage) {
        await this.sendMessage(retryMessage);
      } else if (this.queue.length > 0) {
        // Send the next queued message
        const message = this.queue[0];
        await this.sendMessage(message);
      } else if (this.pendingAcks.size === 0) {
        // Queue is empty and no pending ACKs, stop processing
        this.stopProcessing();
        return;
      }

      // Schedule next processing cycle, but check processing flag first
      setTimeout(() => {
        if (this.processing) {
          this.processQueue();
        }
      }, this.SEND_INTERVAL_MS);
    } catch (error) {
      logger.error('❌ Error processing message queue:', error);
      // Continue processing on error, but check processing flag first
      setTimeout(() => {
        if (this.processing) {
          this.processQueue();
        }
      }, this.SEND_INTERVAL_MS);
    }
  }

  /**
   * Find a message that needs retry
   */
  private findMessageForRetry(now: number): QueuedMessage | null {
    for (const message of this.pendingAcks.values()) {
      if (message.attempts < message.maxAttempts) {
        const timeSinceLastAttempt = now - (message.lastAttemptAt || 0);
        if (timeSinceLastAttempt >= this.RETRY_INTERVAL_MS) {
          return message;
        }
      }
    }
    return null;
  }

  /**
   * Send a message
   */
  private async sendMessage(message: QueuedMessage) {
    if (!this.sendCallback) {
      logger.error('❌ No send callback configured for message queue');
      this.failMessage(message, 'No send callback configured');
      return;
    }

    try {
      message.attempts++;
      message.lastAttemptAt = Date.now();

      const attemptInfo = message.attempts > 1 ? ` (attempt ${message.attempts}/${message.maxAttempts})` : '';
      const target = message.channel !== undefined ? `channel ${message.channel}` : `!${message.destination.toString(16).padStart(8, '0')}`;
      logger.info(`📤 Sending queued message ${message.id} to ${target}${attemptInfo}`);

      // Send the message
      const requestId = await this.sendCallback(message.text, message.destination, message.replyId, message.channel);

      // Validate requestId
      if (requestId === undefined || requestId === null || requestId <= 0) {
        throw new Error(`Invalid requestId returned: ${requestId}`);
      }

      message.requestId = requestId;

      // Update last send time
      this.lastSendTime = Date.now();

      // Add to pending ACKs if not at max attempts
      if (message.attempts < message.maxAttempts) {
        message.pendingAckSince = Date.now();
        this.pendingAcks.set(requestId, message);
        logger.debug(`⏳ Waiting for ACK for message ${message.id} (requestId: ${requestId})`);
      } else {
        // Final attempt - remove from queue
        logger.info(`🏁 Final attempt for message ${message.id} - removing from queue`);
        this.removeFromQueue(message);

        // Add to pending ACKs to track success/failure
        message.pendingAckSince = Date.now();
        this.pendingAcks.set(requestId, message);
      }

      // Remove from queue if this was the first attempt
      if (message.attempts === 1) {
        this.removeFromQueue(message);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`❌ Error sending message ${message.id}: ${errorMessage}`);

      // Check if this was the final attempt
      if (message.attempts >= message.maxAttempts) {
        this.failMessage(message, `Send error after ${message.attempts} attempts: ${errorMessage}`);
      } else {
        // Will retry in next cycle - ensure message stays in pendingAcks for retry
        const remainingAttempts = message.maxAttempts - message.attempts;
        logger.info(`🔄 Will retry message ${message.id} (${remainingAttempts} attempt${remainingAttempts === 1 ? '' : 's'} remaining)`);

        // If message has a requestId from a previous attempt, keep it in pendingAcks
        if (message.requestId) {
          message.pendingAckSince = Date.now();
          this.pendingAcks.set(message.requestId, message);
        }
      }
    }
  }

  /**
   * Handle successful ACK receipt
   */
  handleAck(requestId: number) {
    const message = this.pendingAcks.get(requestId);
    if (message) {
      logger.info(`✅ ACK received for message ${message.id} (requestId: ${requestId})`);
      this.pendingAcks.delete(requestId);

      // Call success callback with error handling
      if (message.onSuccess) {
        try {
          message.onSuccess();
        } catch (error) {
          logger.error(`Error calling onSuccess callback for message ${message.id}:`, error);
        }
      }
    }
  }

  /**
   * Handle message failure (routing error or max retries)
   */
  handleFailure(requestId: number, reason: string) {
    const message = this.pendingAcks.get(requestId);
    if (message) {
      logger.warn(`❌ Message ${message.id} failed: ${reason} (requestId: ${requestId})`);
      this.failMessage(message, reason);
    }
  }

  /**
   * Mark message as failed and clean up
   */
  private failMessage(message: QueuedMessage, reason: string) {
    // Remove from queue if still there
    this.removeFromQueue(message);

    // Remove from pending ACKs if there
    if (message.requestId) {
      this.pendingAcks.delete(message.requestId);
    }

    // Call failure callback with error handling
    if (message.onFailure) {
      try {
        message.onFailure(reason);
      } catch (error) {
        logger.error(`Error calling onFailure callback for message ${message.id}:`, error);
      }
    }
  }

  /**
   * Remove message from queue
   */
  private removeFromQueue(message: QueuedMessage) {
    const index = this.queue.findIndex(m => m.id === message.id);
    if (index !== -1) {
      this.queue.splice(index, 1);
      logger.debug(`📭 Removed message ${message.id} from queue (queue length: ${this.queue.length})`);
    }
  }

  /**
   * Get queue status for monitoring
   */
  getStatus() {
    return {
      queueLength: this.queue.length,
      pendingAcks: this.pendingAcks.size,
      processing: this.processing,
      lastSendTime: this.lastSendTime,
      queue: this.queue.map(m => ({
        id: m.id,
        destination: `!${m.destination.toString(16).padStart(8, '0')}`,
        attempts: m.attempts,
        maxAttempts: m.maxAttempts,
        enqueuedAt: m.enqueuedAt,
        lastAttemptAt: m.lastAttemptAt
      })),
      pending: Array.from(this.pendingAcks.entries()).map(([requestId, m]) => ({
        requestId,
        messageId: m.id,
        destination: `!${m.destination.toString(16).padStart(8, '0')}`,
        attempts: m.attempts,
        lastAttemptAt: m.lastAttemptAt
      }))
    };
  }

  /**
   * Clear all pending messages (for testing/cleanup)
   */
  clear() {
    const queueLength = this.queue.length;
    const pendingAcksCount = this.pendingAcks.size;

    // Call onFailure for all pending messages before clearing
    for (const message of this.pendingAcks.values()) {
      if (message.onFailure) {
        try {
          message.onFailure('Queue cleared');
        } catch (error) {
          logger.error(`Error calling onFailure for message ${message.id}:`, error);
        }
      }
    }

    // Call onFailure for all queued messages before clearing
    for (const message of this.queue) {
      if (message.onFailure) {
        try {
          message.onFailure('Queue cleared');
        } catch (error) {
          logger.error(`Error calling onFailure for message ${message.id}:`, error);
        }
      }
    }

    this.queue = [];
    this.pendingAcks.clear();
    this.stopProcessing();

    logger.info(`🧹 Cleared message queue (removed ${queueLength} queued and ${pendingAcksCount} pending messages)`);
  }
}

// Singleton instance
export const messageQueueService = new MessageQueueService();
