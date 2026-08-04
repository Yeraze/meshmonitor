/**
 * MeshCore strict receive-only mode (#4547 epic, Phase 1).
 *
 * WP1 slice (unchanged): manager state (isReceiveOnly/canTransmit),
 * refreshReceiveOnly() DB read + fail-safe caching, setReceiveOnly()'s
 * state-change-only logging + native-backend push, the sendBridgeCommand
 * command-name-aware gate, and that connect() refreshes the flag on every
 * (re)connect.
 *
 * WP2 slice (this addition): the 24 explicit `requireTransmit()` guards from
 * §2.3.4, the `sendLocalCliCommand` verb gate (§2.3.5), the `requestNeighbors`
 * branch split (§2.3.4b — remote branch gated via its downstream guards,
 * local branch deliberately ungated), the insertion-point / orphaned-state
 * checks for the six non-trivial methods, and proof that `sendRepeaterCommand`
 * is NOT gated wholesale.
 *
 * Scheduler silent-skips and native-backend chokepoint B (WP3) are covered by
 * their own test files, not here.
 *
 * See docs/internal/dev-notes/MESHCORE_RECEIVE_ONLY_PHASE1_SPEC.md §2.3.4, §2.3.4b, §2.3.5, §3.2.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MeshCoreManager, ConnectionType, MeshCoreDeviceType, type MeshCoreConfig, type MeshCoreContact } from './meshcoreManager.js';
import { logger } from '../utils/logger.js';
import databaseService from '../services/database.js';
import { isTxDisabledError } from './errors/txDisabledError.js';

const TEST_CONFIG: MeshCoreConfig = {
  connectionType: ConnectionType.SERIAL,
  firmwareType: 'companion',
  serialPort: '/dev/ttyTEST',
};

/**
 * Narrow, `any`-free accessor for the private `sendBridgeCommand` method —
 * exercised directly so the gate is tested independently of any individual
 * public method's own guard (which is WP2's responsibility, not WP1's).
 */
type SendBridgeCommandFn = (
  cmd: string,
  params: Record<string, unknown>,
  timeout?: number,
) => Promise<unknown>;

function sendBridgeCommandOf(manager: MeshCoreManager): SendBridgeCommandFn {
  return (manager as unknown as { sendBridgeCommand: SendBridgeCommandFn }).sendBridgeCommand.bind(
    manager,
  );
}

function freshManager(sourceId = 'test-source'): MeshCoreManager {
  return new MeshCoreManager(sourceId);
}

/** Minimal shape of the native backend needed by the WP2 guard tests. */
interface FakeNativeBackend {
  sendCommand: (cmd: string, params: Record<string, unknown>, timeout?: number) => Promise<{
    id?: string;
    success: boolean;
    data?: Record<string, unknown>;
    error?: string;
  }>;
  setReceiveOnly: (enabled: boolean) => void;
}

/** Minimal shape of the serial port needed by the sendRepeaterCommand tests. */
interface FakeSerialPort {
  isOpen: boolean;
  write: (data: string) => void;
}

/**
 * Narrow, `any`-free accessor for the private fields the WP2 guard-placement
 * and orphaned-state tests need to poke directly (device-type/connected
 * preconditions, the native backend, the serial port, and the lock/pending-
 * reply maps). Mirrors the `sendBridgeCommandOf` accessor above.
 */
interface ManagerInternals {
  connected: boolean;
  deviceType: MeshCoreDeviceType;
  contacts: Map<string, MeshCoreContact>;
  nativeBackend: FakeNativeBackend | undefined;
  serialPort: FakeSerialPort | null;
  cliCommandLocks: Map<string, Promise<unknown>>;
  pendingCliReplies: Map<string, unknown>;
  guestLoggedInNodes: Set<string>;
}

function internals(manager: MeshCoreManager): ManagerInternals {
  return manager as unknown as ManagerInternals;
}

type PerformScopedSendFn = (
  text: string,
  toPublicKey?: string,
  channelIdx?: number,
  scopeOverride?: string | null,
  isAutoRetry?: boolean,
  autoRetryOnMiss?: boolean,
) => Promise<{ ok: boolean }>;

function performScopedSendOf(manager: MeshCoreManager): PerformScopedSendFn {
  return (manager as unknown as { performScopedSend: PerformScopedSendFn }).performScopedSend.bind(manager);
}

