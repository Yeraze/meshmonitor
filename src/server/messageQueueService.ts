/**
 * Message Queue Service
 *
 * Manages outgoing auto-responder messages with:
 * - Rate limiting (max 1 message per 30 seconds)
 * - Retry logic (up to 3 attempts until ACK received)
 * - Queue processing with proper timing
 */

import { logger } from '../utils/logger.js';

export interface QueuedMessage {
  id: string;
  text: string;
  destination: number;
  replyId?: number;
  attempts: number;
  maxAttempts: number;
  enqueuedAt: number;
  lastAttemptAt?: number;
  requestId?: number; // The message ID from the last send attempt
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

  // Track pending messages waiting for ACK
  private pendingAcks = new Map<number, QueuedMessage>();

  // Reference to meshtasticManager for sending messages
  private sendCallback?: (text: string, destination: number, replyId?: number) => Promise<number>;

  /**
   * Set the callback function for sending messages
   * This should be MeshtasticManager.sendTextMessage
   */
  setSendCallback(callback: (text: string, destination: number, replyId?: number) => Promise<number>) {
    this.sendCallback = callback;
  }

  /**
   * Add a message to the queue
   */
  enqueue(text: string, destination: number, replyId?: number, onSuccess?: () => void, onFailure?: (reason: string) => void): string {
    const messageId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const queuedMessage: QueuedMessage = {
      id: messageId,
      text,
      destination,
      replyId,
      attempts: 0,
      maxAttempts: this.MAX_ATTEMPTS,
      enqueuedAt: Date.now(),
      onSuccess,
      onFailure
    };

    this.queue.push(queuedMessage);
    logger.info(`📬 Enqueued auto-responder message ${messageId} (queue length: ${this.queue.length})`);

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

    // Process immediately, then continue with interval
    this.processQueue();
  }

  /**
   * Stop the queue processing loop
   */
  private stopProcessing() {
    this.processing = false;
    logger.info('⏸️  Stopped message queue processing');
  }

  /**
   * Process the queue - send next message if timing allows
   */
  private async processQueue() {
    if (!this.processing) {
      return;
    }

    try {
      const now = Date.now();
      const timeSinceLastSend = now - this.lastSendTime;

      // Check if we can send (rate limiting)
      if (timeSinceLastSend < this.SEND_INTERVAL_MS && this.lastSendTime > 0) {
        // Wait until we can send
        const waitTime = this.SEND_INTERVAL_MS - timeSinceLastSend;
        logger.debug(`⏳ Rate limit: waiting ${Math.round(waitTime / 1000)}s before next send`);
        setTimeout(() => this.processQueue(), waitTime);
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

      // Schedule next processing cycle
      setTimeout(() => this.processQueue(), this.SEND_INTERVAL_MS);
    } catch (error) {
      logger.error('❌ Error processing message queue:', error);
      // Continue processing on error
      setTimeout(() => this.processQueue(), this.SEND_INTERVAL_MS);
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
      logger.info(`📤 Sending queued message ${message.id} to !${message.destination.toString(16).padStart(8, '0')}${attemptInfo}`);

      // Send the message
      const requestId = await this.sendCallback(message.text, message.destination, message.replyId);
      message.requestId = requestId;

      // Update last send time
      this.lastSendTime = Date.now();

      // Add to pending ACKs if not at max attempts
      if (message.attempts < message.maxAttempts) {
        this.pendingAcks.set(requestId, message);
        logger.debug(`⏳ Waiting for ACK for message ${message.id} (requestId: ${requestId})`);
      } else {
        // Final attempt - remove from queue
        logger.info(`🏁 Final attempt for message ${message.id} - removing from queue`);
        this.removeFromQueue(message);

        // Add to pending ACKs to track success/failure
        this.pendingAcks.set(requestId, message);
      }

      // Remove from queue if this was the first attempt
      if (message.attempts === 1) {
        this.removeFromQueue(message);
      }
    } catch (error) {
      logger.error(`❌ Error sending message ${message.id}:`, error);

      if (message.attempts >= message.maxAttempts) {
        this.failMessage(message, `Send error: ${error}`);
      } else {
        // Will retry in next cycle
        logger.info(`🔄 Will retry message ${message.id} (${message.maxAttempts - message.attempts} attempts remaining)`);
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

      if (message.onSuccess) {
        message.onSuccess();
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

    if (message.onFailure) {
      message.onFailure(reason);
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
    this.queue = [];
    this.pendingAcks.clear();
    this.stopProcessing();
    logger.info('🧹 Cleared message queue');
  }
}

// Singleton instance
export const messageQueueService = new MessageQueueService();
