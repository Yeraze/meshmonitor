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
  isStartupRejoinEligible,
  STARTUP_REJOIN_QUIET_MS,
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

  it('still clears the failure record when the success-path timestamp write fails', async () => {
    const manager = makeFakeManager({ loginOutcome: 'ok' });
    const db = mockFailurePath();
    db.updateLastRoomSyncAt.mockRejectedValue(new Error('db down'));

    await (makeScheduler(manager) as any).tickOneManager(manager.sourceId, manager);

    // A stale count must not survive against a room that demonstrably works.
    expect(db.clearRoomSyncFailure).toHaveBeenCalledWith('src-a', 'pk-a');
  });

  it('records a failure when the login throws, so a broken room cannot camp at the head of the queue', async () => {
    const manager = makeFakeManager({});
    (manager as any).loginToRoomWithOutcome = async () => {
      throw new Error('boom');
    };
    const db = mockFailurePath();

    await (makeScheduler(manager) as any).tickOneManager(manager.sourceId, manager);

    expect(db.recordRoomSyncFailure).toHaveBeenCalledWith('src-a', 'pk-a', 'no_reply', { disable: false });
    expect(db.setRoomSyncConfig).not.toHaveBeenCalled();
  });

  it('holds a repeatedly-throwing room to the same failure threshold', async () => {
    // Otherwise the counter climbs for ever and the login cost is paid on
    // every interval, indefinitely.
    const manager = makeFakeManager({});
    (manager as any).loginToRoomWithOutcome = async () => {
      throw new Error('boom');
    };
    const db = mockFailurePath();
    db.recordRoomSyncFailure.mockResolvedValue(3);

    await (makeScheduler(manager) as any).tickOneManager(manager.sourceId, manager);

    expect(db.setRoomSyncConfig).toHaveBeenCalledWith('src-a', 'pk-a', { roomSyncEnabled: false });
  });
});

// ============ Blank-password ACL re-join (#6408) ============
//
// A room server lets a key already in its ACL back in with a blank password.
// The scheduler may use that only for rooms this source has joined
// (`lastRoomLoginOkAt` set), and re-joins each such room once per connection,
// never within an hour of the last persisted login.

describe('isStartupRejoinEligible', () => {
  const now = 100_000_000;

  it('rejects a room never joined from this source', () => {
    expect(isStartupRejoinEligible(makeNode({ lastRoomSyncAt: null }), now)).toBe(false);
  });

  it('rejects a room with Room Sync off', () => {
    expect(isStartupRejoinEligible(
      { ...makeNode({ roomSyncEnabled: false }), lastRoomLoginOkAt: now - 2 * 60 * 60_000 },
      now,
    )).toBe(false);
  });

  it('rejects a joined room logged in to within the last hour (success)', () => {
    expect(isStartupRejoinEligible({ ...makeNode({}), lastRoomLoginOkAt: now - 30 * 60_000 }, now)).toBe(false);
  });

  it('rejects a joined room attempted within the last hour (failed attempt)', () => {
    const node = { ...makeNode({ lastRoomSyncAt: now - 59 * 60_000 }), lastRoomLoginOkAt: now - 5 * 60 * 60_000 };
    expect(isStartupRejoinEligible(node, now)).toBe(false);
  });

  it('accepts a joined room quiet for an hour or more', () => {
    expect(isStartupRejoinEligible({ ...makeNode({}), lastRoomLoginOkAt: now - STARTUP_REJOIN_QUIET_MS }, now)).toBe(true);
  });
});

describe('isRoomSyncEligible — interactive logins count (#6408)', () => {
  it('waits a full interval after a successful interactive login', () => {
    const now = 100_000_000;
    const node = { ...makeNode({ roomSyncIntervalMinutes: 60, lastRoomSyncAt: null }), lastRoomLoginOkAt: now - 10 * 60_000 };
    expect(isRoomSyncEligible(node, now)).toBe(false);
  });
});

