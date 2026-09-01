/**
 * MeshCoreTimeSyncScheduler tests (#4916).
 *
 * Covers the pure helpers (`isNodeEligible`, `pickMostOverdue`,
 * `clampIntervalMinutes`) and `tickOneManager`: the receive-only (#4547) skip,
 * the SHARED per-source 60s mesh-TX floor (the guarantee that a time-sync
 * never collides with a telemetry or neighbours poll — all three read
 * `getLastMeshTxAt`), the pre-stamp ordering (`markTimeSyncRequested` +
 * `recordMeshTx` BEFORE the RF round-trips), and the four `syncNodeTime`
 * outcomes.
 *
 * The stamp-before-send ordering is the load-bearing one here. A time-sync is
 * four packets, and its two most likely failure modes — an offline repeater
 * and one whose RTC runs ahead (firmware refuses to move a clock backwards) —
 * are both persistent. If the stamp only landed on success, either would be
 * retried on every single tick forever.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  MeshCoreTimeSyncScheduler,
  isNodeEligible,
  pickMostOverdue,
  clampIntervalMinutes,
  DEFAULT_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  MAX_INTERVAL_MINUTES,
  type TimeSyncSchedulerDatabase,
} from './meshcoreTimeSyncScheduler.js';
import type { DbMeshCoreNode } from '../../db/repositories/meshcore.js';
import type { MeshCoreManager } from '../meshcoreManager.js';
import type { SourceManagerRegistry } from '../sourceManagerRegistry.js';

type SyncResult = Awaited<ReturnType<MeshCoreManager['syncNodeTime']>>;

function node(over: Partial<DbMeshCoreNode>): DbMeshCoreNode {
  return {
    publicKey: 'pk-x',
    timeSyncEnabled: true,
    timeSyncIntervalMinutes: DEFAULT_INTERVAL_MINUTES,
    lastTimeSyncAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as unknown as DbMeshCoreNode;
}

const HOUR = 60 * 60_000;

describe('constants', () => {
  it('defaults to 12 hours — far slower than the 15-minute Meshtastic equivalent', () => {
    // One MeshCore sync is four packets (login + reply, then the CLI command
    // + reply) versus Meshtastic's one admin packet, so the cadence is not
    // comparable and must not be "harmonised" with it.
    expect(DEFAULT_INTERVAL_MINUTES).toBe(720);
  });

  it('floors at 1 hour and ceilings at 7 days', () => {
    expect(MIN_INTERVAL_MINUTES).toBe(60);
    expect(MAX_INTERVAL_MINUTES).toBe(7 * 24 * 60);
  });
});

describe('clampIntervalMinutes', () => {
  it('rejects non-numeric and non-positive values rather than substituting a default', () => {
    expect(clampIntervalMinutes('nonsense')).toBeNull();
    expect(clampIntervalMinutes(0)).toBeNull();
    expect(clampIntervalMinutes(-5)).toBeNull();
    expect(clampIntervalMinutes(undefined)).toBeNull();
  });

  it('raises a sub-floor value to the 1-hour floor', () => {
    expect(clampIntervalMinutes(5)).toBe(MIN_INTERVAL_MINUTES);
    expect(clampIntervalMinutes(59)).toBe(MIN_INTERVAL_MINUTES);
  });

  it('caps an over-ceiling value at 7 days', () => {
    expect(clampIntervalMinutes(999_999)).toBe(MAX_INTERVAL_MINUTES);
  });

  it('passes an in-range value through, rounded', () => {
    expect(clampIntervalMinutes(720)).toBe(720);
    expect(clampIntervalMinutes(90.4)).toBe(90);
  });
});

describe('isNodeEligible', () => {
  it('rejects disabled nodes', () => {
    expect(isNodeEligible(node({ timeSyncEnabled: false }), 0)).toBe(false);
  });

  it('rejects a non-positive interval', () => {
    expect(isNodeEligible(node({ timeSyncIntervalMinutes: 0 }), 1_000_000_000)).toBe(false);
  });

  it('accepts a node never synced before', () => {
    expect(isNodeEligible(node({ lastTimeSyncAt: null }), 1_000_000_000)).toBe(true);
  });

  it('rejects a node still inside its interval', () => {
    const now = 1_000_000_000;
    expect(
      isNodeEligible(node({ timeSyncIntervalMinutes: 720, lastTimeSyncAt: now - 6 * HOUR }), now),
    ).toBe(false);
  });

  it('accepts a node past its interval', () => {
    const now = 1_000_000_000;
    expect(
      isNodeEligible(node({ timeSyncIntervalMinutes: 720, lastTimeSyncAt: now - 13 * HOUR }), now),
    ).toBe(true);
  });

  it('applies the 1-hour floor at READ time to a sub-floor stored interval', () => {
    // A row edited directly in the database (or written before the floor
    // existed) must not be able to drive a faster cadence than the scheduler
    // permits — the floor is not a UI-only guard.
    const now = 1_000_000_000;
    const rogue = node({ timeSyncIntervalMinutes: 5, lastTimeSyncAt: now - 10 * 60_000 });
    // 10 minutes have passed, which would satisfy a stored 5-minute interval,
    // but the floor holds it to an hour.
    expect(isNodeEligible(rogue, now)).toBe(false);
    expect(isNodeEligible(node({ timeSyncIntervalMinutes: 5, lastTimeSyncAt: now - 61 * 60_000 }), now)).toBe(true);
  });
});

describe('pickMostOverdue', () => {
  it('returns undefined when nothing is eligible', () => {
    expect(pickMostOverdue([node({ timeSyncEnabled: false })], 1_000_000_000)).toBeUndefined();
  });

  it('picks the most overdue eligible node', () => {
    const now = 1_000_000_000;
    const a = node({ publicKey: 'aaa', lastTimeSyncAt: now - 13 * HOUR });
    const b = node({ publicKey: 'bbb', lastTimeSyncAt: now - 40 * HOUR });
    expect(pickMostOverdue([a, b], now)?.publicKey).toBe('bbb');
  });

  it('breaks a tie deterministically on publicKey so two nodes do not ping-pong', () => {
    const now = 1_000_000_000;
    const a = node({ publicKey: 'bbb', lastTimeSyncAt: null });
    const b = node({ publicKey: 'aaa', lastTimeSyncAt: null });
    expect(pickMostOverdue([a, b], now)?.publicKey).toBe('aaa');
    expect(pickMostOverdue([b, a], now)?.publicKey).toBe('aaa');
  });
});

// ============ tickOneManager ============

interface FakeState {
  sourceId: string;
  connected: boolean;
  receiveOnly: boolean;
  lastMeshTxAt: number;
  syncedFor: string[];
  syncResult: SyncResult;
  syncThrows: boolean;
}

function makeFakeManager(init: Partial<FakeState>): MeshCoreManager & { _state: FakeState } {
  const state: FakeState = {
    sourceId: 'src-a',
    connected: true,
    receiveOnly: false,
    lastMeshTxAt: 0,
    syncedFor: [],
    syncResult: { status: 'ok', reply: 'OK', elapsedMs: 1200 },
    syncThrows: false,
    ...init,
  };
  const m: any = {
    sourceId: state.sourceId,
    sourceType: 'meshcore',
    isConnected: () => state.connected,
    isReceiveOnly: () => state.receiveOnly,
    getLastMeshTxAt: () => state.lastMeshTxAt,
    recordMeshTx: (when: number = Date.now()) => { state.lastMeshTxAt = when; },
    syncNodeTime: async (publicKey: string) => {
      state.syncedFor.push(publicKey);
      if (state.syncThrows) throw new Error('boom');
      return state.syncResult;
    },
    _state: state,
  };
  return m as MeshCoreManager & { _state: FakeState };
}

function makeRegistry(managers: MeshCoreManager[]): SourceManagerRegistry {
  return { getAllManagers: () => managers } as unknown as SourceManagerRegistry;
}

function makeDb(nodes: DbMeshCoreNode[]): {
  db: TimeSyncSchedulerDatabase;
  getEnabled: ReturnType<typeof vi.fn>;
  mark: ReturnType<typeof vi.fn>;
} {
  const getEnabled = vi.fn().mockResolvedValue(nodes);
  const mark = vi.fn().mockResolvedValue(undefined);
  return {
    db: { meshcore: { getTimeSyncEnabledNodes: getEnabled, markTimeSyncRequested: mark } },
    getEnabled,
    mark,
  };
}

function makeScheduler(
  manager: MeshCoreManager,
  db: TimeSyncSchedulerDatabase,
  now: number,
): MeshCoreTimeSyncScheduler {
  return new MeshCoreTimeSyncScheduler({
    registry: makeRegistry([manager]),
    database: db,
    now: () => now,
  });
}

describe('MeshCoreTimeSyncScheduler.tickOneManager', () => {
  const NOW = 1_000_000_000;

  it('skips a receive-only manager before the enabled-nodes DB read', async () => {
    // Must short-circuit ahead of any send primitive: syncNodeTime →
    // ensureSavedLogin → requireTransmit would otherwise throw (#4547).
    const manager = makeFakeManager({ receiveOnly: true });
    const { db, getEnabled } = makeDb([node({ publicKey: 'pk-a' })]);

    await makeScheduler(manager, db, NOW).tickOneManager(manager);

    expect(getEnabled).not.toHaveBeenCalled();
    expect(manager._state.syncedFor).toEqual([]);
  });

  it('skips a disconnected manager', async () => {
    const manager = makeFakeManager({ connected: false });
    const { db, getEnabled } = makeDb([node({ publicKey: 'pk-a' })]);

    await makeScheduler(manager, db, NOW).tickOneManager(manager);

    expect(getEnabled).not.toHaveBeenCalled();
  });

  it('syncs the most-overdue node and pre-stamps mark + recordMeshTx', async () => {
    const manager = makeFakeManager({ lastMeshTxAt: 0 });
    const { db, mark } = makeDb([node({ publicKey: 'pk-a', lastTimeSyncAt: null })]);

    await makeScheduler(manager, db, NOW).tickOneManager(manager);

    expect(mark).toHaveBeenCalledWith('src-a', 'pk-a', NOW);
    expect(manager._state.lastMeshTxAt).toBe(NOW); // recordMeshTx pre-stamp
    expect(manager._state.syncedFor).toEqual(['pk-a']);
  });

  it('honours the shared 60s floor — a recent neighbours TX blocks a time-sync', async () => {
    // lastMeshTxAt was set 30s ago (e.g. by the neighbours scheduler on the
    // same source). Time-sync must back off, so no two of the three MeshCore
    // schedulers transmit within 60s of each other.
    const manager = makeFakeManager({ lastMeshTxAt: NOW - 30_000 });
    const { db, getEnabled } = makeDb([node({ publicKey: 'pk-a' })]);

    await makeScheduler(manager, db, NOW).tickOneManager(manager);

    expect(getEnabled).not.toHaveBeenCalled();
    expect(manager._state.syncedFor).toEqual([]);
  });

  it('allows a sync once 60s has elapsed since the last mesh TX', async () => {
    const manager = makeFakeManager({ lastMeshTxAt: NOW - 61_000 });
    const { db } = makeDb([node({ publicKey: 'pk-a' })]);

    await makeScheduler(manager, db, NOW).tickOneManager(manager);

    expect(manager._state.syncedFor).toEqual(['pk-a']);
  });

  it('sends at most one sync per manager per tick', async () => {
    const manager = makeFakeManager({});
    const { db } = makeDb([
      node({ publicKey: 'pk-a', lastTimeSyncAt: null }),
      node({ publicKey: 'pk-b', lastTimeSyncAt: null }),
      node({ publicKey: 'pk-c', lastTimeSyncAt: null }),
    ]);

    await makeScheduler(manager, db, NOW).tickOneManager(manager);

    expect(manager._state.syncedFor).toHaveLength(1);
  });

  it('does nothing when no node is enabled', async () => {
    const manager = makeFakeManager({});
    const { db } = makeDb([]);

    await makeScheduler(manager, db, NOW).tickOneManager(manager);

    expect(manager._state.syncedFor).toEqual([]);
  });

  it('does nothing when every enabled node is still inside its interval', async () => {
    const manager = makeFakeManager({});
    const { db, mark } = makeDb([
      node({ publicKey: 'pk-a', timeSyncIntervalMinutes: 720, lastTimeSyncAt: NOW - HOUR }),
    ]);

    await makeScheduler(manager, db, NOW).tickOneManager(manager);

    expect(manager._state.syncedFor).toEqual([]);
    expect(mark).not.toHaveBeenCalled();
  });

  // --- the four syncNodeTime outcomes, all of which must still be stamped ---

  it('stamps even when the repeater REJECTS the push (clock running ahead)', async () => {
    // Firmware refuses to move a clock backwards. That is persistent: without
    // the pre-stamp this node would be retried on every single tick, four
    // packets at a time, until someone fixed its RTC by hand.
    const manager = makeFakeManager({
      syncResult: { status: 'rejected', reply: 'ERR: clock cannot go backwards' },
    });
    const { db, mark } = makeDb([node({ publicKey: 'pk-a' })]);

    await makeScheduler(manager, db, NOW).tickOneManager(manager);

    expect(mark).toHaveBeenCalledWith('src-a', 'pk-a', NOW);
    expect(manager._state.lastMeshTxAt).toBe(NOW);
  });

  it('stamps even when there is NO SAVED CREDENTIAL', async () => {
    // Equally persistent — it will never succeed until the user saves a
    // password, so it must not be retried every tick.
    const manager = makeFakeManager({ syncResult: { status: 'no-credential' } });
    const { db, mark } = makeDb([node({ publicKey: 'pk-a' })]);

    await makeScheduler(manager, db, NOW).tickOneManager(manager);

    expect(mark).toHaveBeenCalledWith('src-a', 'pk-a', NOW);
  });

  it('stamps even when the sync FAILS with no reply', async () => {
    const manager = makeFakeManager({ syncResult: { status: 'failed', error: 'timeout' } });
    const { db, mark } = makeDb([node({ publicKey: 'pk-a' })]);

    await makeScheduler(manager, db, NOW).tickOneManager(manager);

    expect(mark).toHaveBeenCalledWith('src-a', 'pk-a', NOW);
  });

  it('swallows a throwing syncNodeTime — one bad node cannot kill the tick', async () => {
    const manager = makeFakeManager({ syncThrows: true });
    const { db, mark } = makeDb([node({ publicKey: 'pk-a' })]);

    await expect(makeScheduler(manager, db, NOW).tickOneManager(manager)).resolves.toBeUndefined();
    expect(mark).toHaveBeenCalled();
  });
});

describe('MeshCoreTimeSyncScheduler.tick', () => {
  const NOW = 1_000_000_000;

  it('ignores non-MeshCore managers in the registry', async () => {
    const meshcore = makeFakeManager({ sourceId: 'src-a' });
    const meshtastic: any = { sourceId: 'src-b', sourceType: 'meshtastic_tcp' };
    const { db } = makeDb([node({ publicKey: 'pk-a' })]);
    const scheduler = new MeshCoreTimeSyncScheduler({
      registry: makeRegistry([meshcore, meshtastic]),
      database: db,
      now: () => NOW,
    });

    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(meshcore._state.syncedFor).toEqual(['pk-a']);
  });

  it('keeps going when one manager throws', async () => {
    const bad = makeFakeManager({ sourceId: 'src-bad' });
    (bad as any).isConnected = () => { throw new Error('registry churn'); };
    const good = makeFakeManager({ sourceId: 'src-good' });
    const { db } = makeDb([node({ publicKey: 'pk-a' })]);
    const scheduler = new MeshCoreTimeSyncScheduler({
      registry: makeRegistry([bad, good]),
      database: db,
      now: () => NOW,
    });

    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(good._state.syncedFor).toEqual(['pk-a']);
  });
});
