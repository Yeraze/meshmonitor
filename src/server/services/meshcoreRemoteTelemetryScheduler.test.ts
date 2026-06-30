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
  statusToTelemetryRows,
  MIN_INTERVAL_BETWEEN_REQUESTS_MS,
} from './meshcoreRemoteTelemetryScheduler.js';
import type { DbMeshCoreNode } from '../../db/repositories/meshcore.js';
import type {
  MeshCoreManager,
  MeshCoreStatus,
  MeshCoreTelemetryRecord,
} from '../meshcoreManager.js';
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
    expect(rows[0].telemetryType).toBe('mc_temperature_ch1');
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
      'mc_lpp_136_ch1_altitude',
      'mc_lpp_136_ch1_latitude',
      'mc_lpp_136_ch1_longitude',
    ]);
  });

  it('explodes array values into one row per index', () => {
    const rec: MeshCoreTelemetryRecord = { channel: 1, type: 113, value: [1, 2, 3] };
    const rows = recordToTelemetryRows(rec, 'pk', 1, 0);
    expect(rows.map((r) => r.telemetryType)).toEqual([
      'mc_lpp_113_ch1_0',
      'mc_lpp_113_ch1_1',
      'mc_lpp_113_ch1_2',
    ]);
  });

  it('falls back to mc_lpp_<type> when the LPP type is unknown', () => {
    const rec: MeshCoreTelemetryRecord = { channel: 1, type: 9999, value: 42 };
    const rows = recordToTelemetryRows(rec, 'pk', 1, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0].telemetryType).toBe('mc_lpp_9999_ch1');
  });

  // Regression for #3139: multiple LPP records of the same `type` on
  // different `channel` bytes must produce distinct telemetryType strings.
  // Before the fix, all four below collapsed onto `mc_battery_volts` and
  // were indistinguishable on the chart-per-type frontend.
  it('preserves the LPP channel byte in the telemetry type', () => {
    const recs: MeshCoreTelemetryRecord[] = [
      { channel: 1, type: 116, value: 4.10 }, // 116 = voltage → battery_volts in LPP_TYPE_NAMES
      { channel: 2, type: 116, value: 12.50 },
      { channel: 3, type: 116, value: 5.05 },
      { channel: 4, type: 116, value: 3.30 },
    ];
    const rows = recs.flatMap((r) => recordToTelemetryRows(r, 'pk', 1, 1_000));
    const types = rows.map((r) => r.telemetryType);
    expect(types).toEqual([
      'mc_battery_volts_ch1',
      'mc_battery_volts_ch2',
      'mc_battery_volts_ch3',
      'mc_battery_volts_ch4',
    ]);
    expect(rows.map((r) => r.value)).toEqual([4.10, 12.50, 5.05, 3.30]);
  });

  it('does not write the LPP channel into the row\'s mesh-channel column', () => {
    // The `channel` column on telemetry rows tracks the *mesh* channel slot
    // (used by maskTelemetryByChannel for per-channel permissions). LPP's
    // `channel` is a different concept — must not leak into that column.
    const rec: MeshCoreTelemetryRecord = { channel: 3, type: 103, value: 21.5 };
    const rows = recordToTelemetryRows(rec, 'pk', 1, 0);
    expect(rows[0].channel).toBeUndefined();
  });
});

// ============ Scheduler integration-ish tests ============

interface FakeManagerState {
  sourceId: string;
  connected: boolean;
  lastMeshTxAt: number;
  lastRequestedKey: string | null;
  recordsToReturn: MeshCoreTelemetryRecord[] | null;
  /** Status returned by `requestNodeStatus`. `null` simulates timeout. */
  statusToReturn: MeshCoreStatus | null;
  /** Public keys we've successfully guest-logged-into. */
  guestLoginCalledFor: string[];
  /** `ensureGuestLogin` resolves to this value. */
  guestLoginResult: boolean;
  /** Order of sub-call invocations within tickOneManager for ordering assertions. */
  callOrder: string[];
}

