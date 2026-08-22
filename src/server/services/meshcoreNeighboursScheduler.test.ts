/**
 * MeshCoreNeighboursScheduler tests (#4618).
 *
 * Covers the pure helpers (`isNodeEligible`, `pickMostOverdue`) and
 * `tickOneManager`: the receive-only (#4547) skip, the SHARED per-source 60s
 * mesh-TX floor (the guarantee that a neighbours poll never collides with a
 * telemetry poll — both read `getLastMeshTxAt`), and the pre-stamp ordering
 * (`markNeighborsRequested` + `recordMeshTx` BEFORE the RF query).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  MeshCoreNeighboursScheduler,
  isNodeEligible,
  pickMostOverdue,
  type NeighboursSchedulerDatabase,
} from './meshcoreNeighboursScheduler.js';
import type { DbMeshCoreNode } from '../../db/repositories/meshcore.js';
import type { MeshCoreManager } from '../meshcoreManager.js';
import type { SourceManagerRegistry } from '../sourceManagerRegistry.js';

function node(over: Partial<DbMeshCoreNode>): DbMeshCoreNode {
  return {
    publicKey: 'pk-x',
    neighborsEnabled: true,
    neighborsIntervalMinutes: 60,
    lastNeighborsRequestAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as unknown as DbMeshCoreNode;
}

describe('isNodeEligible', () => {
  it('rejects disabled nodes', () => {
    expect(isNodeEligible(node({ neighborsEnabled: false }), 0)).toBe(false);
  });

  it('rejects a non-positive interval', () => {
    expect(isNodeEligible(node({ neighborsIntervalMinutes: 0 }), 1_000_000)).toBe(false);
  });

  it('accepts a node never polled before', () => {
    expect(isNodeEligible(node({ lastNeighborsRequestAt: null }), 100_000_000)).toBe(true);
  });

  it('rejects a node still inside its interval', () => {
    const now = 100_000_000;
    expect(isNodeEligible(node({ neighborsIntervalMinutes: 60, lastNeighborsRequestAt: now - 30 * 60_000 }), now)).toBe(false);
  });

  it('accepts a node past its interval', () => {
    const now = 100_000_000;
    expect(isNodeEligible(node({ neighborsIntervalMinutes: 60, lastNeighborsRequestAt: now - 61 * 60_000 }), now)).toBe(true);
  });
});

describe('pickMostOverdue', () => {
  it('returns undefined when nothing is eligible', () => {
    expect(pickMostOverdue([node({ neighborsEnabled: false })], 1_000_000)).toBeUndefined();
  });

  it('picks the most overdue eligible node, publicKey as tiebreaker', () => {
    const now = 100_000_000;
    const a = node({ publicKey: 'aaa', lastNeighborsRequestAt: now - 70 * 60_000 });
    const b = node({ publicKey: 'bbb', lastNeighborsRequestAt: now - 120 * 60_000 });
    expect(pickMostOverdue([a, b], now)?.publicKey).toBe('bbb');
  });
});

// ============ tickOneManager ============

interface FakeState {
  sourceId: string;
  connected: boolean;
  receiveOnly: boolean;
  lastMeshTxAt: number;
  polledFor: string[];
  pollResult: { total: number; written: number } | null;
}

function makeFakeManager(init: Partial<FakeState>): MeshCoreManager & { _state: FakeState } {
  const state: FakeState = {
    sourceId: 'src-a',
    connected: true,
    receiveOnly: false,
    lastMeshTxAt: 0,
    polledFor: [],
    pollResult: { total: 2, written: 2 },
    ...init,
  };
  const m: any = {
    sourceId: state.sourceId,
    sourceType: 'meshcore',
    isConnected: () => state.connected,
    isReceiveOnly: () => state.receiveOnly,
    getLastMeshTxAt: () => state.lastMeshTxAt,
    recordMeshTx: (when: number = Date.now()) => { state.lastMeshTxAt = when; },
    pollNeighborsAndStore: async (publicKey: string) => {
      state.polledFor.push(publicKey);
      return state.pollResult;
    },
    _state: state,
  };
  return m as MeshCoreManager & { _state: FakeState };
}

function makeRegistry(managers: MeshCoreManager[]): SourceManagerRegistry {
  return { getAllManagers: () => managers } as unknown as SourceManagerRegistry;
}

function makeDb(nodes: DbMeshCoreNode[]): {
  db: NeighboursSchedulerDatabase;
  getEnabled: ReturnType<typeof vi.fn>;
  mark: ReturnType<typeof vi.fn>;
} {
  const getEnabled = vi.fn().mockResolvedValue(nodes);
  const mark = vi.fn().mockResolvedValue(undefined);
  return {
    db: { meshcore: { getNeighborsEnabledNodes: getEnabled, markNeighborsRequested: mark } },
    getEnabled,
    mark,
  };
}

describe('MeshCoreNeighboursScheduler.tickOneManager', () => {
  it('skips a receive-only manager before the enabled-nodes DB read', async () => {
    const manager = makeFakeManager({ receiveOnly: true });
    const { db, getEnabled } = makeDb([node({ publicKey: 'pk-a' })]);
    const scheduler = new MeshCoreNeighboursScheduler({
      registry: makeRegistry([manager]),
      database: db,
      now: () => 10_000_000,
    });

    await (scheduler as any).tickOneManager(manager);

    expect(getEnabled).not.toHaveBeenCalled();
    expect(manager._state.polledFor).toEqual([]);
  });

  it('polls the most-overdue node and pre-stamps mark + recordMeshTx', async () => {
    const now = 10_000_000;
    const manager = makeFakeManager({ lastMeshTxAt: 0 });
    const { db, mark } = makeDb([node({ publicKey: 'pk-a', lastNeighborsRequestAt: null })]);
    const scheduler = new MeshCoreNeighboursScheduler({
      registry: makeRegistry([manager]),
      database: db,
      now: () => now,
    });

    await (scheduler as any).tickOneManager(manager);

    expect(mark).toHaveBeenCalledWith('src-a', 'pk-a', now);
    expect(manager._state.lastMeshTxAt).toBe(now); // recordMeshTx pre-stamp
    expect(manager._state.polledFor).toEqual(['pk-a']);
  });

  it('honours the shared 60s floor — a recent telemetry TX blocks a neighbours poll', async () => {
    const now = 10_000_000;
    // lastMeshTxAt was set 30s ago (e.g. by the telemetry scheduler on the
    // same source). The neighbours scheduler must back off, so the two never
    // transmit within 60s of each other.
    const manager = makeFakeManager({ lastMeshTxAt: now - 30_000 });
    const { db, getEnabled } = makeDb([node({ publicKey: 'pk-a' })]);
    const scheduler = new MeshCoreNeighboursScheduler({
      registry: makeRegistry([manager]),
      database: db,
      now: () => now,
    });

    await (scheduler as any).tickOneManager(manager);

    expect(getEnabled).not.toHaveBeenCalled();
    expect(manager._state.polledFor).toEqual([]);
  });

  it('allows a poll once 60s has elapsed since the last mesh TX', async () => {
    const now = 10_000_000;
    const manager = makeFakeManager({ lastMeshTxAt: now - 61_000 });
    const { db } = makeDb([node({ publicKey: 'pk-a' })]);
    const scheduler = new MeshCoreNeighboursScheduler({
      registry: makeRegistry([manager]),
      database: db,
      now: () => now,
    });

    await (scheduler as any).tickOneManager(manager);

    expect(manager._state.polledFor).toEqual(['pk-a']);
  });

  it('does nothing when no node is enabled', async () => {
    const manager = makeFakeManager({});
    const { db } = makeDb([]);
    const scheduler = new MeshCoreNeighboursScheduler({
      registry: makeRegistry([manager]),
      database: db,
      now: () => 10_000_000,
    });

    await (scheduler as any).tickOneManager(manager);
    expect(manager._state.polledFor).toEqual([]);
  });
});