type RunCliCommandLockedFn = (
  fullKey: string,
  prefixKey: string,
  command: string,
  timeoutMs: number,
) => Promise<{ reply: string; elapsedMs: number }>;

function runCliCommandLockedOf(manager: MeshCoreManager): RunCliCommandLockedFn {
  return (manager as unknown as { runCliCommandLocked: RunCliCommandLockedFn }).runCliCommandLocked.bind(manager);
}

/** Valid-format 64-char hex public key used throughout the WP2 guard tests. */
const HEX_PUBKEY = 'a'.repeat(64);

function makeContact(publicKey: string, overrides: Partial<MeshCoreContact> = {}): MeshCoreContact {
  return { publicKey, ...overrides };
}

function companionSetup(m: MeshCoreManager): void {
  internals(m).deviceType = MeshCoreDeviceType.COMPANION;
}

function companionConnectedSetup(m: MeshCoreManager): void {
  internals(m).deviceType = MeshCoreDeviceType.COMPANION;
  internals(m).connected = true;
}

describe('MeshCoreManager receive-only state (#4547 WP1)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults to transmit-allowed on a fresh manager', () => {
    const m = freshManager();
    expect(m.isReceiveOnly()).toBe(false);
    expect(m.canTransmit()).toBe(true);
  });

  it('refreshReceiveOnly() reads the per-source setting and flips the flag', async () => {
    const m = freshManager('src-a');
    const getSpy = vi.spyOn(databaseService.settings, 'getSettingForSource').mockResolvedValue('true');

    const result = await m.refreshReceiveOnly();

    expect(result).toBe(true);
    expect(m.isReceiveOnly()).toBe(true);
    expect(m.canTransmit()).toBe(false);
    expect(getSpy).toHaveBeenCalledWith('src-a', 'meshcoreReceiveOnly');
  });

  it('refreshReceiveOnly() sets false when the stored value is anything other than the string "true"', async () => {
    const m = freshManager();
    vi.spyOn(databaseService.settings, 'getSettingForSource').mockResolvedValue(null);

    const result = await m.refreshReceiveOnly();

    expect(result).toBe(false);
    expect(m.isReceiveOnly()).toBe(false);
  });

  it('a DB read that rejects leaves the previously-cached value intact (fail-safe)', async () => {
    const m = freshManager();
    vi.spyOn(databaseService.settings, 'getSettingForSource').mockResolvedValueOnce('true');
    await m.refreshReceiveOnly();
    expect(m.isReceiveOnly()).toBe(true);

    vi.spyOn(databaseService.settings, 'getSettingForSource').mockRejectedValueOnce(new Error('db unavailable'));
    const result = await m.refreshReceiveOnly();

    expect(result).toBe(true);
    expect(m.isReceiveOnly()).toBe(true);
  });

  it('setReceiveOnly logs exactly one info line on a state change, and none on a repeat of the same value', () => {
    const m = freshManager();
    // Spy AFTER construction — the constructor itself logs an unrelated
    // "Manager initialized" info line that must not be counted here.
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);

    m.setReceiveOnly(true);
    expect(infoSpy).toHaveBeenCalledTimes(1);

    m.setReceiveOnly(true); // repeat — no new log
    expect(infoSpy).toHaveBeenCalledTimes(1);

    m.setReceiveOnly(false); // state change back — one more log
    expect(infoSpy).toHaveBeenCalledTimes(2);
  });

  it('setReceiveOnly propagates the value to nativeBackend.setReceiveOnly', () => {
    const m = freshManager();
    const backendSpy = vi.fn();
    (m as any).nativeBackend = { setReceiveOnly: backendSpy };

    m.setReceiveOnly(true);

    expect(backendSpy).toHaveBeenCalledWith(true);
  });

  it('setReceiveOnly is a no-op toward the backend when none is attached', () => {
    const m = freshManager();
    expect(() => m.setReceiveOnly(true)).not.toThrow();
  });
});

