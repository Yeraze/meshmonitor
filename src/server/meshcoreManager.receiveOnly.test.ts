/**
 * MeshCore strict receive-only mode (#4547 epic, Phase 1 WP1 — Foundations).
 *
 * Covers only the WP1 slice: manager state (isReceiveOnly/canTransmit),
 * refreshReceiveOnly() DB read + fail-safe caching, setReceiveOnly()'s
 * state-change-only logging + native-backend push, the sendBridgeCommand
 * command-name-aware gate, and that connect() refreshes the flag on every
 * (re)connect. The per-method requireTransmit() guards (WP2), scheduler
 * silent-skips and native-backend chokepoint B (WP3) are covered by their
 * own test files, not here.
 *
 * See docs/internal/dev-notes/MESHCORE_RECEIVE_ONLY_PHASE1_SPEC.md §2.3.1-2.3.3, §3.2.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MeshCoreManager, ConnectionType, type MeshCoreConfig } from './meshcoreManager.js';
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
