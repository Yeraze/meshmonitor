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
import type { MeshCoreManager, MeshCoreLoginOutcome } from '../meshcoreManager.js';
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
  /** What `loginToRoomWithOutcome` reports back. Defaults to following
   *  `loginResult` so the pre-existing receive-only tests read unchanged. */
  loginOutcome?: MeshCoreLoginOutcome;
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
    loginToRoomWithOutcome: async (publicKey: string, _password: string): Promise<MeshCoreLoginOutcome> => {
      state.loginCalledFor.push(publicKey);
      return state.loginOutcome ?? (state.loginResult ? 'ok' : 'no_reply');
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
    vi.spyOn(databaseService.meshcore, 'clearRoomSyncFailure').mockResolvedValue(undefined);
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

// ============ Failure handling — the "bad password floods the mesh" bug ============
//
// `lastRoomSyncAt` used to be written only after a SUCCESSFUL login, so a room
// whose saved password had gone stale stayed permanently overdue and was
// retried on every 60s tick for ever, at up to three login floods each.

describe('MeshCoreRoomSyncScheduler.tickOneManager — failure handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockFailurePath() {
    vi.spyOn(databaseService.meshcore, 'getRoomSyncEnabledNodes').mockResolvedValue([
      { publicKey: 'pk-a', advType: 3, roomSyncIntervalMinutes: 60, lastRoomSyncAt: null } as any,
    ]);
    return {
      updateLastRoomSyncAt: vi.spyOn(databaseService.meshcore, 'updateLastRoomSyncAt').mockResolvedValue(undefined),
      clearRoomSyncFailure: vi.spyOn(databaseService.meshcore, 'clearRoomSyncFailure').mockResolvedValue(undefined),
      recordRoomSyncFailure: vi.spyOn(databaseService.meshcore, 'recordRoomSyncFailure').mockResolvedValue(1),
      setRoomSyncConfig: vi.spyOn(databaseService.meshcore, 'setRoomSyncConfig').mockResolvedValue(undefined),
    };
  }

  function makeScheduler(manager: MeshCoreManager) {
    return new MeshCoreRoomSyncScheduler({
      registry: makeRegistry([manager]),
      credentialStore: makeCredentialStore(),
      now: () => 10_000_000,
    });
  }

  it('records a failed attempt so the room stops being retried every tick', async () => {
    const manager = makeFakeManager({ loginOutcome: 'no_reply' });
    const db = mockFailurePath();

    await (makeScheduler(manager) as any).tickOneManager(manager.sourceId, manager);

    // recordRoomSyncFailure stamps lastRoomSyncAt itself; the point is that the
    // attempt is recorded at all, so the next tick sees the room as recently
    // attempted rather than permanently overdue.
    expect(db.recordRoomSyncFailure).toHaveBeenCalledWith('src-a', 'pk-a', 'no_reply', { disable: false });
    expect(db.clearRoomSyncFailure).not.toHaveBeenCalled();
  });

  it('counts a failed attempt against the per-source TX floor', async () => {
    const manager = makeFakeManager({ loginOutcome: 'no_reply', lastMeshTxAt: 0 });
    mockFailurePath();

    await (makeScheduler(manager) as any).tickOneManager(manager.sourceId, manager);

    // A failed login still transmitted, so the 60s spacing must apply to it.
    expect((manager as any)._state.lastMeshTxAt).toBeGreaterThan(0);
  });

  it('disables auto-sync immediately when the room server refuses the password', async () => {
    const manager = makeFakeManager({ loginOutcome: 'rejected' });
    const db = mockFailurePath();

    await (makeScheduler(manager) as any).tickOneManager(manager.sourceId, manager);

    expect(db.recordRoomSyncFailure).toHaveBeenCalledWith('src-a', 'pk-a', 'rejected', { disable: true });
  });

  it('disables auto-sync after three consecutive unanswered logins', async () => {
    const manager = makeFakeManager({ loginOutcome: 'no_reply' });
    const db = mockFailurePath();
    db.recordRoomSyncFailure.mockResolvedValue(3);

    await (makeScheduler(manager) as any).tickOneManager(manager.sourceId, manager);

    expect(db.setRoomSyncConfig).toHaveBeenCalledWith('src-a', 'pk-a', { roomSyncEnabled: false });
  });

  it('leaves auto-sync alone while under the failure threshold', async () => {
    const manager = makeFakeManager({ loginOutcome: 'no_reply' });
    const db = mockFailurePath();
    db.recordRoomSyncFailure.mockResolvedValue(2);

    await (makeScheduler(manager) as any).tickOneManager(manager.sourceId, manager);

    expect(db.setRoomSyncConfig).not.toHaveBeenCalled();
  });

  it('clears the failure record after a successful sync', async () => {
    const manager = makeFakeManager({ loginOutcome: 'ok' });
    const db = mockFailurePath();

    await (makeScheduler(manager) as any).tickOneManager(manager.sourceId, manager);

    expect(db.updateLastRoomSyncAt).toHaveBeenCalledWith('src-a', 'pk-a');
    expect(db.clearRoomSyncFailure).toHaveBeenCalledWith('src-a', 'pk-a');
    expect(db.recordRoomSyncFailure).not.toHaveBeenCalled();
  });

  it('records a failure when the login throws, so a broken room cannot camp at the head of the queue', async () => {
    const manager = makeFakeManager({});
    (manager as any).loginToRoomWithOutcome = async () => {
      throw new Error('boom');
    };
    const db = mockFailurePath();

    await (makeScheduler(manager) as any).tickOneManager(manager.sourceId, manager);

    expect(db.recordRoomSyncFailure).toHaveBeenCalledWith('src-a', 'pk-a', 'no_reply');
  });
});
