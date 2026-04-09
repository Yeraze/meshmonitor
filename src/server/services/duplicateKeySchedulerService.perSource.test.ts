import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks ---

// Per-source results for getNodesWithPublicKeys
const publicKeysBySource: Record<string, Array<{ nodeNum: number; publicKey: string }>> = {
  'src-A': [
    { nodeNum: 10, publicKey: 'SHARED_KEY_AAAA' },
  ],
  'src-B': [
    { nodeNum: 20, publicKey: 'SHARED_KEY_AAAA' },
  ],
};

const allNodesBySource: Record<string, any[]> = {
  'src-A': [
    { nodeNum: 10, shortName: 'A1', keyIsLowEntropy: false, duplicateKeyDetected: false, isTimeOffsetIssue: false, isExcessivePackets: false },
  ],
  'src-B': [
    { nodeNum: 20, shortName: 'B1', keyIsLowEntropy: false, duplicateKeyDetected: false, isTimeOffsetIssue: false, isExcessivePackets: false },
  ],
};

const packetCountsBySource: Record<string, Array<{ nodeNum: number; packetCount: number }>> = {
  'src-A': [
    // Local node for src-A is 10; excluding by sourceScope — node 99 sends 500 pkt/hr
    { nodeNum: 99, packetCount: 500 },
  ],
  'src-B': [],
};

// Per-source settings (localNodeNum differs per source)
const settingsBySource: Record<string, Record<string, string | null>> = {
  'src-A': { localNodeNum: '10' },
  'src-B': { localNodeNum: '20' },
};

const h = vi.hoisted(() => ({
  getNodesWithPublicKeysMock: vi.fn(),
  getAllNodesMock: vi.fn(),
  getPacketCountsMock: vi.fn(),
  getLatestTimestampsMock: vi.fn(),
  getSettingForSourceMock: vi.fn(),
  updateNodeSecurityFlagsMock: vi.fn().mockResolvedValue(undefined),
  updateNodeLowEntropyFlagMock: vi.fn().mockResolvedValue(undefined),
  updateNodeSpamFlagsAsyncMock: vi.fn().mockResolvedValue(undefined),
  updateNodeTimeOffsetFlagsAsyncMock: vi.fn().mockResolvedValue(undefined),
  getAllManagersMock: vi.fn(),
}));
const {
  getNodesWithPublicKeysMock, getAllNodesMock, getPacketCountsMock,
  getLatestTimestampsMock, getSettingForSourceMock,
  updateNodeSecurityFlagsMock, updateNodeLowEntropyFlagMock,
  updateNodeSpamFlagsAsyncMock, updateNodeTimeOffsetFlagsAsyncMock,
  getAllManagersMock,
} = h;

vi.mock('../../services/database.js', () => ({
  default: {
    getLatestPacketTimestampsPerNodeAsync: h.getLatestTimestampsMock,
    updateNodeTimeOffsetFlagsAsync: h.updateNodeTimeOffsetFlagsAsyncMock,
    updateNodeSpamFlagsAsync: h.updateNodeSpamFlagsAsyncMock,
    getPacketCountsPerNodeLastHourAsync: h.getPacketCountsMock,
    getTopBroadcastersAsync: vi.fn().mockResolvedValue([]),
    nodes: {
      getAllNodes: h.getAllNodesMock,
      getNodesWithPublicKeys: h.getNodesWithPublicKeysMock,
      updateNodeSecurityFlags: h.updateNodeSecurityFlagsMock,
      updateNodeLowEntropyFlag: h.updateNodeLowEntropyFlagMock,
    },
    settings: {
      getSetting: vi.fn().mockResolvedValue(null),
      getSettingForSource: h.getSettingForSourceMock,
    },
  }
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

// Use real detectDuplicateKeys / checkLowEntropyKey so we prove duplicate
// detection is per-source (not mocked out).
vi.mock('../../services/lowEntropyKeyService.js', async () => {
  const actual = await vi.importActual<any>('../../services/lowEntropyKeyService.js');
  return {
    ...actual,
    checkLowEntropyKey: vi.fn().mockReturnValue(false),
  };
});

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getAllManagers: h.getAllManagersMock,
    getManager: vi.fn((id: string) => ({ sourceId: id })),
  }
}));