function makeFakeManager(init: Partial<FakeManagerState>): MeshCoreManager & { _state: FakeManagerState } {
  const state: FakeManagerState = {
    sourceId: 'src-a',
    connected: true,
    lastMeshTxAt: 0,
    lastRequestedKey: null,
    recordsToReturn: [{ channel: 1, type: 116, value: 3.7 }],
    statusToReturn: null,
    guestLoginCalledFor: [],
    guestLoginResult: true,
    callOrder: [],
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
      state.callOrder.push('requestRemoteTelemetry');
      state.lastRequestedKey = publicKey;
      return state.recordsToReturn;
    },
    requestNodeStatus: async (_publicKey: string) => {
      state.callOrder.push('requestNodeStatus');
      return state.statusToReturn;
    },
    ensureGuestLogin: async (publicKey: string) => {
      state.callOrder.push('ensureGuestLogin');
      state.guestLoginCalledFor.push(publicKey);
      return state.guestLoginResult;
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
          upsertNode: vi.fn().mockResolvedValue(undefined),
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
        meshcore: { getTelemetryEnabledNodes: getNodes, markTelemetryRequested: markRequested, upsertNode: vi.fn().mockResolvedValue(undefined) },
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
        meshcore: { getTelemetryEnabledNodes: getNodes, markTelemetryRequested: markRequested, upsertNode: vi.fn().mockResolvedValue(undefined) },
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
        meshcore: { getTelemetryEnabledNodes: getNodes, markTelemetryRequested: markRequested, upsertNode: vi.fn().mockResolvedValue(undefined) },
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
          upsertNode: vi.fn().mockResolvedValue(undefined),
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
          upsertNode: vi.fn().mockResolvedValue(undefined),
        },
        telemetry: { insertTelemetryBatch: insertSpy },
      },
      now: () => now,
    });
    await scheduler.tickOneManager(manager);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('does NOT call requestNodeStatus or ensureGuestLogin for a Companion target', async () => {
    const now = 10_000_000;
    const manager = makeFakeManager({});
    const scheduler = new MeshCoreRemoteTelemetryScheduler({
      registry: makeRegistry([manager]),
      database: {
        meshcore: {
          getTelemetryEnabledNodes: vi.fn().mockResolvedValue([
            makeNode({ publicKey: 'companion-a', telemetryEnabled: true, advType: 1, lastTelemetryRequestAt: null }),
          ]),
          markTelemetryRequested: vi.fn(),
          upsertNode: vi.fn().mockResolvedValue(undefined),
        },
        telemetry: { insertTelemetryBatch: vi.fn().mockResolvedValue(1) },
      },
      now: () => now,
    });
    await scheduler.tickOneManager(manager);
    expect(manager._state.callOrder).toEqual(['requestRemoteTelemetry']);
    expect(manager._state.guestLoginCalledFor).toEqual([]);
  });

  it('also requests status from a Repeater target and writes status rows', async () => {
    const now = 10_000_000;
    const status: MeshCoreStatus = {
      batteryMv: 3700,
      uptimeSecs: 12_345,
      queueLen: 2,
      lastRssi: -82,
      lastSnr: 9,
      packetsRecv: 1000,
      packetsSent: 800,
    };
    const manager = makeFakeManager({
      statusToReturn: status,
      recordsToReturn: [], // no LPP payload — common for stock repeaters
    });
    const insertSpy = vi.fn().mockResolvedValue(7);
    const scheduler = new MeshCoreRemoteTelemetryScheduler({
      registry: makeRegistry([manager]),
      database: {
        meshcore: {
          getTelemetryEnabledNodes: vi.fn().mockResolvedValue([
            makeNode({ publicKey: 'rep-a', telemetryEnabled: true, advType: 2, lastTelemetryRequestAt: null }),
          ]),
          markTelemetryRequested: vi.fn(),
          upsertNode: vi.fn().mockResolvedValue(undefined),
        },
        telemetry: { insertTelemetryBatch: insertSpy },
      },
      now: () => now,
    });
    await scheduler.tickOneManager(manager);
    expect(insertSpy).toHaveBeenCalledTimes(1);
    const rows = insertSpy.mock.calls[0][0] as Array<{ telemetryType: string; value: number }>;
    const types = rows.map((r) => r.telemetryType).sort();
    expect(types).toContain('mc_status_battery_volts');
    expect(types).toContain('mc_status_uptime_secs');
    expect(types).toContain('mc_status_queue_len');
    expect(types).toContain('mc_status_last_rssi');
    expect(types).toContain('mc_status_last_snr');
    const battery = rows.find((r) => r.telemetryType === 'mc_status_battery_volts');
    expect(battery?.value).toBe(3.7); // mV → V
  });

  it('runs guest-login BEFORE the LPP request on a Repeater target', async () => {
    const now = 10_000_000;
    const manager = makeFakeManager({
      statusToReturn: { batteryMv: 3500 },
      recordsToReturn: [{ channel: 1, type: 103, value: 21.5 }],
    });
    const scheduler = new MeshCoreRemoteTelemetryScheduler({
      registry: makeRegistry([manager]),
      database: {
        meshcore: {
          getTelemetryEnabledNodes: vi.fn().mockResolvedValue([
            makeNode({ publicKey: 'rep-a', telemetryEnabled: true, advType: 2, lastTelemetryRequestAt: null }),
          ]),
          markTelemetryRequested: vi.fn(),
          upsertNode: vi.fn().mockResolvedValue(undefined),
        },
        telemetry: { insertTelemetryBatch: vi.fn().mockResolvedValue(2) },
      },
      now: () => now,
    });
    await scheduler.tickOneManager(manager);
    expect(manager._state.callOrder).toEqual([
      'requestNodeStatus',
      'ensureGuestLogin',
      'requestRemoteTelemetry',
    ]);
    expect(manager._state.guestLoginCalledFor).toEqual(['rep-a']);
  });

  it('still attempts the LPP request when guest-login fails', async () => {
    const now = 10_000_000;
    const manager = makeFakeManager({
      statusToReturn: null,
      recordsToReturn: [{ channel: 1, type: 116, value: 3.4 }],
      guestLoginResult: false,
    });
    const insertSpy = vi.fn().mockResolvedValue(1);
    const scheduler = new MeshCoreRemoteTelemetryScheduler({
      registry: makeRegistry([manager]),
      database: {
        meshcore: {
          getTelemetryEnabledNodes: vi.fn().mockResolvedValue([
            makeNode({ publicKey: 'rep-a', telemetryEnabled: true, advType: 2, lastTelemetryRequestAt: null }),
          ]),
          markTelemetryRequested: vi.fn(),
          upsertNode: vi.fn().mockResolvedValue(undefined),
        },
        telemetry: { insertTelemetryBatch: insertSpy },
      },
      now: () => now,
    });
    await scheduler.tickOneManager(manager);
    expect(manager._state.callOrder).toContain('requestRemoteTelemetry');
    expect(insertSpy).toHaveBeenCalledTimes(1);
  });

  it('treats Room Server (advType=3) the same as Repeater (advType=2)', async () => {
    const now = 10_000_000;
    const manager = makeFakeManager({ statusToReturn: { batteryMv: 4100 }, recordsToReturn: [] });
    const scheduler = new MeshCoreRemoteTelemetryScheduler({
      registry: makeRegistry([manager]),
      database: {
        meshcore: {
          getTelemetryEnabledNodes: vi.fn().mockResolvedValue([
            makeNode({ publicKey: 'room-a', telemetryEnabled: true, advType: 3, lastTelemetryRequestAt: null }),
          ]),
          markTelemetryRequested: vi.fn(),
          upsertNode: vi.fn().mockResolvedValue(undefined),
        },
        telemetry: { insertTelemetryBatch: vi.fn().mockResolvedValue(1) },
      },
      now: () => now,
    });
    await scheduler.tickOneManager(manager);
    expect(manager._state.callOrder).toContain('requestNodeStatus');
    expect(manager._state.guestLoginCalledFor).toEqual(['room-a']);
  });

  // Regression for #3417: batteryMv from requestNodeStatus must be persisted
  // to meshcore_nodes so getLowVoltageNodes() can find low-battery devices.
  it('persists batteryMv to meshcore_nodes when requestNodeStatus returns it', async () => {
    const now = 10_000_000;
    const manager = makeFakeManager({
      statusToReturn: { batteryMv: 3700, uptimeSecs: 500 },
      recordsToReturn: [],
    });
    const upsertNode = vi.fn().mockResolvedValue(undefined);
    const scheduler = new MeshCoreRemoteTelemetryScheduler({
      registry: makeRegistry([manager]),
      database: {
        meshcore: {
          getTelemetryEnabledNodes: vi.fn().mockResolvedValue([
            makeNode({ publicKey: 'rep-a', telemetryEnabled: true, advType: 2, lastTelemetryRequestAt: null }),
          ]),
          markTelemetryRequested: vi.fn(),
          upsertNode,
        },
        telemetry: { insertTelemetryBatch: vi.fn().mockResolvedValue(2) },
      },
      now: () => now,
    });
    await scheduler.tickOneManager(manager);
    expect(upsertNode).toHaveBeenCalledWith(
      expect.objectContaining({ publicKey: 'rep-a', batteryMv: 3700 }),
      'src-a',
    );
  });

  it('does not call upsertNode when requestNodeStatus returns no battery voltage', async () => {
    const now = 10_000_000;
    const manager = makeFakeManager({
      statusToReturn: { uptimeSecs: 500 }, // no batteryMv
      recordsToReturn: [{ channel: 1, type: 103, value: 21.5 }],
    });
    const upsertNode = vi.fn().mockResolvedValue(undefined);
    const scheduler = new MeshCoreRemoteTelemetryScheduler({
      registry: makeRegistry([manager]),
      database: {
        meshcore: {
          getTelemetryEnabledNodes: vi.fn().mockResolvedValue([
            makeNode({ publicKey: 'rep-a', telemetryEnabled: true, advType: 2, lastTelemetryRequestAt: null }),
          ]),
          markTelemetryRequested: vi.fn(),
          upsertNode,
        },
        telemetry: { insertTelemetryBatch: vi.fn().mockResolvedValue(1) },
      },
      now: () => now,
    });
    await scheduler.tickOneManager(manager);
    expect(upsertNode).not.toHaveBeenCalled();
  });

  it('persists GPS position to meshcore_nodes when LPP response includes type 136', async () => {
    const now = 10_000_000;
    const manager = makeFakeManager({
      recordsToReturn: [
        { channel: 0, type: 136, value: { latitude: 48.8566, longitude: 2.3522, altitude: 35 } },
        { channel: 1, type: 103, value: 22.0 },
      ],
    });
    const upsertNode = vi.fn().mockResolvedValue(undefined);
    const scheduler = new MeshCoreRemoteTelemetryScheduler({
      registry: makeRegistry([manager]),
      database: {
        meshcore: {
          getTelemetryEnabledNodes: vi.fn().mockResolvedValue([
            makeNode({ publicKey: 'companion-b', telemetryEnabled: true, advType: 1, lastTelemetryRequestAt: null }),
          ]),
          markTelemetryRequested: vi.fn(),
          upsertNode,
        },
        telemetry: { insertTelemetryBatch: vi.fn().mockResolvedValue(4) },
      },
      now: () => now,
    });
    await scheduler.tickOneManager(manager);
    expect(upsertNode).toHaveBeenCalledWith(
      expect.objectContaining({ publicKey: 'companion-b', latitude: 48.8566, longitude: 2.3522 }),
      'src-a',
    );
  });

  it('does not persist GPS position when LPP type 136 value is Null Island (0,0)', async () => {
    const now = 10_000_000;
    const manager = makeFakeManager({
      recordsToReturn: [
        { channel: 0, type: 136, value: { latitude: 0, longitude: 0, altitude: 0 } },
      ],
    });
    const upsertNode = vi.fn().mockResolvedValue(undefined);
    const scheduler = new MeshCoreRemoteTelemetryScheduler({
      registry: makeRegistry([manager]),
      database: {
        meshcore: {
          getTelemetryEnabledNodes: vi.fn().mockResolvedValue([
            makeNode({ publicKey: 'companion-c', telemetryEnabled: true, advType: 1, lastTelemetryRequestAt: null }),
          ]),
          markTelemetryRequested: vi.fn(),
          upsertNode,
        },
        telemetry: { insertTelemetryBatch: vi.fn().mockResolvedValue(3) },
      },
      now: () => now,
    });
    await scheduler.tickOneManager(manager);
    expect(upsertNode).not.toHaveBeenCalled();
  });

  it('does not persist GPS position when LPP type 136 value lacks lat/lon fields', async () => {
    const now = 10_000_000;
    const manager = makeFakeManager({
      recordsToReturn: [
        { channel: 0, type: 136, value: { altitude: 35 } }, // lat/lon missing
      ],
    });
    const upsertNode = vi.fn().mockResolvedValue(undefined);
    const scheduler = new MeshCoreRemoteTelemetryScheduler({
      registry: makeRegistry([manager]),
      database: {
        meshcore: {
          getTelemetryEnabledNodes: vi.fn().mockResolvedValue([
            makeNode({ publicKey: 'companion-d', telemetryEnabled: true, advType: 1, lastTelemetryRequestAt: null }),
          ]),
          markTelemetryRequested: vi.fn(),
          upsertNode,
        },
        telemetry: { insertTelemetryBatch: vi.fn().mockResolvedValue(1) },
      },
      now: () => now,
    });
    await scheduler.tickOneManager(manager);
    expect(upsertNode).not.toHaveBeenCalled();
  });

  it('does not insert when both status and LPP are empty on a Repeater', async () => {
    const now = 10_000_000;
    const manager = makeFakeManager({ statusToReturn: null, recordsToReturn: [] });
    const insertSpy = vi.fn().mockResolvedValue(0);
    const scheduler = new MeshCoreRemoteTelemetryScheduler({
      registry: makeRegistry([manager]),
      database: {
        meshcore: {
          getTelemetryEnabledNodes: vi.fn().mockResolvedValue([
            makeNode({ publicKey: 'rep-a', telemetryEnabled: true, advType: 2, lastTelemetryRequestAt: null }),
          ]),
          markTelemetryRequested: vi.fn(),
          upsertNode: vi.fn().mockResolvedValue(undefined),
        },
        telemetry: { insertTelemetryBatch: insertSpy },
      },
      now: () => now,
    });
    await scheduler.tickOneManager(manager);
    expect(insertSpy).not.toHaveBeenCalled();
  });
});

