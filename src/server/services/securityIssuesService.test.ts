import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ getChangeMock: vi.fn(), getKeyMock: vi.fn() }));
vi.mock('./meshcoreOwnIdentityTracker.js', () => ({
  meshcoreOwnIdentityTracker: { getChange: h.getChangeMock, getCurrentKey: h.getKeyMock },
}));

import { collectSecurityIssues } from './securityIssuesService.js';

const K1 = 'ab'.repeat(32);
const K2 = 'cd'.repeat(32);

describe('collectSecurityIssues — Meshtastic', () => {
  it('merges the three node sets by nodeNum with the old wire fields', async () => {
    const db = {
      getNodesWithKeySecurityIssuesAsync: vi.fn().mockResolvedValue([
        { nodeNum: 1, shortName: 'A', longName: 'Alpha', lastHeard: 5, keyIsLowEntropy: true, duplicateKeyDetected: false, publicKey: 'k', hwModel: 9 },
      ]),
      getNodesWithExcessivePacketsAsync: vi.fn().mockResolvedValue([
        { nodeNum: 1, packetRatePerHour: 50, packetRateLastChecked: 7 },
        { nodeNum: 2, shortName: null, longName: null, packetRatePerHour: 60 },
      ]),
      getNodesWithTimeOffsetIssuesAsync: vi.fn().mockResolvedValue([
        { nodeNum: 2, isTimeOffsetIssue: true, timeOffsetSeconds: 4000 },
        { nodeNum: 3, shortName: 'C', isTimeOffsetIssue: true, timeOffsetSeconds: -90 },
      ]),
      getTopBroadcastersAsync: vi.fn().mockResolvedValue([{ nodeNum: 2, packetCount: 60 }]),
    };
    const r = await collectSecurityIssues(db as never, 's1', { protocol: 'meshtastic' });
    expect(db.getNodesWithKeySecurityIssuesAsync).toHaveBeenCalledWith('s1');
    expect(db.getTopBroadcastersAsync).toHaveBeenCalledWith(5, 's1');
    expect(r.protocol).toBe('meshtastic');
    expect(r.total).toBe(3);
    expect([r.lowEntropyCount, r.duplicateKeyCount, r.excessivePacketsCount, r.timeOffsetCount]).toEqual([1, 0, 2, 2]);
    const byNum = Object.fromEntries(r.nodes.map((n) => [n.nodeNum, n]));
    expect(byNum[1]).toMatchObject({ nodeKey: 'mt:1', shortName: 'A', isExcessivePackets: true, packetRatePerHour: 50, packetRateLastChecked: 7 });
    expect(byNum[2]).toMatchObject({ shortName: 'Unknown', longName: 'Unknown', keyIsLowEntropy: false, isExcessivePackets: true, isTimeOffsetIssue: true, timeOffsetSeconds: 4000 });
    expect(byNum[3]).toMatchObject({ isExcessivePackets: false, timeOffsetSeconds: -90 });
    expect(r.topBroadcasters).toEqual([{ nodeNum: 2, packetCount: 60 }]);
  });
});

describe('collectSecurityIssues — MeshCore', () => {
  beforeEach(() => {
    h.getChangeMock.mockResolvedValue(null);
    h.getKeyMock.mockResolvedValue(null);
  });

  it('reads the flag columns (ms to seconds), adds P7a findings and ranks top broadcasters by stored rate', async () => {
    const db = {
      getNodesWithKeySecurityIssuesAsync: vi.fn(),
      getNodesWithExcessivePacketsAsync: vi.fn(),
      getNodesWithTimeOffsetIssuesAsync: vi.fn(),
      getTopBroadcastersAsync: vi.fn(),
      meshcore: {
        getSecurityFlaggedNodes: vi.fn().mockResolvedValue([
          { publicKey: K1.toUpperCase(), name: 'Chatty', advType: 2, lastHeard: 1_700_000_005_000, isExcessivePackets: true, packetRatePerHour: 44, advertRatePerHour: 40, packetRateLastChecked: 1_700_000_000_000 },
          { publicKey: K2, name: 'Skewed', isTimeOffsetIssue: true, timeOffsetSeconds: 7200, timeOffsetSource: 'message' },
        ]),
        getNodesBySource: vi.fn().mockResolvedValue([
          { publicKey: K1, name: 'Chatty', advertSignatureVerified: false },
        ]),
      },
    };
    const r = await collectSecurityIssues(db as never, 'mc-1', { protocol: 'meshcore', topBroadcasters: 5 });
    expect(db.getNodesWithKeySecurityIssuesAsync).not.toHaveBeenCalled();
    expect(db.getTopBroadcastersAsync).not.toHaveBeenCalled();
    expect(r.protocol).toBe('meshcore');
    const chatty = r.nodes.find((n) => n.nodeKey === `mc:${K1}`)!;
    expect(chatty).toMatchObject({
      packetRatePerHour: 44, advertRatePerHour: 40, packetRateLastChecked: 1_700_000_000, lastHeard: 1_700_000_005,
      advertSignatureFailed: true, isExcessivePackets: true,
    });
    const skewed = r.nodes.find((n) => n.nodeKey === `mc:${K2}`)!;
    expect(skewed).toMatchObject({ isTimeOffsetIssue: true, timeOffsetSeconds: 7200, timeOffsetSource: 'message' });
    expect(r.counts).toMatchObject({ excessivePackets: 1, timeOffset: 1, signatureFailure: 1, ownKeyChanged: 0 });
    expect(r.topBroadcasters).toEqual([expect.objectContaining({ nodeKey: `mc:${K1}`, packetCount: 44 })]);
  });

  it('includes an unacknowledged own-key change', async () => {
    h.getChangeMock.mockResolvedValue({ previousKey: K1, currentKey: K2, detectedAt: 9 });
    const db = {
      getNodesWithKeySecurityIssuesAsync: vi.fn(), getNodesWithExcessivePacketsAsync: vi.fn(),
      getNodesWithTimeOffsetIssuesAsync: vi.fn(), getTopBroadcastersAsync: vi.fn(),
      meshcore: { getSecurityFlaggedNodes: vi.fn().mockResolvedValue([]), getNodesBySource: vi.fn().mockResolvedValue([]) },
    };
    const r = await collectSecurityIssues(db as never, 'mc-1', { protocol: 'meshcore' });
    expect(r.ownKeyChange).toEqual({ currentKey: K2, previousKey: K1, detectedAt: 9 });
    expect(r.counts.ownKeyChanged).toBe(1);
    expect(r.total).toBe(0);
  });
});
