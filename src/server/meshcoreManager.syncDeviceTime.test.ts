/**
 * Tests for MeshCoreManager.syncDeviceTime().
 *
 * Sync wraps the firmware's CMD_SET_DEVICE_TIME. The underlying meshcore.js
 * call rejects with NO argument on a firmware Err, which surfaces as the
 * literal string "undefined" — so before issue #3570 the route reported every
 * failure as "disconnected or not a Companion device" even when the guards had
 * passed and the device had actually rejected the command. The method now
 * returns a discriminated result so the caller can tell the guard cases apart
 * from a real command failure and surface an actionable reason.
 *
 * Uses the private-method-stubbing pattern from meshcoreManager.shareContact.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';

interface BridgeCall {
  cmd: string;
  params: Record<string, unknown>;
  timeout?: number;
}

function makeManager(opts: {
  deviceType?: MeshCoreDeviceType;
  connected?: boolean;
  response?: { success: boolean; data?: unknown; error?: string };
}): { manager: MeshCoreManager; bridgeCalls: BridgeCall[] } {
  const m = new MeshCoreManager('test-source');
  (m as any).deviceType = opts.deviceType ?? MeshCoreDeviceType.COMPANION;
  (m as any).connected = opts.connected ?? true;

  const bridgeCalls: BridgeCall[] = [];
  (m as any).sendBridgeCommand = async (
    cmd: string,
    params: Record<string, unknown>,
    timeout?: number,
  ) => {
    bridgeCalls.push({ cmd, params, timeout });
    return { id: '1', ...(opts.response ?? { success: true, data: { ok: true } }) };
  };

  return { manager: m, bridgeCalls };
}

describe('MeshCoreManager — syncDeviceTime', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns ok:true and issues set_device_time on success', async () => {
    const { manager, bridgeCalls } = makeManager({});
    const result = await manager.syncDeviceTime();

    expect(result).toEqual({ ok: true });
    expect(bridgeCalls).toHaveLength(1);
    expect(bridgeCalls[0].cmd).toBe('set_device_time');
  });

  it('reports reason:not-companion without issuing a command', async () => {
    const { manager, bridgeCalls } = makeManager({ deviceType: MeshCoreDeviceType.REPEATER });
    const result = await manager.syncDeviceTime();

    expect(result).toEqual({ ok: false, reason: 'not-companion' });
    expect(bridgeCalls).toHaveLength(0);
  });

  it('reports reason:disconnected without issuing a command', async () => {
    const { manager, bridgeCalls } = makeManager({ connected: false });
    const result = await manager.syncDeviceTime();

    expect(result).toEqual({ ok: false, reason: 'disconnected' });
    expect(bridgeCalls).toHaveLength(0);
  });

  it('reports reason:command-failed and replaces a useless "undefined" error with a hint (issue #3570)', async () => {
    // meshcore.js reject() with no argument → String(undefined) === "undefined".
    const { manager } = makeManager({ response: { success: false, error: 'undefined' } });
    const result = await manager.syncDeviceTime();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('command-failed');
    expect(result.error).toMatch(/firmware may not support/i);
    expect(result.error).not.toMatch(/undefined/);
  });

  it('maps a backend timeout to a no-response hint', async () => {
    const { manager } = makeManager({
      response: { success: false, error: 'Native command timeout: set_device_time' },
    });
    const result = await manager.syncDeviceTime();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('command-failed');
    expect(result.error).toMatch(/did not respond/i);
  });

  it('forwards a descriptive backend error verbatim', async () => {
    const descriptive =
      'device returned Err to set_device_time (firmware may not support setting the RTC over this transport)';
    const { manager } = makeManager({ response: { success: false, error: descriptive } });
    const result = await manager.syncDeviceTime();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('command-failed');
    expect(result.error).toBe(descriptive);
  });
});