describe('MeshCoreManager.sendBridgeCommand receive-only gate (#4547 WP1)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws a TxDisabledError for an RF command while receive-only, without reaching the backend', async () => {
    const m = freshManager();
    m.setReceiveOnly(true);
    const backendSend = vi.fn().mockResolvedValue({ ok: true });
    (m as any).nativeBackend = { sendCommand: backendSend, setReceiveOnly: vi.fn() };
    const send = sendBridgeCommandOf(m);

    await expect(send('send_message', {})).rejects.toMatchObject({
      isTxDisabledError: true,
      code: 'TX_DISABLED',
    });
    expect(backendSend).not.toHaveBeenCalled();
  });

  it('rejects with an error satisfying isTxDisabledError()', async () => {
    const m = freshManager();
    m.setReceiveOnly(true);
    (m as any).nativeBackend = { sendCommand: vi.fn(), setReceiveOnly: vi.fn() };
    const send = sendBridgeCommandOf(m);

    let caught: unknown;
    try {
      await send('send_advert', {});
    } catch (err) {
      caught = err;
    }
    expect(isTxDisabledError(caught)).toBe(true);
  });

  it('does not gate RF commands when not receive-only', async () => {
    const m = freshManager();
    const backendSend = vi.fn().mockResolvedValue({ ok: true });
    (m as any).nativeBackend = { sendCommand: backendSend, setReceiveOnly: vi.fn() };
    const send = sendBridgeCommandOf(m);

    await send('send_message', { text: 'hi' });

    expect(backendSend).toHaveBeenCalledWith('send_message', { text: 'hi' }, expect.any(Number));
  });

  it.each(['get_channels', 'set_name', 'set_radio', 'get_stats', 'device_query', 'set_device_time'])(
    'still reaches the backend for serial-only command %s while receive-only',
    async (cmd) => {
      const m = freshManager();
      m.setReceiveOnly(true);
      const backendSend = vi.fn().mockResolvedValue({ ok: true });
      (m as any).nativeBackend = { sendCommand: backendSend, setReceiveOnly: vi.fn() };
      const send = sendBridgeCommandOf(m);

      await send(cmd, {});

      expect(backendSend).toHaveBeenCalledWith(cmd, {}, expect.any(Number));
    },
  );

  it('fails closed: an unclassified command name is blocked while receive-only', async () => {
    const m = freshManager();
    m.setReceiveOnly(true);
    const backendSend = vi.fn().mockResolvedValue({ ok: true });
    (m as any).nativeBackend = { sendCommand: backendSend, setReceiveOnly: vi.fn() };
    const send = sendBridgeCommandOf(m);

    await expect(send('some_future_command_nobody_classified', {})).rejects.toMatchObject({
      isTxDisabledError: true,
    });
    expect(backendSend).not.toHaveBeenCalled();
  });

  it('still throws "Native backend not ready" (not TX_DISABLED) when no backend is attached, receive-only or not', async () => {
    const m = freshManager();
    const send = sendBridgeCommandOf(m);
    await expect(send('get_channels', {})).rejects.toThrow('Native backend not ready');
  });
});

describe('MeshCoreManager.connect() refreshes receive-only on every (re)connect (#4547 WP1)', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(databaseService.meshcore, 'getRecentMessages').mockResolvedValue([]);
    vi.spyOn(databaseService.settings, 'getSettingForSource').mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function stubHeavyConnectSideEffects(m: MeshCoreManager): ReturnType<typeof vi.fn> {
    const startNativeBackendSpy = vi.fn().mockResolvedValue(undefined);
    (m as any).startNativeBackend = startNativeBackendSpy;
    (m as any).refreshLocalNode = vi.fn().mockResolvedValue(undefined);
    (m as any).seedContactsFromDb = vi.fn().mockResolvedValue(undefined);
    (m as any).refreshContacts = vi.fn().mockResolvedValue(undefined);
    (m as any).refreshKnownScopes = vi.fn().mockResolvedValue(undefined);
    (m as any).startVirtualNodeServer = vi.fn().mockResolvedValue(undefined);
    (m as any).startAutoPathfinding = vi.fn().mockResolvedValue(undefined);
    (m as any).startAutoAnnounce = vi.fn().mockResolvedValue(undefined);
    (m as any).startTimerTriggers = vi.fn().mockResolvedValue(undefined);
    (m as any).distanceDeleteScheduler = { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn() };
    return startNativeBackendSpy;
  }

  it('calls refreshReceiveOnly() before the native backend starts', async () => {
    const m = freshManager();
    const refreshSpy = vi.spyOn(m, 'refreshReceiveOnly');
    const startNativeBackendSpy = stubHeavyConnectSideEffects(m);

    const ok = await m.connect(TEST_CONFIG);

    expect(ok).toBe(true);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(startNativeBackendSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy.mock.invocationCallOrder[0]).toBeLessThan(
      startNativeBackendSpy.mock.invocationCallOrder[0],
    );
  });

  it('refreshes again on a second connect() (reconnect survival)', async () => {
    const m = freshManager();
    const refreshSpy = vi.spyOn(m, 'refreshReceiveOnly');
    stubHeavyConnectSideEffects(m);
    // connect() calls disconnect() first when already connected; stub it so
    // the second call doesn't try to tear down the (stubbed) native backend.
    (m as any).disconnect = vi.fn().mockResolvedValue(undefined);

    await m.connect(TEST_CONFIG);
    expect(refreshSpy).toHaveBeenCalledTimes(1);

    await m.connect(TEST_CONFIG);
    expect(refreshSpy).toHaveBeenCalledTimes(2);
  });

  it('a receive-only flag set by refreshReceiveOnly on connect is reflected by canTransmit()', async () => {
    vi.spyOn(databaseService.settings, 'getSettingForSource').mockResolvedValue('true');
    const m = freshManager();
    stubHeavyConnectSideEffects(m);

    await m.connect(TEST_CONFIG);

    expect(m.isReceiveOnly()).toBe(true);
    expect(m.canTransmit()).toBe(false);
  });
});

