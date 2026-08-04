/**
 * MeshCoreRoomSyncScheduler tests.
 *
 * Covers the pure helpers (`isRoomSyncEligible`, `pickMostOverdueRoom`) and
 * the receive-only (#4547 WP3) skip in `tickOneManager`: a receive-only
 * source must never reach `manager.loginToRoom()` — the room-sync login
 * itself IS a transmission (CMD_LOGIN), so this scheduler's send primitive is
 * the login call, not a separate "send" step.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  MeshCoreRoomSyncScheduler,
  isRoomSyncEligible,
  pickMostOverdueRoom,
} from './meshcoreRoomSyncScheduler.js';
import type { MeshCoreManager } from '../meshcoreManager.js';
import type { SourceManagerRegistry } from '../sourceManagerRegistry.js';
import type { MeshCoreCredentialStore } from './meshcoreCredentialStore.js';
import databaseService from '../../services/database.js';

function makeNode(over: Partial<{
  publicKey: string;
  roomSyncEnabled: boolean;
  roomSyncIntervalMinutes: number;
  lastRoomSyncAt: number | null;
}>) {
  return {
    publicKey: 'pk-x',
    roomSyncEnabled: true,
    roomSyncIntervalMinutes: 60,
    lastRoomSyncAt: null,
    ...over,
  };
}

describe('isRoomSyncEligible', () => {
  it('rejects disabled nodes', () => {
    expect(isRoomSyncEligible(makeNode({ roomSyncEnabled: false }), 0)).toBe(false);
  });

  it('rejects an interval below the 60-minute floor', () => {
    expect(isRoomSyncEligible(makeNode({ roomSyncIntervalMinutes: 30 }), 1_000_000)).toBe(false);
  });

  it('accepts a node never synced before', () => {
    expect(isRoomSyncEligible(makeNode({ lastRoomSyncAt: null }), 100_000_000)).toBe(true);
  });

  it('rejects a node still inside its interval', () => {
    const now = 100_000_000;
    const node = makeNode({ roomSyncIntervalMinutes: 60, lastRoomSyncAt: now - 30 * 60_000 });
    expect(isRoomSyncEligible(node, now)).toBe(false);
  });

  it('accepts a node past its interval', () => {
    const now = 100_000_000;
    const node = makeNode({ roomSyncIntervalMinutes: 60, lastRoomSyncAt: now - 61 * 60_000 });
    expect(isRoomSyncEligible(node, now)).toBe(true);
  });
});

describe('pickMostOverdueRoom', () => {
  it('returns undefined when nothing is eligible', () => {
    expect(pickMostOverdueRoom([makeNode({ roomSyncEnabled: false })], 1_000_000)).toBeUndefined();
  });

  it('picks the most overdue eligible room, publicKey as tiebreaker', () => {
    const now = 100_000_000;
    const a = makeNode({ publicKey: 'aaa', lastRoomSyncAt: now - 70 * 60_000 });
    const b = makeNode({ publicKey: 'bbb', lastRoomSyncAt: now - 120 * 60_000 });
    expect(pickMostOverdueRoom([a, b], now)?.publicKey).toBe('bbb');
  });
});

// ============ tickOneManager — receive-only (#4547 WP3) ============

interface FakeManagerState {
  sourceId: string;
  connected: boolean;
  receiveOnly: boolean;
  lastMeshTxAt: number;
  loginCalledFor: string[];
  loginResult: boolean;
}

function makeFakeManager(init: Partial<FakeManagerState>): MeshCoreManager & { _state: FakeManagerState } {
  const state: FakeManagerState = {
    sourceId: 'src-a',
    connected: true,
    receiveOnly: false,
    lastMeshTxAt: 0,
    loginCalledFor: [],
    loginResult: true,
    ...init,
  };
  const m: any = {
    sourceId: state.sourceId,
    sourceType: 'meshcore',
    isConnected: () => state.connected,
    isReceiveOnly: () => state.receiveOnly,
    getLastMeshTxAt: () => state.lastMeshTxAt,
    recordMeshTx: (when: number = Date.now()) => { state.lastMeshTxAt = when; },
    loginToRoom: async (publicKey: string, _password: string) => {
      state.loginCalledFor.push(publicKey);
      return state.loginResult;
    },
    _state: state,
  };
  return m as MeshCoreManager & { _state: FakeManagerState };
}

function makeRegistry(managers: MeshCoreManager[]): SourceManagerRegistry {
  return { getAllManagers: () => managers } as unknown as SourceManagerRegistry;
}

function makeCredentialStore(): MeshCoreCredentialStore {
  return {
    loadRoom: vi.fn().mockResolvedValue({ kind: 'ok', password: 'secret' }),
  } as unknown as MeshCoreCredentialStore;
}

describe('MeshCoreRoomSyncScheduler.tickOneManager — receive-only (#4547)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns before loginToRoom (and before the room-node DB read) when receive-only', async () => {
    const manager = makeFakeManager({ receiveOnly: true });
    const getRoomNodes = vi.spyOn(databaseService.meshcore, 'getRoomSyncEnabledNodes').mockResolvedValue([
      { publicKey: 'pk-a', advType: 3, roomSyncIntervalMinutes: 60, lastRoomSyncAt: null } as any,
    ]);
    const credentialStore = makeCredentialStore();
    const scheduler = new MeshCoreRoomSyncScheduler({
      registry: makeRegistry([manager]),
      credentialStore,
      now: () => 10_000_000,
    });

    await (scheduler as any).tickOneManager(manager.sourceId, manager);

    expect(getRoomNodes).not.toHaveBeenCalled();
    expect((manager as any)._state.loginCalledFor).toEqual([]);
  });

  it('a connected, non-receive-only manager still reaches loginToRoom (non-vacuous negative)', async () => {
    const manager = makeFakeManager({ receiveOnly: false });
    vi.spyOn(databaseService.meshcore, 'getRoomSyncEnabledNodes').mockResolvedValue([
      { publicKey: 'pk-a', advType: 3, roomSyncIntervalMinutes: 60, lastRoomSyncAt: null } as any,
    ]);
    vi.spyOn(databaseService.meshcore, 'updateLastRoomSyncAt').mockResolvedValue(undefined);
    const credentialStore = makeCredentialStore();
    const scheduler = new MeshCoreRoomSyncScheduler({
      registry: makeRegistry([manager]),
      credentialStore,
      now: () => 10_000_000,
    });

    await (scheduler as any).tickOneManager(manager.sourceId, manager);

    expect((manager as any)._state.loginCalledFor).toEqual(['pk-a']);
  });

  it('tick() skips a receive-only manager entirely without touching the DB or credential store', async () => {
    const manager = makeFakeManager({ receiveOnly: true, connected: true });
    const getRoomNodes = vi.spyOn(databaseService.meshcore, 'getRoomSyncEnabledNodes').mockResolvedValue([]);
    const credentialStore = makeCredentialStore();
    const scheduler = new MeshCoreRoomSyncScheduler({
      registry: makeRegistry([manager]),
      credentialStore,
      now: () => 10_000_000,
    });

    await scheduler.tick();

    expect(getRoomNodes).not.toHaveBeenCalled();
    expect((credentialStore.loadRoom as any)).not.toHaveBeenCalled();
    expect((manager as any)._state.loginCalledFor).toEqual([]);
  });
});
