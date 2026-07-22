/**
 * Scheduler wiring for the Meshtastic 2.8 upgrade-renumber suppression (#4251).
 *
 * Uses the same mocking shape as the per-source scan test, but with real
 * `detectDuplicateKeys` + `isBenign28UpgradeRenumber` so we prove the scanner
 * SUPPRESSES the benign same-key/two-NodeNum handoff (no security flag) while
 * still flagging a genuine both-live collision. The pure classifier itself is
 * exhaustively unit-tested in lowEntropyKeyService.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { nodeNumFromPublicKey } from '../../services/lowEntropyKeyService.js';

const KEY_BENIGN = Buffer.alloc(32, 0x02).toString('base64');
// Derive via the production helper (portable CRC-32) rather than zlib.crc32,
// which isn't available on Node 20 (our support floor). crc32 correctness
// itself is pinned against the canonical vector in lowEntropyKeyService.test.ts.
const NEW_NUM = nodeNumFromPublicKey(KEY_BENIGN)!; // crc32(key) = the 2.8 identity
const OLD_NUM = 0x2b873e80; // arbitrary pre-upgrade MAC-derived NodeNum (not crc32)

const KEY_COLLISION = Buffer.alloc(32, 0x03).toString('base64');
const COLLIDE_A = 0x11111111; // neither equals crc32(KEY_COLLISION)
const COLLIDE_B = 0x22222222;

const NOW = Math.floor(Date.now() / 1000);
const DAY = 24 * 60 * 60;

const publicKeysBySource: Record<string, Array<{ nodeNum: number; publicKey: string }>> = {
  'src-renumber': [
    { nodeNum: NEW_NUM, publicKey: KEY_BENIGN },
    { nodeNum: OLD_NUM, publicKey: KEY_BENIGN },
  ],
  'src-collision': [
    { nodeNum: COLLIDE_A, publicKey: KEY_COLLISION },
    { nodeNum: COLLIDE_B, publicKey: KEY_COLLISION },
  ],
};

const allNodesBySource: Record<string, any[]> = {
  'src-renumber': [
    { nodeNum: NEW_NUM, lastHeard: NOW - 60, keyIsLowEntropy: false, duplicateKeyDetected: false, isTimeOffsetIssue: false, isExcessivePackets: false },
    { nodeNum: OLD_NUM, lastHeard: NOW - 10 * DAY, keyIsLowEntropy: false, duplicateKeyDetected: false, isTimeOffsetIssue: false, isExcessivePackets: false },
  ],
  'src-collision': [
    { nodeNum: COLLIDE_A, lastHeard: NOW - 60, keyIsLowEntropy: false, duplicateKeyDetected: false, isTimeOffsetIssue: false, isExcessivePackets: false },
    { nodeNum: COLLIDE_B, lastHeard: NOW - 120, keyIsLowEntropy: false, duplicateKeyDetected: false, isTimeOffsetIssue: false, isExcessivePackets: false },
  ],
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

// Real detectDuplicateKeys + isBenign28UpgradeRenumber; only stub low-entropy.
vi.mock('../../services/lowEntropyKeyService.js', async () => {
  const actual = await vi.importActual<any>('../../services/lowEntropyKeyService.js');
  return { ...actual, checkLowEntropyKey: vi.fn().mockReturnValue(false) };
});

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getAllManagers: h.getAllManagersMock,
    getManager: vi.fn((id: string) => ({ sourceId: id })),
  }
}));

import { duplicateKeySchedulerService } from './duplicateKeySchedulerService.js';

describe('duplicateKeySchedulerService — 2.8 upgrade renumber suppression (#4251)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (duplicateKeySchedulerService as any).isScanning = new Map();
    (duplicateKeySchedulerService as any).lastScanTime = new Map();
    h.getNodesWithPublicKeysMock.mockImplementation(async (sourceId?: string) => publicKeysBySource[sourceId ?? ''] ?? []);
    h.getAllNodesMock.mockImplementation(async (sourceId?: string) => allNodesBySource[sourceId ?? ''] ?? []);
    h.getPacketCountsMock.mockResolvedValue([]);
    h.getLatestTimestampsMock.mockResolvedValue([]);
    h.getSettingForSourceMock.mockResolvedValue(null);
  });

  it('does NOT flag either node of a benign 2.8 renumber handoff', async () => {
    h.getAllManagersMock.mockReturnValue([{ sourceId: 'src-renumber' }]);
    await duplicateKeySchedulerService.runScanAllSources();

    const flaggedTrue = h.updateNodeSecurityFlagsMock.mock.calls.filter((c) => c[1] === true);
    expect(flaggedTrue).toHaveLength(0);
  });

  it('DOES flag a genuine both-live collision where neither NodeNum is crc32(key)', async () => {
    h.getAllManagersMock.mockReturnValue([{ sourceId: 'src-collision' }]);
    await duplicateKeySchedulerService.runScanAllSources();

    const flaggedNums = h.updateNodeSecurityFlagsMock.mock.calls
      .filter((c) => c[1] === true)
      .map((c) => c[0]);
    expect(flaggedNums).toContain(COLLIDE_A);
    expect(flaggedNums).toContain(COLLIDE_B);
  });
});
