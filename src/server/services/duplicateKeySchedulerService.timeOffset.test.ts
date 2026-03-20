import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock database service before importing the scheduler
vi.mock('../../services/database.js', () => ({
  default: {
    getLatestPacketTimestampsPerNodeAsync: vi.fn(),
    updateNodeTimeOffsetFlagsAsync: vi.fn().mockResolvedValue(undefined),
    updateNodeSpamFlagsAsync: vi.fn().mockResolvedValue(undefined),
    getPacketCountsPerNodeLastHourAsync: vi.fn().mockResolvedValue([]),
    getTopBroadcastersAsync: vi.fn().mockResolvedValue([]),
    nodes: {
      getAllNodes: vi.fn(),
      getNode: vi.fn(),
      updateNodeSecurityFlags: vi.fn().mockResolvedValue(undefined),
      updateNodeLowEntropyFlag: vi.fn().mockResolvedValue(undefined),
      getNodesWithPublicKeys: vi.fn().mockResolvedValue([
        { nodeNum: 1, publicKey: 'dGVzdGtleQ==' }
      ]),
    },
    settings: {
      getSetting: vi.fn().mockResolvedValue(null),
    },
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
    (databaseService.nodes.getNodesWithPublicKeys as any).mockResolvedValue([
      { nodeNum: 1, publicKey: 'dGVzdGtleQ==' }
    ]);
    (databaseService.getPacketCountsPerNodeLastHourAsync as any).mockResolvedValue([]);
    (databaseService.getTopBroadcastersAsync as any).mockResolvedValue([]);
    (databaseService.updateNodeTimeOffsetFlagsAsync as any).mockResolvedValue(undefined);
    (databaseService.updateNodeSpamFlagsAsync as any).mockResolvedValue(undefined);
    (databaseService.nodes.updateNodeSecurityFlags as any).mockResolvedValue(undefined);
    (databaseService.nodes.updateNodeLowEntropyFlag as any).mockResolvedValue(undefined);
    (databaseService.settings.getSetting as any).mockResolvedValue(null);
    // Default: getAllNodes returns the dummy node used by the public key check
    (databaseService.nodes.getAllNodes as any).mockResolvedValue([
      { nodeNum: 1, shortName: 'Dummy', keyIsLowEntropy: false, duplicateKeyDetected: false, isTimeOffsetIssue: false, isExcessivePackets: false }
    ]);
    // getNode no longer used (nodeMap from getAllNodes is passed to sub-scans)
    // but keep the mock available for safety
    (databaseService.nodes.getNode as any).mockResolvedValue({
      nodeNum: 1,
      shortName: 'Dummy',
      keyIsLowEntropy: false,
      duplicateKeyDetected: false,
      isTimeOffsetIssue: false
    });
    // Reset the scanning flag on the singleton (it's private, but we need to clear it between tests)
    (duplicateKeySchedulerService as any).isScanning = false;
  });

  it('should flag nodes with time offset exceeding threshold', async () => {
    const now = Date.now();
    const thirtyOneMinutesMs = 31 * 60 * 1000;

    (databaseService.getLatestPacketTimestampsPerNodeAsync as any).mockResolvedValue([
      { nodeNum: 100, timestamp: now, packetTimestamp: now - thirtyOneMinutesMs }
    ]);
    // getAllNodes must include node 100 for the nodeMap lookup in time offset detection
    (databaseService.nodes.getAllNodes as any).mockResolvedValue([
      { nodeNum: 1, shortName: 'Dummy', keyIsLowEntropy: false, duplicateKeyDetected: false, isTimeOffsetIssue: false, isExcessivePackets: false },
      { nodeNum: 100, shortName: 'Test', isTimeOffsetIssue: false, keyIsLowEntropy: false, duplicateKeyDetected: false, isExcessivePackets: false }
    ]);

    await duplicateKeySchedulerService.runScan();

    expect(databaseService.updateNodeTimeOffsetFlagsAsync).toHaveBeenCalledWith(
      100, true, expect.any(Number)
    );
    // Offset should be ~1860 seconds (31 minutes)
    const call = (databaseService.updateNodeTimeOffsetFlagsAsync as any).mock.calls.find(
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
    // getAllNodes must include node 200 for the nodeMap lookup
    // Node 200 starts with isTimeOffsetIssue: true so state change triggers a write
    (databaseService.nodes.getAllNodes as any).mockResolvedValue([
      { nodeNum: 1, shortName: 'Dummy', keyIsLowEntropy: false, duplicateKeyDetected: false, isTimeOffsetIssue: false, isExcessivePackets: false },
      { nodeNum: 200, shortName: 'Test2', isTimeOffsetIssue: true, keyIsLowEntropy: false, duplicateKeyDetected: false, isExcessivePackets: false }
    ]);

    await duplicateKeySchedulerService.runScan();

    expect(databaseService.updateNodeTimeOffsetFlagsAsync).toHaveBeenCalledWith(
      200, false, expect.any(Number)
    );
  });

  it('should clear flags from nodes with no timestamp data', async () => {
    (databaseService.getLatestPacketTimestampsPerNodeAsync as any).mockResolvedValue([]);
    (databaseService.nodes.getAllNodes as any).mockResolvedValue([
      { nodeNum: 1, shortName: 'Dummy', keyIsLowEntropy: false, duplicateKeyDetected: false, isTimeOffsetIssue: false, isExcessivePackets: false },
      { nodeNum: 300, shortName: 'Old', isTimeOffsetIssue: true, keyIsLowEntropy: false, duplicateKeyDetected: false, isExcessivePackets: false }
    ]);

    await duplicateKeySchedulerService.runScan();

    expect(databaseService.updateNodeTimeOffsetFlagsAsync).toHaveBeenCalledWith(
      300, false, null
    );
  });

  it('should clear flag when node comes back within threshold', async () => {
    const now = Date.now();
    const fiveMinutesMs = 5 * 60 * 1000;

    (databaseService.getLatestPacketTimestampsPerNodeAsync as any).mockResolvedValue([
      { nodeNum: 400, timestamp: now, packetTimestamp: now - fiveMinutesMs }
    ]);
    // getAllNodes must include node 400 with isTimeOffsetIssue: true (was flagged, now clearing)
    (databaseService.nodes.getAllNodes as any).mockResolvedValue([
      { nodeNum: 1, shortName: 'Dummy', keyIsLowEntropy: false, duplicateKeyDetected: false, isTimeOffsetIssue: false, isExcessivePackets: false },
      { nodeNum: 400, shortName: 'Recovered', isTimeOffsetIssue: true, keyIsLowEntropy: false, duplicateKeyDetected: false, isExcessivePackets: false }
    ]);

    await duplicateKeySchedulerService.runScan();

    expect(databaseService.updateNodeTimeOffsetFlagsAsync).toHaveBeenCalledWith(
      400, false, expect.any(Number)
    );
  });
});