describe('MeshCoreRoomSyncScheduler — blank-password re-join (#6408)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const NOW = 50_000_000;
  const HOUR = 60 * 60_000;

  function mockDb(rooms: Array<Record<string, unknown>>) {
    vi.spyOn(databaseService.meshcore, 'getRoomSyncEnabledNodes').mockResolvedValue(
      rooms.map(r => ({ advType: 3, roomSyncIntervalMinutes: 60, lastRoomSyncAt: null, lastRoomLoginOkAt: null, ...r })) as any,
    );
    return {
      updateLastRoomSyncAt: vi.spyOn(databaseService.meshcore, 'updateLastRoomSyncAt').mockResolvedValue(undefined),
      clearRoomSyncFailure: vi.spyOn(databaseService.meshcore, 'clearRoomSyncFailure').mockResolvedValue(undefined),
      recordRoomSyncFailure: vi.spyOn(databaseService.meshcore, 'recordRoomSyncFailure').mockResolvedValue(1),
      setRoomSyncConfig: vi.spyOn(databaseService.meshcore, 'setRoomSyncConfig').mockResolvedValue(undefined),
    };
  }

  function noCredStore(): MeshCoreCredentialStore {
    return {
      loadRoom: vi.fn().mockResolvedValue({ kind: 'none' }),
    } as unknown as MeshCoreCredentialStore;
  }

  function trackPasswords(manager: MeshCoreManager, outcome: MeshCoreLoginOutcome = 'ok') {
    const calls: Array<{ publicKey: string; password: string }> = [];
    (manager as any).loginToRoomWithOutcome = async (publicKey: string, password: string) => {
      calls.push({ publicKey, password });
      return outcome;
    };
    return calls;
  }

  function makeScheduler(manager: MeshCoreManager, credentialStore = noCredStore(), now = () => NOW) {
    return new MeshCoreRoomSyncScheduler({ registry: makeRegistry([manager]), credentialStore, now });
  }

  it('falls back to a blank-password login for a joined room with no saved password', async () => {
    const manager = makeFakeManager({});
    const calls = trackPasswords(manager);
    const db = mockDb([{ publicKey: 'pk-a', lastRoomSyncAt: NOW - 2 * HOUR, lastRoomLoginOkAt: NOW - 2 * HOUR }]);

    await (makeScheduler(manager) as any).tickOneManager('src-a', manager);

    expect(calls).toEqual([{ publicKey: 'pk-a', password: '' }]);
    expect(db.updateLastRoomSyncAt).toHaveBeenCalledWith('src-a', 'pk-a');
  });

  it('never sends a login for a room with no saved password that was never joined', async () => {
    const manager = makeFakeManager({});
    const calls = trackPasswords(manager);
    mockDb([{ publicKey: 'pk-a', lastRoomSyncAt: null, lastRoomLoginOkAt: null }]);

    await (makeScheduler(manager) as any).tickOneManager('src-a', manager);

    expect(calls).toEqual([]);
  });

  it('a never-joined room without a password does not block a joined room behind it', async () => {
    const manager = makeFakeManager({});
    const calls = trackPasswords(manager);
    mockDb([
      // Most overdue, but unusable.
      { publicKey: 'pk-a', lastRoomSyncAt: null, lastRoomLoginOkAt: null },
      { publicKey: 'pk-b', lastRoomSyncAt: NOW - 2 * HOUR, lastRoomLoginOkAt: NOW - 2 * HOUR },
    ]);

    await (makeScheduler(manager) as any).tickOneManager('src-a', manager);

    expect(calls).toEqual([{ publicKey: 'pk-b', password: '' }]);
  });

  it('still prefers a saved password over the blank fallback', async () => {
    const manager = makeFakeManager({});
    const calls = trackPasswords(manager);
    mockDb([{ publicKey: 'pk-a', lastRoomSyncAt: NOW - 2 * HOUR, lastRoomLoginOkAt: NOW - 2 * HOUR }]);

    await (makeScheduler(manager, makeCredentialStore()) as any).tickOneManager('src-a', manager);

    expect(calls).toEqual([{ publicKey: 'pk-a', password: 'secret' }]);
  });

  it('re-joins on connect before the interval is up, once the last login is an hour old', async () => {
    // 4h interval, last login 90 min ago: not due on the interval, but the
    // source just connected and the room is joined, so it gets one re-join.
    const manager = makeFakeManager({});
    const calls = trackPasswords(manager);
    mockDb([{
      publicKey: 'pk-a', roomSyncIntervalMinutes: 240,
      lastRoomSyncAt: NOW - 90 * 60_000, lastRoomLoginOkAt: NOW - 90 * 60_000,
    }]);

    await (makeScheduler(manager) as any).tickOneManager('src-a', manager);

    expect(calls).toEqual([{ publicKey: 'pk-a', password: '' }]);
  });

  it('skips the re-join when the last persisted login was within 60 minutes (restart is not a trigger)', async () => {
    const manager = makeFakeManager({});
    const calls = trackPasswords(manager);
    mockDb([{
      publicKey: 'pk-a', roomSyncIntervalMinutes: 240,
      lastRoomSyncAt: NOW - 20 * 60_000, lastRoomLoginOkAt: NOW - 20 * 60_000,
    }]);

    await (makeScheduler(manager) as any).tickOneManager('src-a', manager);

    expect(calls).toEqual([]);
  });

  it('a fresh scheduler (process restart) does not re-join a room a FAILED attempt touched within the hour', async () => {
    // The failed attempt stamped lastRoomSyncAt in the DB; the new process
    // has no memory of it, but must still hold off.
    const manager = makeFakeManager({});
    const calls = trackPasswords(manager);
    mockDb([{
      publicKey: 'pk-a', roomSyncIntervalMinutes: 240,
      lastRoomSyncAt: NOW - 10 * 60_000, lastRoomLoginOkAt: NOW - 5 * HOUR,
    }]);

    await (makeScheduler(manager) as any).tickOneManager('src-a', manager);

    expect(calls).toEqual([]);
  });

  it('a room skipped as recent at connect is not re-joined later in the same connection', async () => {
    let now = NOW;
    const manager = makeFakeManager({});
    const calls = trackPasswords(manager);
    mockDb([{
      publicKey: 'pk-a', roomSyncIntervalMinutes: 240,
      lastRoomSyncAt: NOW - 20 * 60_000, lastRoomLoginOkAt: NOW - 20 * 60_000,
    }]);
    const scheduler = makeScheduler(manager, noCredStore(), () => now);

    await (scheduler as any).tickOneManager('src-a', manager);
    now = NOW + HOUR; // past the quiet window, still inside the 4h interval
    await (scheduler as any).tickOneManager('src-a', manager);

    expect(calls).toEqual([]);
  });

  it('tries each room once per connection, one login per source per minute', async () => {
    let now = NOW;
    const manager = makeFakeManager({});
    const calls = trackPasswords(manager);
    mockDb([
      { publicKey: 'pk-a', roomSyncIntervalMinutes: 240, lastRoomSyncAt: NOW - 2 * HOUR, lastRoomLoginOkAt: NOW - 2 * HOUR },
      { publicKey: 'pk-b', roomSyncIntervalMinutes: 240, lastRoomSyncAt: NOW - 3 * HOUR, lastRoomLoginOkAt: NOW - 3 * HOUR },
    ]);
    (manager as any).recordMeshTx = () => { (manager as any)._state.lastMeshTxAt = now; };
    const scheduler = makeScheduler(manager, noCredStore(), () => now);

    await (scheduler as any).tickOneManager('src-a', manager);
    expect(calls.map(c => c.publicKey)).toEqual(['pk-b']);

    // Inside the 60s floor: nothing.
    now += 30_000;
    await (scheduler as any).tickOneManager('src-a', manager);
    expect(calls.map(c => c.publicKey)).toEqual(['pk-b']);

    // Past the floor: the second room. (The DB mock still reports the old
    // timestamps; the in-memory "settled" set alone stops a second try.)
    now += 31_000;
    await (scheduler as any).tickOneManager('src-a', manager);
    expect(calls.map(c => c.publicKey)).toEqual(['pk-b', 'pk-a']);

    // Both settled: no third login this connection on the startup rule.
    now += 61_000;
    await (scheduler as any).tickOneManager('src-a', manager);
    expect(calls.map(c => c.publicKey)).toEqual(['pk-b', 'pk-a']);
  });

  it('a reconnect earns one more re-join', async () => {
    let now = NOW;
    const manager = makeFakeManager({});
    const calls = trackPasswords(manager);
    mockDb([{ publicKey: 'pk-a', roomSyncIntervalMinutes: 240, lastRoomSyncAt: NOW - 2 * HOUR, lastRoomLoginOkAt: NOW - 2 * HOUR }]);
    (manager as any).recordMeshTx = () => { (manager as any)._state.lastMeshTxAt = now; };
    const scheduler = makeScheduler(manager, noCredStore(), () => now);

    await scheduler.tick();
    expect(calls).toHaveLength(1);

    (manager as any)._state.connected = false;
    now += 2 * 60_000;
    await scheduler.tick();
    (manager as any)._state.connected = true;
    now += 2 * 60_000;
    await scheduler.tick();
    expect(calls).toHaveLength(2);
  });

  it('disables auto-sync at once when the room refuses the blank re-join', async () => {
    const manager = makeFakeManager({});
    trackPasswords(manager, 'rejected');
    const db = mockDb([{ publicKey: 'pk-a', lastRoomSyncAt: NOW - 2 * HOUR, lastRoomLoginOkAt: NOW - 2 * HOUR }]);

    await (makeScheduler(manager) as any).tickOneManager('src-a', manager);

    expect(db.recordRoomSyncFailure).toHaveBeenCalledWith('src-a', 'pk-a', 'rejected', { disable: true });
  });

  it('counts an unanswered blank re-join toward the auto-disable threshold', async () => {
    const manager = makeFakeManager({});
    trackPasswords(manager, 'no_reply');
    const db = mockDb([{ publicKey: 'pk-a', lastRoomSyncAt: NOW - 2 * HOUR, lastRoomLoginOkAt: NOW - 2 * HOUR }]);
    db.recordRoomSyncFailure.mockResolvedValue(3);

    await (makeScheduler(manager) as any).tickOneManager('src-a', manager);

    expect(db.recordRoomSyncFailure).toHaveBeenCalledWith('src-a', 'pk-a', 'no_reply', { disable: false });
    expect(db.setRoomSyncConfig).toHaveBeenCalledWith('src-a', 'pk-a', { roomSyncEnabled: false });
  });

  it('a receive-only source never sends the re-join', async () => {
    const manager = makeFakeManager({ receiveOnly: true });
    const calls = trackPasswords(manager);
    mockDb([{ publicKey: 'pk-a', lastRoomSyncAt: NOW - 2 * HOUR, lastRoomLoginOkAt: NOW - 2 * HOUR }]);

    await (makeScheduler(manager) as any).tickOneManager('src-a', manager);

    expect(calls).toEqual([]);
  });
});
