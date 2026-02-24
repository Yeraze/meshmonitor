import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before any imports
const mockGetSetting = vi.fn();
const mockSetSetting = vi.fn();
const mockGetNodeNeedingTracerouteAsync = vi.fn();
const mockLogAutoTracerouteAttemptAsync = vi.fn();
const mockUpdateAutoTracerouteResultByNodeAsync = vi.fn();
const mockRecordTracerouteRequest = vi.fn();
const mockFindUserByIdAsync = vi.fn();
const mockFindUserByUsernameAsync = vi.fn();
const mockCheckPermissionAsync = vi.fn();
const mockGetUserPermissionSetAsync = vi.fn();

vi.mock('../services/database.js', () => ({
  default: {
    getSetting: mockGetSetting,
    setSetting: mockSetSetting,
    getNodeNeedingTracerouteAsync: mockGetNodeNeedingTracerouteAsync,
    logAutoTracerouteAttemptAsync: mockLogAutoTracerouteAttemptAsync,
    updateAutoTracerouteResultByNodeAsync: mockUpdateAutoTracerouteResultByNodeAsync,
    recordTracerouteRequest: mockRecordTracerouteRequest,
    findUserByIdAsync: mockFindUserByIdAsync,
    findUserByUsernameAsync: mockFindUserByUsernameAsync,
    checkPermissionAsync: mockCheckPermissionAsync,
    getUserPermissionSetAsync: mockGetUserPermissionSetAsync,
  },
}));

vi.mock('./meshtasticProtobufService.js', () => ({
  default: {
    initialize: vi.fn(),
    createMeshPacket: vi.fn(),
  },
}));

vi.mock('./protobufService.js', () => ({
  default: {
    encode: vi.fn(),
    decode: vi.fn(),
  },
  convertIpv4ConfigToStrings: vi.fn(),
}));

vi.mock('./protobufLoader.js', () => ({
  getProtobufRoot: vi.fn(),
}));

