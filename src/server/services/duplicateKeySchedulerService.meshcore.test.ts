/**
 * MeshCore branch of the security scanner (#6281): flags are written and
 * cleared from the packet log and DM clocks, a disabled packet log leaves rate
 * flags alone, and one failing source does not block another.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  getAllManagersMock: vi.fn(),
  getNodesBySourceMock: vi.fn(),
  getDmMock: vi.fn(),
  setFlagsMock: vi.fn(),
  getPacketsMock: vi.fn(),
  logEnabledMock: vi.fn(),
}));

vi.mock('../../services/database.js', () => ({
  default: {
    meshcore: {
      getNodesBySource: h.getNodesBySourceMock,
      getLatestDmSenderTimes: h.getDmMock,
      setNodeSecurityFlags: h.setFlagsMock,
      getPackets: h.getPacketsMock,
    },
    nodes: {},
    settings: {},
  },
}));
vi.mock('./meshcorePacketLogService.js', () => ({ default: { isEnabled: h.logEnabledMock } }));
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: { getAllManagers: h.getAllManagersMock, getManager: vi.fn() },
}));
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { duplicateKeySchedulerService } from './duplicateKeySchedulerService.js';

const SPAMMER = 'ab'.repeat(32);
const SKEWED = 'cd'.repeat(32);
const QUIET = 'ef'.repeat(32);
const LOCAL = '01'.repeat(32);

function advert(key: string, senderSec: number, nonce: number): string {
  const ts = Buffer.alloc(4);
  ts.writeUInt32LE(senderSec);
  // nonce goes into the app-data name so each advert hashes differently
  const name = Buffer.from(`n${nonce}`).toString('hex');
  return '11' + '00' + key + ts.toString('hex') + '00'.repeat(64) + '81' + name;
}

describe('duplicateKeySchedulerService MeshCore scan (#6281)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (duplicateKeySchedulerService as any).isScanning = new Map();
    (duplicateKeySchedulerService as any).lastScanTime = new Map();
    h.getAllManagersMock.mockReturnValue([{ sourceId: 'mc-1', sourceType: 'meshcore' }]);
    h.logEnabledMock.mockResolvedValue(true);
    h.getDmMock.mockResolvedValue([]);
    h.setFlagsMock.mockResolvedValue(undefined);
    h.getPacketsMock.mockResolvedValue([]);
  });

  it('flags a spammer and a skewed clock, clears stale flags, skips the local node', async () => {
    const now = Date.now();
    h.getNodesBySourceMock.mockResolvedValue([
      { publicKey: SPAMMER },
      { publicKey: SKEWED },
      { publicKey: QUIET, isExcessivePackets: true, packetRatePerHour: 40, isTimeOffsetIssue: true, timeOffsetSeconds: 9000 },
      { publicKey: LOCAL, isLocalNode: true, isExcessivePackets: true },
    ]);
    const rows = [] as any[];
    for (let i = 0; i < 31; i++) {
      rows.push({
        id: i + 1, sourceId: 'mc-1', timestamp: now - 1000 - i, payloadType: 4, routeType: 1, hopCount: 0,
        senderPubKey: SPAMMER, srcHash: 'ab', rawHex: advert(SPAMMER, Math.floor(now / 1000), i), observerId: null,
      });
    }
    rows.push({
      id: 100, sourceId: 'mc-1', timestamp: now - 500, payloadType: 4, routeType: 1, hopCount: 0,
      senderPubKey: SKEWED, srcHash: 'cd', rawHex: advert(SKEWED, Math.floor(now / 1000) - 7200, 999), observerId: null,
    });
    h.getPacketsMock.mockResolvedValue(rows);

    await duplicateKeySchedulerService.runScan('mc-1', 'meshcore');

    expect(h.setFlagsMock).toHaveBeenCalledTimes(1);
    const [sid, writes] = h.setFlagsMock.mock.calls[0];
    expect(sid).toBe('mc-1');
    const by = Object.fromEntries(writes.map((w: any) => [w.publicKey, w]));
    expect(by[SPAMMER]).toMatchObject({ isExcessivePackets: true, packetRatePerHour: 31, advertRatePerHour: 31 });
    expect(by[SKEWED]).toMatchObject({ isTimeOffsetIssue: true, timeOffsetSeconds: 7200, timeOffsetSource: 'advert' });
    expect(by[QUIET]).toMatchObject({ isExcessivePackets: false, packetRatePerHour: null, isTimeOffsetIssue: false, timeOffsetSeconds: null });
    expect(by[LOCAL]).toMatchObject({ isExcessivePackets: false });
    expect(duplicateKeySchedulerService.getStatus('mc-1').lastScanTime).not.toBeNull();
  });

  it('with the packet log off, rate flags are left untouched and the log is not read', async () => {
    h.logEnabledMock.mockResolvedValue(false);
    h.getNodesBySourceMock.mockResolvedValue([
      { publicKey: QUIET, isExcessivePackets: true, packetRatePerHour: 40 },
    ]);
    const now = Date.now();
    h.getDmMock.mockResolvedValue([
      { fromPublicKey: QUIET, senderTimestamp: Math.floor(now / 1000) - 7200, receivedAtMs: now },
    ]);
    await duplicateKeySchedulerService.runScan('mc-1', 'meshcore');
    expect(h.getPacketsMock).not.toHaveBeenCalled();
    const writes = h.setFlagsMock.mock.calls[0][1];
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ publicKey: QUIET, isTimeOffsetIssue: true, timeOffsetSource: 'message' });
    expect(writes[0]).not.toHaveProperty('isExcessivePackets');
  });

  it('writes nothing when no flag changes', async () => {
    h.getNodesBySourceMock.mockResolvedValue([{ publicKey: QUIET }]);
    await duplicateKeySchedulerService.runScan('mc-1', 'meshcore');
    expect(h.setFlagsMock).not.toHaveBeenCalled();
  });

  it('a failure in one source does not block another', async () => {
    h.getAllManagersMock.mockReturnValue([
      { sourceId: 'mc-bad', sourceType: 'meshcore' },
      { sourceId: 'mc-mqtt', sourceType: 'meshcore_mqtt' },
    ]);
    h.getNodesBySourceMock.mockImplementation(async (sid: string) => {
      if (sid === 'mc-bad') throw new Error('db down');
      return [{ publicKey: QUIET, isTimeOffsetIssue: true, timeOffsetSeconds: 1 }];
    });
    await duplicateKeySchedulerService.runScanAllSources();
    expect(h.setFlagsMock).toHaveBeenCalledTimes(1);
    expect(h.setFlagsMock.mock.calls[0][0]).toBe('mc-mqtt');
    expect(duplicateKeySchedulerService.getStatus('mc-bad').lastScanTime).toBeNull();
    expect(duplicateKeySchedulerService.getStatus('mc-bad').scanningNow).toBe(false);
  });

  it('refuses a second scan while one runs for the same source', async () => {
    (duplicateKeySchedulerService as any).isScanning.set('mc-1', true);
    await duplicateKeySchedulerService.runScan('mc-1', 'meshcore');
    expect(h.getNodesBySourceMock).not.toHaveBeenCalled();
  });
});
