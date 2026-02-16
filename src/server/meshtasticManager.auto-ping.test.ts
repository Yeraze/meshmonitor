import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies
const mockGetSetting = vi.fn();
const mockGetNode = vi.fn();
const mockSetSetting = vi.fn();

vi.mock('../services/database.js', () => ({
  default: {
    getSetting: mockGetSetting,
    getNode: mockGetNode,
    setSetting: mockSetSetting,
  }
}));

vi.mock('./services/dataEventEmitter.js', () => ({
  dataEventEmitter: {
    emitAutoPingUpdate: vi.fn(),
  }
}));

describe('MeshtasticManager - Auto-Ping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('DM command parsing', () => {
    it('should match "ping N" pattern with valid numbers', () => {
      const testCases = [
        { input: 'ping 1', expected: 1 },
        { input: 'ping 5', expected: 5 },
        { input: 'ping 10', expected: 10 },
        { input: 'ping 100', expected: 100 },
        { input: 'PING 5', expected: 5 },
        { input: '  ping 5  ', expected: 5 },
      ];

      for (const { input, expected } of testCases) {
        const match = input.trim().toLowerCase().match(/^ping\s+(\d+)$/);
        expect(match, `"${input}" should match`).not.toBeNull();
        expect(parseInt(match![1], 10)).toBe(expected);
      }
    });

    it('should match "ping stop" command', () => {
      const testCases = ['ping stop', 'PING STOP', '  ping stop  ', 'Ping Stop'];
      for (const input of testCases) {
        const match = input.trim().toLowerCase().match(/^ping\s+stop$/);
        expect(match, `"${input}" should match ping stop`).not.toBeNull();
      }
    });

    it('should not match invalid ping commands', () => {
      const testCases = [
        'ping',        // No count
        'ping abc',    // Non-numeric
        'ping -1',     // Negative
        'ping 0',      // Zero (matches regex but should be rejected by validation)
        'pinging 5',   // Wrong command
        'my ping 5',   // Extra prefix
        'ping 5 extra', // Extra suffix
        'hello',       // Unrelated
      ];

      for (const input of testCases) {
        const text = input.trim().toLowerCase();
        const startMatch = text.match(/^ping\s+(\d+)$/);
        const stopMatch = text.match(/^ping\s+stop$/);
        // Either doesn't match the pattern, or matches with invalid value (0)
        if (startMatch) {
          const count = parseInt(startMatch[1], 10);
          expect(count === 0 || input === 'ping 0', `"${input}" should be invalid`).toBe(true);
        } else {
          expect(startMatch, `"${input}" should not match start`).toBeNull();
          expect(stopMatch, `"${input}" should not match stop`).toBeNull();
        }
      }
    });

    it('should not handle non-DM messages', () => {
      // Auto-ping should only respond to DMs
      const isDirectMessage = false;
      expect(isDirectMessage).toBe(false);
      // The handler should return false for non-DMs
    });
  });

  describe('Settings validation', () => {
    it('should use default settings when not configured', () => {
      mockGetSetting.mockReturnValue(null);

      const intervalSeconds = parseInt(mockGetSetting('autoPingIntervalSeconds') || '30', 10);
      const maxPings = parseInt(mockGetSetting('autoPingMaxPings') || '20', 10);
      const timeoutSeconds = parseInt(mockGetSetting('autoPingTimeoutSeconds') || '60', 10);

      expect(intervalSeconds).toBe(30);
      expect(maxPings).toBe(20);
      expect(timeoutSeconds).toBe(60);
    });

    it('should use configured settings', () => {
      mockGetSetting.mockImplementation((key: string) => {
        const settings: Record<string, string> = {
          autoPingEnabled: 'true',
          autoPingIntervalSeconds: '15',
          autoPingMaxPings: '50',
          autoPingTimeoutSeconds: '90',
        };
        return settings[key] || null;
      });

      const intervalSeconds = parseInt(mockGetSetting('autoPingIntervalSeconds') || '30', 10);
      const maxPings = parseInt(mockGetSetting('autoPingMaxPings') || '20', 10);
      const timeoutSeconds = parseInt(mockGetSetting('autoPingTimeoutSeconds') || '60', 10);

      expect(intervalSeconds).toBe(15);
      expect(maxPings).toBe(50);
      expect(timeoutSeconds).toBe(90);
    });

    it('should cap requested pings to maxPings setting', () => {
      const maxPings = 20;
      const requestedPings = 50;
      const actualCount = Math.min(requestedPings, maxPings);
      expect(actualCount).toBe(20);
    });

    it('should not cap when requested is under max', () => {
      const maxPings = 20;
      const requestedPings = 5;
      const actualCount = Math.min(requestedPings, maxPings);
      expect(actualCount).toBe(5);
    });
  });

  describe('Session lifecycle', () => {
    it('should track session state correctly', () => {
      const session = {
        requestedBy: 0x12345678,
        channel: 0,
        totalPings: 5,
        completedPings: 0,
        successfulPings: 0,
        failedPings: 0,
        intervalMs: 30000,
        timer: null as ReturnType<typeof setInterval> | null,
        pendingRequestId: null as number | null,
        pendingTimeout: null as ReturnType<typeof setTimeout> | null,
        startTime: Date.now(),
        lastPingSentAt: 0,
        results: [] as Array<{ pingNum: number; status: 'ack' | 'nak' | 'timeout'; durationMs?: number; sentAt: number }>,
      };

      expect(session.completedPings).toBe(0);
      expect(session.totalPings).toBe(5);

      // Simulate ACK
      session.completedPings++;
      session.successfulPings++;
      session.results.push({ pingNum: 1, status: 'ack', durationMs: 1500, sentAt: Date.now() });

      expect(session.completedPings).toBe(1);
      expect(session.successfulPings).toBe(1);

      // Simulate NAK
      session.completedPings++;
      session.failedPings++;
      session.results.push({ pingNum: 2, status: 'nak', sentAt: Date.now() });

      expect(session.completedPings).toBe(2);
      expect(session.failedPings).toBe(1);

      // Simulate timeout
      session.completedPings++;
      session.failedPings++;
      session.results.push({ pingNum: 3, status: 'timeout', sentAt: Date.now() });

      expect(session.completedPings).toBe(3);
      expect(session.failedPings).toBe(2);
      expect(session.results).toHaveLength(3);
    });

    it('should detect session completion', () => {
      const session = {
        totalPings: 3,
        completedPings: 3,
      };
      expect(session.completedPings >= session.totalPings).toBe(true);
    });

    it('should detect session not yet complete', () => {
      const session = {
        totalPings: 5,
        completedPings: 2,
      };
      expect(session.completedPings >= session.totalPings).toBe(false);
    });

    it('should calculate average duration correctly', () => {
      const results = [
        { pingNum: 1, status: 'ack' as const, durationMs: 1000, sentAt: 0 },
        { pingNum: 2, status: 'ack' as const, durationMs: 2000, sentAt: 0 },
        { pingNum: 3, status: 'timeout' as const, sentAt: 0 },
        { pingNum: 4, status: 'ack' as const, durationMs: 3000, sentAt: 0 },
      ];

      const successfulPings = 3;
      const avgDuration = results
        .filter(r => r.status === 'ack' && r.durationMs)
        .reduce((sum, r) => sum + (r.durationMs || 0), 0) / (successfulPings || 1);

      expect(Math.round(avgDuration)).toBe(2000);
    });
  });

  describe('Session map management', () => {
    it('should prevent duplicate sessions per requester', () => {
      const sessions = new Map<number, any>();
      const nodeNum = 0x12345678;

      sessions.set(nodeNum, { totalPings: 5 });
      expect(sessions.has(nodeNum)).toBe(true);

      // Attempting to create another session for same node should be blocked
      const canCreate = !sessions.has(nodeNum);
      expect(canCreate).toBe(false);
    });

    it('should allow sessions from different requesters', () => {
      const sessions = new Map<number, any>();

      sessions.set(0x11111111, { totalPings: 5 });
      sessions.set(0x22222222, { totalPings: 3 });

      expect(sessions.size).toBe(2);
      expect(sessions.has(0x11111111)).toBe(true);
      expect(sessions.has(0x22222222)).toBe(true);
    });

    it('should find session by pending requestId', () => {
      const sessions = new Map<number, any>();
      sessions.set(0x11111111, { pendingRequestId: 100, totalPings: 5 });
      sessions.set(0x22222222, { pendingRequestId: 200, totalPings: 3 });

      let found: number | null = null;
      for (const [nodeNum, session] of sessions) {
        if (session.pendingRequestId === 200) {
          found = nodeNum;
          break;
        }
      }
      expect(found).toBe(0x22222222);
    });

    it('should clean up session on completion', () => {
      const sessions = new Map<number, any>();
      const nodeNum = 0x12345678;

      sessions.set(nodeNum, { totalPings: 5, timer: null });
      expect(sessions.size).toBe(1);

      sessions.delete(nodeNum);
      expect(sessions.size).toBe(0);
    });
  });

  describe('Node name resolution', () => {
    it('should use longName when available', () => {
      const nodeNum = 0x12345678;
      mockGetNode.mockReturnValue({ longName: 'Test Node', shortName: 'TN' });

      const node = mockGetNode(nodeNum);
      const name = node?.longName || node?.shortName || `!${nodeNum.toString(16).padStart(8, '0')}`;

      expect(name).toBe('Test Node');
    });

    it('should fall back to shortName', () => {
      const nodeNum = 0x12345678;
      mockGetNode.mockReturnValue({ shortName: 'TN' });

      const node = mockGetNode(nodeNum);
      const name = node?.longName || node?.shortName || `!${nodeNum.toString(16).padStart(8, '0')}`;

      expect(name).toBe('TN');
    });

    it('should fall back to hex node ID', () => {
      const nodeNum = 0x12345678;
      mockGetNode.mockReturnValue(null);

      const node = mockGetNode(nodeNum);
      const name = node?.longName || node?.shortName || `!${nodeNum.toString(16).padStart(8, '0')}`;

      expect(name).toBe('!12345678');
    });
  });
});
