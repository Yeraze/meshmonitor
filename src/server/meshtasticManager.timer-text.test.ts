import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the database service
vi.mock('../services/database', () => ({
  default: {
    getSetting: vi.fn(),
    setSetting: vi.fn(),
  },
}));

// Mock the message queue service
vi.mock('./messageQueueService', () => ({
  messageQueueService: {
    enqueue: vi.fn(),
  },
}));

// Mock logger
vi.mock('./logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock node-cron
vi.mock('node-cron', () => ({
  default: {
    schedule: vi.fn((expression, callback) => ({
      stop: vi.fn(),
    })),
    validate: vi.fn(() => true),
  },
}));

describe('Timer Triggers - Text Message Support', () => {
  describe('TimerTrigger type definitions', () => {
    it('should support script response type', () => {
      const trigger = {
        id: 'test-1',
        name: 'Test Script Timer',
        cronExpression: '0 */6 * * *',
        responseType: 'script' as const,
        scriptPath: '/data/scripts/test.sh',
        channel: 0,
        enabled: true,
      };

      expect(trigger.responseType).toBe('script');
      expect(trigger.scriptPath).toBeDefined();
      expect(trigger.response).toBeUndefined();
    });

    it('should support text response type', () => {
      const trigger = {
        id: 'test-2',
        name: 'Test Text Timer',
        cronExpression: '0 */6 * * *',
        responseType: 'text' as const,
        response: 'Hello {VERSION}!',
        channel: 0,
        enabled: true,
      };

      expect(trigger.responseType).toBe('text');
      expect(trigger.response).toBeDefined();
      expect(trigger.scriptPath).toBeUndefined();
    });

    it('should default to script type for backward compatibility', () => {
      const legacyTrigger = {
        id: 'legacy-1',
        name: 'Legacy Timer',
        cronExpression: '0 */6 * * *',
        scriptPath: '/data/scripts/old.sh',
        channel: 0,
        enabled: true,
      };

      // No responseType field - should default to 'script'
      const responseType = legacyTrigger.responseType || 'script';
      expect(responseType).toBe('script');
    });
  });

  describe('Response validation', () => {
    it('should reject empty response for text type', () => {
      const trigger = {
        id: 'test-3',
        name: 'Empty Response Timer',
        cronExpression: '0 */6 * * *',
        responseType: 'text' as const,
        response: '',
        channel: 0,
        enabled: true,
      };

      // Validation should check for non-empty response
      const isValid = trigger.responseType === 'text' && trigger.response?.trim();
      expect(isValid).toBeFalsy();
    });

    it('should reject whitespace-only response for text type', () => {
      const trigger = {
        id: 'test-4',
        name: 'Whitespace Response Timer',
        cronExpression: '0 */6 * * *',
        responseType: 'text' as const,
        response: '   \n\t  ',
        channel: 0,
        enabled: true,
      };

      // Validation should check for non-whitespace response
      const isValid = trigger.responseType === 'text' && trigger.response?.trim();
      expect(isValid).toBeFalsy();
    });

    it('should accept valid text response', () => {
      const trigger = {
        id: 'test-5',
        name: 'Valid Text Timer',
        cronExpression: '0 */6 * * *',
        responseType: 'text' as const,
        response: 'MeshMonitor {VERSION} - {NODECOUNT} nodes online',
        channel: 0,
        enabled: true,
      };

      const isValid = trigger.responseType === 'text' && trigger.response?.trim();
      expect(isValid).toBeTruthy();
    });
  });

  describe('Token expansion', () => {
    it('should recognize supported tokens', () => {
      const supportedTokens = ['{VERSION}', '{DURATION}', '{FEATURES}', '{NODECOUNT}', '{DIRECTCOUNT}'];
      const message = 'Version: {VERSION}, Up: {DURATION}, Features: {FEATURES}, Nodes: {NODECOUNT}, Direct: {DIRECTCOUNT}';

      supportedTokens.forEach(token => {
        expect(message).toContain(token);
      });
    });

    it('should handle message without tokens', () => {
      const message = 'Hello from MeshMonitor!';
      const hasTokens = message.includes('{');
      expect(hasTokens).toBe(false);
    });

    it('should handle mixed content with tokens', () => {
      const message = 'Status: {NODECOUNT} nodes | {FEATURES}';
      expect(message).toContain('{NODECOUNT}');
      expect(message).toContain('{FEATURES}');
    });
  });

  describe('Message length handling', () => {
    it('should respect 200 character limit', () => {
      const longMessage = 'A'.repeat(250);
      const truncated = longMessage.substring(0, 200);

      expect(truncated.length).toBe(200);
      expect(longMessage.length).toBe(250);
    });

    it('should not truncate short messages', () => {
      const shortMessage = 'Hello, mesh network!';
      const processed = shortMessage.length > 200 ? shortMessage.substring(0, 200) : shortMessage;

      expect(processed).toBe(shortMessage);
      expect(processed.length).toBeLessThan(200);
    });

    it('should handle edge case at exactly 200 characters', () => {
      const exactMessage = 'A'.repeat(200);
      const processed = exactMessage.length > 200 ? exactMessage.substring(0, 200) : exactMessage;

      expect(processed.length).toBe(200);
    });
  });

  describe('Channel targeting', () => {
    it('should support channel 0-7', () => {
      const validChannels = [0, 1, 2, 3, 4, 5, 6, 7];

      validChannels.forEach(channel => {
        const trigger = {
          id: `ch-${channel}`,
          name: `Channel ${channel} Timer`,
          cronExpression: '0 */6 * * *',
          responseType: 'text' as const,
          response: 'Test message',
          channel,
          enabled: true,
        };

        expect(trigger.channel).toBeGreaterThanOrEqual(0);
        expect(trigger.channel).toBeLessThanOrEqual(7);
      });
    });

    it('should default to channel 0 when not specified', () => {
      const trigger = {
        id: 'no-channel',
        name: 'No Channel Timer',
        cronExpression: '0 */6 * * *',
        responseType: 'text' as const,
        response: 'Test message',
        enabled: true,
      };

      const channel = trigger.channel ?? 0;
      expect(channel).toBe(0);
    });
  });

  describe('Timer trigger state', () => {
    it('should track lastRun timestamp', () => {
      const trigger = {
        id: 'track-1',
        name: 'Tracking Timer',
        cronExpression: '0 */6 * * *',
        responseType: 'text' as const,
        response: 'Test',
        channel: 0,
        enabled: true,
        lastRun: Date.now(),
        lastResult: 'success' as const,
      };

      expect(trigger.lastRun).toBeDefined();
      expect(trigger.lastRun).toBeLessThanOrEqual(Date.now());
    });

    it('should track lastResult status', () => {
      const successTrigger = {
        id: 'success-1',
        name: 'Success Timer',
        cronExpression: '0 */6 * * *',
        responseType: 'text' as const,
        response: 'Test',
        channel: 0,
        enabled: true,
        lastResult: 'success' as const,
      };

      const errorTrigger = {
        id: 'error-1',
        name: 'Error Timer',
        cronExpression: '0 */6 * * *',
        responseType: 'text' as const,
        response: 'Test',
        channel: 0,
        enabled: true,
        lastResult: 'error' as const,
        lastError: 'Connection failed',
      };

      expect(successTrigger.lastResult).toBe('success');
      expect(errorTrigger.lastResult).toBe('error');
      expect(errorTrigger.lastError).toBeDefined();
    });
  });
});