/**
 * WP2 — the 24 explicit `requireTransmit()` guards from §2.3.4. Each case
 * supplies just enough state to pass the method's OWN pre-existing
 * validation (device-type / connected / format checks) so the guard is
 * actually reached, then asserts the call rejects with a `TxDisabledError`.
 * `runCliCommandLocked` is deliberately excluded from this table — it is not
 * declared `async`, so the guard throws SYNCHRONOUSLY before a Promise is
 * even returned; it gets its own test below alongside the other
 * insertion-point / orphaned-state checks.
 */
interface GuardCase {
  name: string;
  setup?: (m: MeshCoreManager) => void;
  invoke: (m: MeshCoreManager) => Promise<unknown>;
}

const GUARD_CASES: GuardCase[] = [
  { name: 'sendMessage', invoke: (m) => m.sendMessage('hi') },
  {
    name: 'sendMessageWithResult',
    setup: (m) => { internals(m).connected = true; },
    invoke: (m) => m.sendMessageWithResult('hi'),
  },
  { name: 'performScopedSend', invoke: (m) => performScopedSendOf(m)('hi') },
  {
    name: 'sendAdvert',
    setup: (m) => { internals(m).connected = true; },
    invoke: (m) => m.sendAdvert(),
  },
  { name: 'resetContactPath', setup: companionConnectedSetup, invoke: (m) => m.resetContactPath(HEX_PUBKEY) },
  { name: 'discoverContactPath', setup: companionConnectedSetup, invoke: (m) => m.discoverContactPath(HEX_PUBKEY) },
  { name: 'discoverNodes', setup: companionConnectedSetup, invoke: (m) => m.discoverNodes(0x0c) },
  { name: 'fetchOwnerName', setup: companionSetup, invoke: (m) => m.fetchOwnerName(HEX_PUBKEY) },
  { name: 'discoverRegions', setup: companionSetup, invoke: (m) => m.discoverRegions() },
  { name: 'traceContactPath', setup: companionConnectedSetup, invoke: (m) => m.traceContactPath(HEX_PUBKEY) },
  {
    name: 'tracePathRaw',
    setup: companionConnectedSetup,
    invoke: (m) => m.tracePathRaw(new Uint8Array([1])),
  },
  {
    name: 'pingContactZeroHop',
    setup: (m) => {
      companionConnectedSetup(m);
      internals(m).contacts.set(HEX_PUBKEY, makeContact(HEX_PUBKEY));
    },
    invoke: (m) => m.pingContactZeroHop(HEX_PUBKEY),
  },
  { name: 'shareContact', setup: companionConnectedSetup, invoke: (m) => m.shareContact(HEX_PUBKEY) },
  { name: 'getNeighbours', setup: companionConnectedSetup, invoke: (m) => m.getNeighbours(HEX_PUBKEY) },
  { name: 'loginToNode', setup: companionSetup, invoke: (m) => m.loginToNode(HEX_PUBKEY, 'pw') },
  { name: 'requestNodeStatus', setup: companionSetup, invoke: (m) => m.requestNodeStatus(HEX_PUBKEY) },
  { name: 'ensureGuestLogin', invoke: (m) => m.ensureGuestLogin(HEX_PUBKEY) },
  { name: 'ensureSavedLogin', setup: companionConnectedSetup, invoke: (m) => m.ensureSavedLogin(HEX_PUBKEY) },
  { name: 'loginToRoom', invoke: (m) => m.loginToRoom(HEX_PUBKEY, 'pw') },
  {
    name: 'sendRoomPost',
    setup: (m) => { internals(m).connected = true; },
    invoke: (m) => m.sendRoomPost('hi', HEX_PUBKEY),
  },
  { name: 'sendCliCommand', setup: companionConnectedSetup, invoke: (m) => m.sendCliCommand(HEX_PUBKEY, 'neighbors') },
  { name: 'requestRemoteTelemetry', setup: companionConnectedSetup, invoke: (m) => m.requestRemoteTelemetry(HEX_PUBKEY) },
  {
    name: 'requestRemoteTelemetryRaw',
    setup: companionConnectedSetup,
    invoke: (m) => m.requestRemoteTelemetryRaw(HEX_PUBKEY),
  },
];