import { duplicateKeySchedulerService } from './duplicateKeySchedulerService.js';

describe('duplicateKeySchedulerService per-source', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (duplicateKeySchedulerService as any).isScanning = new Map();
    (duplicateKeySchedulerService as any).lastScanTime = new Map();
    getAllManagersMock.mockReturnValue([
      { sourceId: 'src-A' },
      { sourceId: 'src-B' },
    ]);
    getNodesWithPublicKeysMock.mockImplementation(async (sourceId?: string) => publicKeysBySource[sourceId ?? ''] ?? []);
    getAllNodesMock.mockImplementation(async (sourceId?: string) => allNodesBySource[sourceId ?? ''] ?? []);
    getPacketCountsMock.mockImplementation(async (sourceId?: string) => packetCountsBySource[sourceId ?? ''] ?? []);
    getLatestTimestampsMock.mockResolvedValue([]);
    getSettingForSourceMock.mockImplementation(async (sourceId: string | null | undefined, key: string) => {
      if (!sourceId) return null;
      return settingsBySource[sourceId]?.[key] ?? null;
    });
    updateNodeSecurityFlagsMock.mockResolvedValue(undefined);
    updateNodeLowEntropyFlagMock.mockResolvedValue(undefined);
    updateNodeSpamFlagsAsyncMock.mockResolvedValue(undefined);
    updateNodeTimeOffsetFlagsAsyncMock.mockResolvedValue(undefined);
  });

  it('runs one scan per registered source', async () => {
    await duplicateKeySchedulerService.runScanAllSources();

    // getNodesWithPublicKeys should have been called once per source
    expect(getNodesWithPublicKeysMock).toHaveBeenCalledWith('src-A');
    expect(getNodesWithPublicKeysMock).toHaveBeenCalledWith('src-B');
    expect(getNodesWithPublicKeysMock).toHaveBeenCalledTimes(2);

    // Packet counts also per source
    expect(getPacketCountsMock).toHaveBeenCalledWith('src-A');
    expect(getPacketCountsMock).toHaveBeenCalledWith('src-B');
  });

  it('does NOT flag a node as duplicate when its "duplicate" is on a different source', async () => {
    // Both sources independently have a single node with the same key —
    // no duplicate within either source.
    await duplicateKeySchedulerService.runScanAllSources();

    const duplicateUpdateCalls = updateNodeSecurityFlagsMock.mock.calls.filter(c => c[1] === true);
    expect(duplicateUpdateCalls).toHaveLength(0);
  });

  it('spam detection uses per-source localNodeNum', async () => {
    await duplicateKeySchedulerService.runScanAllSources();

    // Verify getSettingForSource was called with the right sourceIds
    expect(getSettingForSourceMock).toHaveBeenCalledWith('src-A', 'localNodeNum');
    expect(getSettingForSourceMock).toHaveBeenCalledWith('src-B', 'localNodeNum');
  });

  it('per-source isScanning map prevents collision on same source but allows different sources', async () => {
    const svc = duplicateKeySchedulerService as any;
    svc.isScanning.set('src-A', true);

    // Scanning src-A should bail immediately (no DB calls for src-A)
    await duplicateKeySchedulerService.runScan('src-A');
    expect(getNodesWithPublicKeysMock).not.toHaveBeenCalledWith('src-A');

    // But scanning src-B still works
    await duplicateKeySchedulerService.runScan('src-B');
    expect(getNodesWithPublicKeysMock).toHaveBeenCalledWith('src-B');
  });

  it('refuses to run without a sourceId', async () => {
    await duplicateKeySchedulerService.runScan('');
    expect(getNodesWithPublicKeysMock).not.toHaveBeenCalled();
  });

  it('getStatus() returns per-source map when no sourceId', async () => {
    await duplicateKeySchedulerService.runScanAllSources();
    const status = duplicateKeySchedulerService.getStatus();
    expect(status).toHaveProperty('sources');
    expect(status.sources).toHaveProperty('src-A');
    expect(status.sources).toHaveProperty('src-B');
  });
});