vi.mock('./tcpTransport.js', () => ({
  TcpTransport: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('./services/notificationService.js', () => ({
  notificationService: {
    checkAndSendNotifications: vi.fn(),
  },
}));

vi.mock('./services/serverEventNotificationService.js', () => ({
  serverEventNotificationService: {
    notifyNodeConnected: vi.fn(),
    notifyNodeDisconnected: vi.fn(),
  },
}));

vi.mock('./services/packetLogService.js', () => ({
  default: {
    logPacket: vi.fn(),
  },
}));

vi.mock('./services/channelDecryptionService.js', () => ({
  channelDecryptionService: {
    tryDecrypt: vi.fn(),
  },
}));

vi.mock('./services/dataEventEmitter.js', () => ({
  dataEventEmitter: {
    emit: vi.fn(),
    on: vi.fn(),
  },
}));

vi.mock('./messageQueueService.js', () => ({
  messageQueueService: {
    enqueue: vi.fn(),
    setSendCallback: vi.fn(),
    clear: vi.fn(),
  },
}));

vi.mock('node-cron', () => ({
  default: {
    schedule: vi.fn((_expression: string, _callback: () => void) => ({
      stop: vi.fn(),
    })),
    validate: vi.fn(() => true),
  },
}));

vi.mock('./config/environment.js', () => ({
  getEnvironmentConfig: vi.fn(() => ({
    NODE_IP: '127.0.0.1',
    TCP_PORT: 4403,
    LOG_LEVEL: 'info',
  })),
}));

vi.mock('../utils/autoResponderUtils.js', () => ({
  normalizeTriggerPatterns: vi.fn(),
}));

vi.mock('../utils/nodeHelpers.js', () => ({
  isNodeComplete: vi.fn(),
}));

const mockTargetNode = {
  nodeNum: 99999,
  nodeId: '!00099999',
  longName: 'Target Node',
  channel: 0,
};

describe('MeshtasticManager - Traceroute Scheduler', () => {
  let manager: any;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    // Make jitter deterministic: 0 jitter means immediate execution
    vi.spyOn(Math, 'random').mockReturnValue(0);

    // Dynamic import to get fresh module instance with mocks applied
    const module = await import('./meshtasticManager.js');
    manager = module.default;

    // Set up the manager to think it's connected with local node info
    manager.isConnected = true;
    manager.localNodeInfo = {
      nodeNum: 1234567890,
      nodeId: '!12345678',
      longName: 'Test Node',
      shortName: 'TN',
    };

    // Reset rate limiting timestamp
    manager.lastTracerouteSentTime = 0;

    // Mock sendTraceroute to avoid actually sending
    manager.sendTraceroute = vi.fn().mockResolvedValue(undefined);
    manager.checkTracerouteTimeouts = vi.fn();

    // Mock database calls
    mockGetNodeNeedingTracerouteAsync.mockResolvedValue(mockTargetNode);
    mockLogAutoTracerouteAttemptAsync.mockResolvedValue(undefined);
  });

  afterEach(() => {
    // Clean up timers
    manager.tracerouteIntervalMinutes = 0;
    if (manager.tracerouteJitterTimeout) {
      clearTimeout(manager.tracerouteJitterTimeout);
      manager.tracerouteJitterTimeout = null;
    }
    if (manager.tracerouteInterval) {
      clearInterval(manager.tracerouteInterval);
      manager.tracerouteInterval = null;
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /**
   * Helper: bind and call startTracerouteScheduler with the given interval
   */
  function startScheduler(minutes: number) {
    manager.tracerouteIntervalMinutes = minutes;
    const fn = manager['startTracerouteScheduler'].bind(manager);
    fn();
  }

  describe('Timer leak prevention', () => {
    it('should clear pending jitter timeout when scheduler is restarted', async () => {
      // Use non-zero jitter for this test to verify the timeout is cleared
      vi.spyOn(Math, 'random').mockReturnValue(0.5);

      startScheduler(2); // 2-minute interval, jitter = 0.5 * 2min = 1 min

      // Jitter timeout should be set
      expect(manager.tracerouteJitterTimeout).not.toBeNull();

      // Restart scheduler before jitter fires (simulates settings change)
      // Reset jitter to 0 so second scheduler fires immediately
      vi.spyOn(Math, 'random').mockReturnValue(0);
      startScheduler(2);

      // Fire the immediate timeout (jitter = 0)
      await vi.advanceTimersByTimeAsync(0);

      // Only one traceroute from the second scheduler start
      expect(manager.sendTraceroute).toHaveBeenCalledTimes(1);

      // Now advance past the first scheduler's jitter time (1 min) AND the interval (2 min)
      // If the old timeout leaked, it would create a second interval and we'd get extra calls
      manager.sendTraceroute.mockClear();
      manager.lastTracerouteSentTime = 0;
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

      // Should have 1 call from the interval, not 2 (would be 2 if old timeout leaked and created extra interval)
      expect(manager.sendTraceroute).toHaveBeenCalledTimes(1);
    });

    it('should not leak intervals when scheduler is restarted multiple times', async () => {
      // Restart scheduler 5 times rapidly (simulates repeated settings changes)
      for (let i = 0; i < 5; i++) {
        startScheduler(1);
      }

      // With jitter=0, the timeout fires immediately
      await vi.advanceTimersByTimeAsync(0);

      // Only one traceroute should fire (from the last scheduler start)
      expect(manager.sendTraceroute).toHaveBeenCalledTimes(1);

      // Reset and advance by exactly one interval
      manager.sendTraceroute.mockClear();
      manager.lastTracerouteSentTime = 0;
      await vi.advanceTimersByTimeAsync(60 * 1000);

      // Only one more traceroute should fire (from the single remaining interval)
      // If intervals leaked, we'd see up to 5 calls
      expect(manager.sendTraceroute).toHaveBeenCalledTimes(1);
    });

    it('should clear jitter timeout on disconnect', () => {
      // Use non-zero jitter to keep timeout pending
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      startScheduler(1);

      expect(manager.tracerouteJitterTimeout).not.toBeNull();

      // Disconnect should clear the jitter timeout
      manager.disconnect();

      expect(manager.tracerouteJitterTimeout).toBeNull();
      expect(manager.tracerouteInterval).toBeNull();
    });
  });

  describe('Rate limiting', () => {
    it('should skip traceroute if less than 30 seconds since last send', async () => {
      // Set lastTracerouteSentTime to "now" in fake timer land
      // so the rate limit will trigger
      manager.lastTracerouteSentTime = Date.now();

      startScheduler(1);

      // Advance just past 0ms jitter but not past 30 seconds
      await vi.advanceTimersByTimeAsync(10);

      // The rate limit check should prevent the send
      expect(manager.sendTraceroute).not.toHaveBeenCalled();
    });

    it('should allow traceroute if more than 30 seconds since last send', async () => {
      // Set lastTracerouteSentTime to 60 seconds in the past
      manager.lastTracerouteSentTime = Date.now() - 60000;

      startScheduler(1);

      // Advance past 0ms jitter
      await vi.advanceTimersByTimeAsync(0);

      // Should have sent
      expect(manager.sendTraceroute).toHaveBeenCalledTimes(1);
    });

    it('should allow first traceroute when lastTracerouteSentTime is 0', async () => {
      manager.lastTracerouteSentTime = 0;

      startScheduler(1);

      // Advance past 0ms jitter
      await vi.advanceTimersByTimeAsync(0);

      // First traceroute should be allowed (lastTracerouteSentTime === 0 bypass)
      expect(manager.sendTraceroute).toHaveBeenCalledTimes(1);
    });
  });

  describe('Scheduler disabled', () => {
    it('should not schedule anything when interval is 0', () => {
      startScheduler(0);

      expect(manager.tracerouteJitterTimeout).toBeNull();
      expect(manager.tracerouteInterval).toBeNull();
    });

    it('should clear existing timers when interval is set to 0', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      startScheduler(1);

      expect(manager.tracerouteJitterTimeout).not.toBeNull();

      // Disable by setting to 0
      startScheduler(0);

      expect(manager.tracerouteJitterTimeout).toBeNull();
      expect(manager.tracerouteInterval).toBeNull();
    });
  });

  describe('Jitter timeout nullification', () => {
    it('should set tracerouteJitterTimeout to null after timeout fires', async () => {
      startScheduler(1);

      // With jitter=0, timeout fires on next tick
      expect(manager.tracerouteJitterTimeout).not.toBeNull();

      await vi.advanceTimersByTimeAsync(0);

      // After firing, jitter timeout should be nulled and interval set
      expect(manager.tracerouteJitterTimeout).toBeNull();
      expect(manager.tracerouteInterval).not.toBeNull();
    });
  });
});