describe.each(GUARD_CASES)('MeshCoreManager.$name requireTransmit() guard (#4547 WP2 §2.3.4)', ({ setup, invoke }) => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects with a TxDisabledError while receive-only', async () => {
    const m = freshManager();
    setup?.(m);
    m.setReceiveOnly(true);

    await expect(invoke(m)).rejects.toMatchObject({ isTxDisabledError: true, code: 'TX_DISABLED' });
  });
});

describe('MeshCoreManager.requestNeighbors branch split stays ungated (#4547 WP2 §2.3.4b)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('remote branch (publicKey supplied) rejects via ensureSavedLogin, never reaching sendCliCommand', async () => {
    const m = freshManager();
    companionConnectedSetup(m);
    m.setReceiveOnly(true);
    const sendCliSpy = vi.spyOn(m, 'sendCliCommand');

    await expect(m.requestNeighbors(HEX_PUBKEY)).rejects.toMatchObject({ isTxDisabledError: true });
    expect(sendCliSpy).not.toHaveBeenCalled();
  });

  it('local branch (no publicKey) resolves normally, reaching sendLocalCliCommand("neighbors")', async () => {
    const m = freshManager();
    m.setReceiveOnly(true);
    const localCliSpy = vi.spyOn(m, 'sendLocalCliCommand').mockResolvedValue({ reply: '', elapsedMs: 1 });

    const result = await m.requestNeighbors();

    expect(localCliSpy).toHaveBeenCalledWith('neighbors');
    expect(result).toEqual({ neighbors: [] });
  });

  it('local branch also resolves when publicKey is explicitly undefined', async () => {
    const m = freshManager();
    m.setReceiveOnly(true);
    const localCliSpy = vi.spyOn(m, 'sendLocalCliCommand').mockResolvedValue({ reply: '', elapsedMs: 1 });

    await expect(m.requestNeighbors(undefined)).resolves.toEqual({ neighbors: [] });
    expect(localCliSpy).toHaveBeenCalledWith('neighbors');
  });
});

