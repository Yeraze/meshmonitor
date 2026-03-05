import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock database service before importing the scheduler
vi.mock('../../services/database.js', () => ({
  default: {
    getLatestPacketTimestampsPerNodeAsync: vi.fn(),
    getAllNodes: vi.fn(),
    getNode: vi.fn(),
    updateNodeTimeOffsetFlags: vi.fn(),
    updateNodeSpamFlags: vi.fn(),
    updateNodeSecurityFlags: vi.fn(),
    updateNodeLowEntropyFlag: vi.fn(),
    getSetting: vi.fn(),
    // Return a dummy node so runScan doesn't exit early at "no nodes with public keys"
    getNodesWithPublicKeys: vi.fn().mockReturnValue([
      { nodeNum: 1, publicKey: 'dGVzdGtleQ==' }
    ]),
    getPacketCountsPerNodeLastHourAsync: vi.fn().mockResolvedValue([]),
    getTopBroadcastersAsync: vi.fn().mockResolvedValue([]),
  }
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
}));

vi.mock('../../services/lowEntropyKeyService.js', () => ({
  checkLowEntropyKey: vi.fn().mockReturnValue(false),
  detectDuplicateKeys: vi.fn().mockReturnValue(new Map()),
}));

import databaseService from '../../services/database.js';
import { duplicateKeySchedulerService } from './duplicateKeySchedulerService.js';

describe('Time Offset Detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-set default mocks that clearAllMocks wiped
    (databaseService.getNodesWithPublicKeys as any).mockReturnValue([
      { nodeNum: 1, publicKey: 'dGVzdGtleQ==' }
    ]);
    (databaseService.getPacketCountsPerNodeLastHourAsync as any).mockResolvedValue([]);
    (databaseService.getTopBroadcastersAsync as any).mockResolvedValue([]);
    // Default: return a dummy node for the public key check, return empty for allNodes
    (databaseService.getNode as any).mockReturnValue({
      nodeNum: 1,
      shortName: 'Dummy',
      keyIsLowEntropy: false,
      duplicateKeyDetected: false,
      isTimeOffsetIssue: false
    });
    (databaseService.getAllNodes as any).mockReturnValue([]);
    // Reset the scanning flag on the singleton (it's private, but we need to clear it between tests)
    (duplicateKeySchedulerService as any).isScanning = false;
  });

  it('should flag nodes with time offset exceeding threshold', async () => {
    const now = Date.now();
    const thirtyOneMinutesMs = 31 * 60 * 1000;

    (databaseService.getLatestPacketTimestampsPerNodeAsync as any).mockResolvedValue([
      { nodeNum: 100, timestamp: now, packetTimestamp: now - thirtyOneMinutesMs }
    ]);
    // getNode is called for multiple purposes; use mockImplementation to handle by nodeNum
    (databaseService.getNode as any).mockImplementation((nodeNum: number) => {
      if (nodeNum === 100) return { nodeNum: 100, shortName: 'Test', isTimeOffsetIssue: false, keyIsLowEntropy: false, duplicateKeyDetected: false };
      return { nodeNum, shortName: 'Dummy', keyIsLowEntropy: false, duplicateKeyDetected: false, isTimeOffsetIssue: false };
    });

    await duplicateKeySchedulerService.runScan();

    expect(databaseService.updateNodeTimeOffsetFlags).toHaveBeenCalledWith(
      100, true, expect.any(Number)
    );
    // Offset should be ~1860 seconds (31 minutes)
    const call = (databaseService.updateNodeTimeOffsetFlags as any).mock.calls.find(
      (c: any[]) => c[0] === 100 && c[1] === true
    );
    expect(call).toBeDefined();
    expect(Math.abs(call[2])).toBeGreaterThanOrEqual(1800);
  });

  it('should not flag nodes within threshold', async () => {
    const now = Date.now();
    const tenMinutesMs = 10 * 60 * 1000;

    (databaseService.getLatestPacketTimestampsPerNodeAsync as any).mockResolvedValue([
      { nodeNum: 200, timestamp: now, packetTimestamp: now - tenMinutesMs }
    ]);
    (databaseService.getNode as any).mockImplementation((nodeNum: number) => {
      if (nodeNum === 200) return { nodeNum: 200, shortName: 'Test2', isTimeOffsetIssue: false, keyIsLowEntropy: false, duplicateKeyDetected: false };
      return { nodeNum, shortName: 'Dummy', keyIsLowEntropy: false, duplicateKeyDetected: false, isTimeOffsetIssue: false };
    });

    await duplicateKeySchedulerService.runScan();

    expect(databaseService.updateNodeTimeOffsetFlags).toHaveBeenCalledWith(
      200, false, expect.any(Number)
    );
  });

  it('should clear flags from nodes with no timestamp data', async () => {
    (databaseService.getLatestPacketTimestampsPerNodeAsync as any).mockResolvedValue([]);
    (databaseService.getAllNodes as any).mockReturnValue([
      { nodeNum: 300, shortName: 'Old', isTimeOffsetIssue: true, keyIsLowEntropy: false, duplicateKeyDetected: false }
    ]);

    await duplicateKeySchedulerService.runScan();

    expect(databaseService.updateNodeTimeOffsetFlags).toHaveBeenCalledWith(
      300, false, null
    );
  });

  it('should clear flag when node comes back within threshold', async () => {
    const now = Date.now();
    const fiveMinutesMs = 5 * 60 * 1000;

    (databaseService.getLatestPacketTimestampsPerNodeAsync as any).mockResolvedValue([
      { nodeNum: 400, timestamp: now, packetTimestamp: now - fiveMinutesMs }
    ]);
    (databaseService.getNode as any).mockImplementation((nodeNum: number) => {
      if (nodeNum === 400) return { nodeNum: 400, shortName: 'Recovered', isTimeOffsetIssue: true, keyIsLowEntropy: false, duplicateKeyDetected: false };
      return { nodeNum, shortName: 'Dummy', keyIsLowEntropy: false, duplicateKeyDetected: false, isTimeOffsetIssue: false };
    });

    await duplicateKeySchedulerService.runScan();

    expect(databaseService.updateNodeTimeOffsetFlags).toHaveBeenCalledWith(
      400, false, expect.any(Number)
    );
  });
});
