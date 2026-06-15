/**
 * Tests for MeshCoreManager.shareContact().
 *
 * Share Contact wraps the firmware's CMD_SHARE_CONTACT (opcode 16). The
 * underlying meshcore.js call rejects with NO argument on a firmware Err, so
 * the manager must manufacture an actionable reason rather than returning a
 * bare boolean / `String(undefined)`. See issue #3480 (silent failure on
 * MeshCore TCP Companion sources).
 *
 * Uses the private-method-stubbing pattern from meshcoreManager.channels.test.ts.
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

describe('MeshCoreManager — shareContact', () => {
  const PK = 'a'.repeat(64);

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns ok:true and issues share_contact with a short timeout', async () => {
    const { manager, bridgeCalls } = makeManager({});
    const result = await manager.shareContact(PK);

    expect(result).toEqual({ ok: true });
    expect(bridgeCalls).toHaveLength(1);
    expect(bridgeCalls[0].cmd).toBe('share_contact');
    expect(bridgeCalls[0].params).toEqual({ public_key: PK });
    // Short dedicated timeout, NOT the 30s default — fails fast on a non-acking device.
    expect(bridgeCalls[0].timeout).toBe(10_000);
  });

  it('returns an actionable error when the device is not a Companion', async () => {
    const { manager, bridgeCalls } = makeManager({ deviceType: MeshCoreDeviceType.REPEATER });
    const result = await manager.shareContact(PK);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Companion/i);
    // Short-circuits before issuing any bridge command.
    expect(bridgeCalls).toHaveLength(0);
  });

  it('returns an actionable error when disconnected', async () => {
    const { manager, bridgeCalls } = makeManager({ connected: false });
    const result = await manager.shareContact(PK);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/disconnected/i);
    expect(bridgeCalls).toHaveLength(0);
  });

  it('maps a backend timeout to a firmware-support hint (not a raw timeout string)', async () => {
    const { manager } = makeManager({
      response: { success: false, error: 'Native command timeout: share_contact' },
    });
    const result = await manager.shareContact(PK);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/did not respond/i);
    expect(result.error).toMatch(/firmware may not support/i);
  });

  it('replaces a useless "undefined" backend error with a firmware-support hint', async () => {
    // meshcore.js reject() with no argument → String(undefined) === "undefined".
    const { manager } = makeManager({ response: { success: false, error: 'undefined' } });
    const result = await manager.shareContact(PK);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/firmware may not support/i);
    expect(result.error).not.toMatch(/undefined/);
  });

  it('forwards a descriptive backend error verbatim', async () => {
    const { manager } = makeManager({
      response: {
        success: false,
        error: 'Device rejected share-contact — the firmware may not support CMD_SHARE_CONTACT (opcode 16)',
      },
    });
    const result = await manager.shareContact(PK);

    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      'Device rejected share-contact — the firmware may not support CMD_SHARE_CONTACT (opcode 16)',
    );
  });
});
