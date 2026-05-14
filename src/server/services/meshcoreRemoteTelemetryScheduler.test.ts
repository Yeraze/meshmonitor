/**
 * MeshCoreRemoteTelemetryScheduler tests.
 *
 * Covers the three rules that have to hold for the scheduler to be
 * safe to run unattended:
 *
 *   1. Per-node eligibility honours `telemetryEnabled` AND the
 *      `(now - lastTelemetryRequestAt) >= intervalMinutes*60_000`
 *      window.
 *   2. Per-source minimum spacing: even with two eligible nodes, the
 *      scheduler issues at most one request per manager per tick, and
 *      a manager that emitted any mesh-op less than 60s ago is
 *      skipped entirely.
 *   3. LPP record → telemetry-row decoding produces finite values
 *      and explodes multi-component values into one row per axis.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  MeshCoreRemoteTelemetryScheduler,
  isNodeEligible,
  pickMostOverdue,
  recordToTelemetryRows,
  MIN_INTERVAL_BETWEEN_REQUESTS_MS,
} from './meshcoreRemoteTelemetryScheduler.js';
import type { DbMeshCoreNode } from '../../db/repositories/meshcore.js';
import type { MeshCoreManager, MeshCoreTelemetryRecord } from '../meshcoreManager.js';
import type { MeshCoreManagerRegistry } from '../meshcoreRegistry.js';

function makeNode(over: Partial<DbMeshCoreNode>): DbMeshCoreNode {
  return {
    publicKey: 'pk-x',
    sourceId: 'src-a',
    createdAt: 0,
    updatedAt: 0,
    telemetryEnabled: true,
    telemetryIntervalMinutes: 10,
    lastTelemetryRequestAt: null,
    ...over,
  };
}

describe('isNodeEligible', () => {
  it('rejects disabled nodes', () => {
    expect(isNodeEligible(makeNode({ telemetryEnabled: false }), 0)).toBe(false);
  });

  it('rejects nodes with zero / null interval', () => {
    expect(isNodeEligible(makeNode({ telemetryIntervalMinutes: 0 }), 1_000_000)).toBe(false);
    expect(isNodeEligible(makeNode({ telemetryIntervalMinutes: null }), 1_000_000)).toBe(false);
  });

  it('accepts nodes that have never been requested', () => {
    expect(isNodeEligible(makeNode({ lastTelemetryRequestAt: null }), 1_000_000)).toBe(true);
  });

  it('rejects nodes still inside their interval', () => {
    const now = 10_000_000;
    const fiveMinAgo = now - 5 * 60_000;
    const node = makeNode({ telemetryIntervalMinutes: 10, lastTelemetryRequestAt: fiveMinAgo });
    expect(isNodeEligible(node, now)).toBe(false);
  });

  it('accepts nodes past their interval', () => {
    const now = 10_000_000;
    const elevenMinAgo = now - 11 * 60_000;
    const node = makeNode({ telemetryIntervalMinutes: 10, lastTelemetryRequestAt: elevenMinAgo });
    expect(isNodeEligible(node, now)).toBe(true);
  });
});

describe('pickMostOverdue', () => {
  it('returns undefined when no eligible nodes', () => {
    const nodes = [makeNode({ publicKey: 'a', telemetryEnabled: false })];
    expect(pickMostOverdue(nodes, 1_000_000)).toBeUndefined();
  });

  it('picks the most overdue eligible node', () => {
    const now = 100_000_000;
    const a = makeNode({ publicKey: 'a', telemetryIntervalMinutes: 5, lastTelemetryRequestAt: now - 6 * 60_000 });
    const b = makeNode({ publicKey: 'b', telemetryIntervalMinutes: 5, lastTelemetryRequestAt: now - 60 * 60_000 });
    const c = makeNode({ publicKey: 'c', telemetryEnabled: false });
    const picked = pickMostOverdue([a, b, c], now);
    expect(picked?.publicKey).toBe('b');
  });

  it('uses publicKey as tiebreaker when overdue-by is equal', () => {
    const now = 100_000_000;
    const a = makeNode({ publicKey: 'aaa', lastTelemetryRequestAt: null });
    const b = makeNode({ publicKey: 'bbb', lastTelemetryRequestAt: null });
    expect(pickMostOverdue([b, a], now)?.publicKey).toBe('aaa');
  });
});

describe('recordToTelemetryRows', () => {
  const baseRec: MeshCoreTelemetryRecord = { channel: 1, type: 103, value: 21.5 };

  it('produces one row for a scalar value with the right type+unit', () => {
    const rows = recordToTelemetryRows(baseRec, 'pk', 1, 1_000);
    expect(rows).toHaveLength(1);
    expect(rows[0].telemetryType).toBe('mc_temperature');
    expect(rows[0].value).toBe(21.5);
    expect(rows[0].unit).toBe('°C');
    expect(rows[0].nodeId).toBe('pk');
    expect(rows[0].nodeNum).toBe(1);
    expect(rows[0].timestamp).toBe(1_000);
  });

  it('drops non-finite scalars instead of inserting NaN', () => {
    const rec: MeshCoreTelemetryRecord = { channel: 1, type: 103, value: 'not-a-number' };
    expect(recordToTelemetryRows(rec, 'pk', 1, 0)).toHaveLength(0);
  });

  it('explodes object values into one row per axis with _<key> suffix', () => {
    const rec: MeshCoreTelemetryRecord = {
      channel: 1,
      type: 136,
      value: { latitude: 30.1, longitude: -90.1, altitude: 10 },
    };
    const rows = recordToTelemetryRows(rec, 'pk', 1, 0);
    const types = rows.map((r) => r.telemetryType).sort();
    expect(types).toEqual([
      'mc_lpp_136_altitude',
      'mc_lpp_136_latitude',
      'mc_lpp_136_longitude',
    ]);
  });

  it('explodes array values into one row per index', () => {
    const rec: MeshCoreTelemetryRecord = { channel: 1, type: 113, value: [1, 2, 3] };
    const rows = recordToTelemetryRows(rec, 'pk', 1, 0);
    expect(rows.map((r) => r.telemetryType)).toEqual([
      'mc_lpp_113_0',
      'mc_lpp_113_1',
      'mc_lpp_113_2',
    ]);
  });

  it('falls back to mc_lpp_<type> when the LPP type is unknown', () => {
    const rec: MeshCoreTelemetryRecord = { channel: 1, type: 9999, value: 42 };
    const rows = recordToTelemetryRows(rec, 'pk', 1, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0].telemetryType).toBe('mc_lpp_9999');
  });
});

// ============ Scheduler integration-ish tests ============

interface FakeManagerState {
  sourceId: string;
  connected: boolean;
  lastMeshTxAt: number;
  lastRequestedKey: string | null;
  recordsToReturn: MeshCoreTelemetryRecord[] | null;
}

function makeFakeManager(init: Partial<FakeManagerState>): MeshCoreManager & { _state: FakeManagerState } {
  const state: FakeManagerState = {
    sourceId: 'src-a',
    connected: true,
    lastMeshTxAt: 0,
    lastRequestedKey: null,
    recordsToReturn: [{ channel: 1, type: 116, value: 3.7 }],
    ...init,
  };
  const m: any = {
    sourceId: state.sourceId,
    isConnected: () => state.connected,
    getLastMeshTxAt: () => state.lastMeshTxAt,
    recordMeshTx: (when: number = Date.now()) => {
      state.lastMeshTxAt = when;
    },
    requestRemoteTelemetry: async (publicKey: string) => {
      state.lastRequestedKey = publicKey;
      return state.recordsToReturn;
    },
    _state: state,
  };
  return m as MeshCoreManager & { _state: FakeManagerState };
}

function makeRegistry(managers: MeshCoreManager[]): MeshCoreManagerRegistry {
  return { list: () => managers } as unknown as MeshCoreManagerRegistry;
}

describe('MeshCoreRemoteTelemetryScheduler.tickOneManager', () => {
  it('skips disconnected managers', async () => {
    const manager = makeFakeManager({ connected: false });
    const insertSpy = vi.fn().mockResolvedValue(0);
    const getNodes = vi.fn();
    const markRequested = vi.fn();
    const scheduler = new MeshCoreRemoteTelemetryScheduler({
      registry: makeRegistry([manager]),
      database: {
        meshcore: {
          getTelemetryEnabledNodes: getNodes,
          markTelemetryRequested: markRequested,
        },
        telemetry: { insertTelemetryBatch: insertSpy },
      },
      now: () => 10_000_000,
    });
    await scheduler.tickOneManager(manager);
    expect(getNodes).not.toHaveBeenCalled();
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('skips managers whose lastMeshTxAt is within the global minimum', async () => {
    const now = 10_000_000;
    const manager = makeFakeManager({ lastMeshTxAt: now - 30_000 }); // 30s ago, < 60s minimum
    const getNodes = vi.fn().mockResolvedValue([
      makeNode({ publicKey: 'a', telemetryEnabled: true, lastTelemetryRequestAt: null }),
    ]);
    const markRequested = vi.fn();
    const insertSpy = vi.fn().mockResolvedValue(0);
    const scheduler = new MeshCoreRemoteTelemetryScheduler({
      registry: makeRegistry([manager]),
      database: {
        meshcore: { getTelemetryEnabledNodes: getNodes, markTelemetryRequested: markRequested },
        telemetry: { insertTelemetryBatch: insertSpy },
      },
      minIntervalMs: MIN_INTERVAL_BETWEEN_REQUESTS_MS,
      now: () => now,
    });
    await scheduler.tickOneManager(manager);
    expect(getNodes).not.toHaveBeenCalled();
    expect((manager as any)._state.lastRequestedKey).toBeNull();
  });

  it('does not skip on first-ever tick (lastMeshTxAt=0)', async () => {
    const now = 10_000_000;
    const manager = makeFakeManager({ lastMeshTxAt: 0 });
    const getNodes = vi.fn().mockResolvedValue([
      makeNode({ publicKey: 'a', telemetryEnabled: true, lastTelemetryRequestAt: null }),
    ]);
    const markRequested = vi.fn();
    const insertSpy = vi.fn().mockResolvedValue(1);
    const scheduler = new MeshCoreRemoteTelemetryScheduler({
      registry: makeRegistry([manager]),
      database: {
        meshcore: { getTelemetryEnabledNodes: getNodes, markTelemetryRequested: markRequested },
        telemetry: { insertTelemetryBatch: insertSpy },
      },
      now: () => now,
    });
    await scheduler.tickOneManager(manager);
    expect((manager as any)._state.lastRequestedKey).toBe('a');
    expect(insertSpy).toHaveBeenCalledTimes(1);
  });

  it('issues at most one request per tick even with multiple eligible nodes', async () => {
    const now = 10_000_000;
    const manager = makeFakeManager({});
    const getNodes = vi.fn().mockResolvedValue([
      makeNode({ publicKey: 'a', telemetryEnabled: true, lastTelemetryRequestAt: null }),
      makeNode({ publicKey: 'b', telemetryEnabled: true, lastTelemetryRequestAt: null }),
      makeNode({ publicKey: 'c', telemetryEnabled: true, lastTelemetryRequestAt: null }),
    ]);
    const markRequested = vi.fn();
    const insertSpy = vi.fn().mockResolvedValue(1);
    const scheduler = new MeshCoreRemoteTelemetryScheduler({
      registry: makeRegistry([manager]),
      database: {
        meshcore: { getTelemetryEnabledNodes: getNodes, markTelemetryRequested: markRequested },
        telemetry: { insertTelemetryBatch: insertSpy },
      },
      now: () => now,
    });
    await scheduler.tickOneManager(manager);
    expect(markRequested).toHaveBeenCalledTimes(1);
    expect(insertSpy).toHaveBeenCalledTimes(1);
  });

  it('stamps the per-node lastTelemetryRequestAt before issuing the RF call', async () => {
    const now = 10_000_000;
    const manager = makeFakeManager({});
    const callOrder: string[] = [];
    const markRequested = vi.fn(async () => {
      callOrder.push('mark');
    });
    const originalRequest = manager.requestRemoteTelemetry;
    manager.requestRemoteTelemetry = vi.fn(async (pk: string) => {
      callOrder.push('request');
      return originalRequest.call(manager, pk);
    }) as typeof manager.requestRemoteTelemetry;

    const scheduler = new MeshCoreRemoteTelemetryScheduler({
      registry: makeRegistry([manager]),
      database: {
        meshcore: {
          getTelemetryEnabledNodes: vi.fn().mockResolvedValue([
            makeNode({ publicKey: 'a', telemetryEnabled: true, lastTelemetryRequestAt: null }),
          ]),
          markTelemetryRequested: markRequested,
        },
        telemetry: { insertTelemetryBatch: vi.fn().mockResolvedValue(1) },
      },
      now: () => now,
    });
    await scheduler.tickOneManager(manager);
    expect(callOrder).toEqual(['mark', 'request']);
  });

  it('does NOT write telemetry rows when the RF response is empty', async () => {
    const now = 10_000_000;
    const manager = makeFakeManager({ recordsToReturn: [] });
    const insertSpy = vi.fn().mockResolvedValue(0);
    const scheduler = new MeshCoreRemoteTelemetryScheduler({
      registry: makeRegistry([manager]),
      database: {
        meshcore: {
          getTelemetryEnabledNodes: vi.fn().mockResolvedValue([
            makeNode({ publicKey: 'a', telemetryEnabled: true, lastTelemetryRequestAt: null }),
          ]),
          markTelemetryRequested: vi.fn(),
        },
        telemetry: { insertTelemetryBatch: insertSpy },
      },
      now: () => now,
    });
    await scheduler.tickOneManager(manager);
    expect(insertSpy).not.toHaveBeenCalled();
  });
});