describe('statusToTelemetryRows', () => {
  it('maps the headline operational fields with sensible units', () => {
    const status: MeshCoreStatus = {
      batteryMv: 3850,
      uptimeSecs: 7200,
      queueLen: 3,
      noiseFloor: -110,
      lastRssi: -75,
      lastSnr: 12,
      packetsRecv: 5000,
      packetsSent: 4200,
      airTimeSecs: 350,
      sentFlood: 100,
      sentDirect: 4100,
      recvFlood: 800,
      recvDirect: 4200,
      errors: 2,
      directDups: 7,
      floodDups: 11,
    };
    const rows = statusToTelemetryRows(status, 'pk', 99, 1_700_000_000);
    const byType = new Map(rows.map((r) => [r.telemetryType, r]));

    expect(byType.get('mc_status_battery_volts')?.value).toBe(3.85);
    expect(byType.get('mc_status_battery_volts')?.unit).toBe('V');
    expect(byType.get('mc_status_uptime_secs')?.value).toBe(7200);
    expect(byType.get('mc_status_uptime_secs')?.unit).toBe('s');
    expect(byType.get('mc_status_queue_len')?.value).toBe(3);
    expect(byType.get('mc_status_last_rssi')?.unit).toBe('dBm');
    expect(byType.get('mc_status_last_snr')?.unit).toBe('dB');
    expect(byType.get('mc_status_packets_recv')?.value).toBe(5000);
    expect(byType.get('mc_status_errors')?.value).toBe(2);
    expect(byType.get('mc_status_flood_dups')?.value).toBe(11);
    expect(rows.every((r) => r.nodeId === 'pk' && r.nodeNum === 99 && r.timestamp === 1_700_000_000)).toBe(true);
  });

  it('skips undefined fields rather than emitting NaN rows', () => {
    const rows = statusToTelemetryRows({ batteryMv: 3700 }, 'pk', 1, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0].telemetryType).toBe('mc_status_battery_volts');
  });

  it('preserves zero values (uptime starts at 0 and that is meaningful)', () => {
    const rows = statusToTelemetryRows({ uptimeSecs: 0, queueLen: 0 }, 'pk', 1, 0);
    const types = rows.map((r) => r.telemetryType).sort();
    expect(types).toEqual(['mc_status_queue_len', 'mc_status_uptime_secs']);
  });
});