describe('MeshCoreManager.sendLocalCliCommand verb gate (#4547 WP2 §2.3.5)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['advert', 'ADVERT', ' advert '])(
    'throws TxDisabledError for the transmitting verb %j on a Companion',
    async (cmd) => {
      const m = freshManager();
      companionConnectedSetup(m);
      m.setReceiveOnly(true);

      await expect(m.sendLocalCliCommand(cmd)).rejects.toMatchObject({
        isTxDisabledError: true,
        code: 'TX_DISABLED',
      });
    },
  );

  it('throws TxDisabledError for "advert" on a Repeater too (single gate covers both dispatch branches)', async () => {
    const m = freshManager();
    internals(m).connected = true;
    internals(m).deviceType = MeshCoreDeviceType.REPEATER;
    m.setReceiveOnly(true);

    await expect(m.sendLocalCliCommand('advert')).rejects.toMatchObject({ isTxDisabledError: true });
  });

  it('does not block "ver" — reaches the (serial-only) device_query bridge command', async () => {
    const m = freshManager();
    companionConnectedSetup(m);
    const backendSend = vi.fn().mockResolvedValue({ success: true, data: { ver: '1.16' } });
    internals(m).nativeBackend = { sendCommand: backendSend, setReceiveOnly: vi.fn() };
    m.setReceiveOnly(true);

    const result = await m.sendLocalCliCommand('ver');

    expect(result.reply).toContain('1.16');
    expect(backendSend).toHaveBeenCalledWith('device_query', {}, expect.any(Number));
  });

  it('does not block a non-transmitting Repeater verb ("get name") — reaches the serial CLI', async () => {
    const m = freshManager();
    internals(m).connected = true;
    internals(m).deviceType = MeshCoreDeviceType.REPEATER;
    const writes: string[] = [];
    internals(m).serialPort = {
      isOpen: true,
      write: (data: string) => {
        writes.push(data);
        // sendRepeaterCommand registers its 'serial_data' listener and calls
        // write() synchronously (before any await), so emitting here — still
        // inside the write() call — reaches an already-registered listener.
        // First line echoes the command (skipped by the handler), second
        // line is the terminator that resolves the pending promise.
        m.emit('serial_data', data.replace(/\r$/, ''));
        m.emit('serial_data', 'OK - name: test-repeater');
      },
    };
    m.setReceiveOnly(true);

    const result = await m.sendLocalCliCommand('get name');

    expect(result.reply).toContain('OK - name: test-repeater');
    expect(writes).toEqual(['get name\r']);
  });
});

describe('MeshCoreManager guard insertion-point / orphaned-state checks (#4547 WP2)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sendCliCommand: throwing leaves no entry behind in cliCommandLocks', async () => {
    const m = freshManager();
    companionConnectedSetup(m);
    m.setReceiveOnly(true);

    await expect(m.sendCliCommand(HEX_PUBKEY, 'neighbors')).rejects.toMatchObject({ isTxDisabledError: true });
    expect(internals(m).cliCommandLocks.size).toBe(0);
  });

  it('runCliCommandLocked: throws synchronously before installing a pendingCliReplies entry or a timer', () => {
    const m = freshManager();
    m.setReceiveOnly(true);
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    const fn = runCliCommandLockedOf(m);

    let caught: unknown;
    try {
      fn(HEX_PUBKEY, HEX_PUBKEY.substring(0, 12), 'neighbors', 5000);
    } catch (err) {
      caught = err;
    }

    expect(isTxDisabledError(caught)).toBe(true);
    expect(internals(m).pendingCliReplies.size).toBe(0);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it('ensureGuestLogin: an already-cached session returns true instead of throwing while receive-only', async () => {
    const m = freshManager();
    internals(m).guestLoggedInNodes.add(HEX_PUBKEY);
    m.setReceiveOnly(true);

    await expect(m.ensureGuestLogin(HEX_PUBKEY)).resolves.toBe(true);
  });

  it('getNeighbours: throws before ever calling ensureSavedLogin', async () => {
    const m = freshManager();
    companionConnectedSetup(m);
    m.setReceiveOnly(true);
    const ensureSpy = vi.spyOn(m, 'ensureSavedLogin');

    await expect(m.getNeighbours(HEX_PUBKEY)).rejects.toMatchObject({ isTxDisabledError: true });
    expect(ensureSpy).not.toHaveBeenCalled();
  });
});

describe('MeshCoreManager.sendRepeaterCommand is not gated wholesale (#4547 WP2)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('setName still functions on a Repeater while receive-only (serial-only "set name")', async () => {
    vi.useFakeTimers();
    const m = freshManager();
    internals(m).deviceType = MeshCoreDeviceType.REPEATER;
    internals(m).serialPort = { isOpen: true, write: vi.fn() };
    m.setReceiveOnly(true);

    const resultPromise = m.setName('Test Node');
    await vi.advanceTimersByTimeAsync(5000);

    await expect(resultPromise).resolves.toBe(true);
  });

  it('setRadio still functions on a Repeater while receive-only (serial-only "set radio")', async () => {
    vi.useFakeTimers();
    const m = freshManager();
    internals(m).deviceType = MeshCoreDeviceType.REPEATER;
    internals(m).serialPort = { isOpen: true, write: vi.fn() };
    m.setReceiveOnly(true);

    const resultPromise = m.setRadio(915, 250, 7, 5);
    await vi.advanceTimersByTimeAsync(5000);

    await expect(resultPromise).resolves.toBe(true);
  });
});
