/**
 * P8a #6257 WP1 — manager wrappers for the Companion BLE PIN, multi-ACKs and
 * factory reset: gating, readback, and the post-reset identity bookkeeping.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';
import { meshcoreOwnIdentityTracker } from './services/meshcoreOwnIdentityTracker.js';
import databaseService from '../services/database.js';

function make(opts: { fw?: number; type?: MeshCoreDeviceType; connected?: boolean; multiAcksReadback?: number | null; fail?: boolean } = {}) {
  const m = new MeshCoreManager('src-p8');
  (m as any).deviceType = opts.type ?? MeshCoreDeviceType.COMPANION;
  (m as any).connected = opts.connected ?? true;
  (m as any).localNode = { publicKey: 'ab'.repeat(32), name: 'n', advType: 1, firmwareVer: opts.fw ?? 7 };
  const calls: Array<{ cmd: string; params: any }> = [];
  (m as any).sendBridgeCommand = async (cmd: string, params: any) => {
    calls.push({ cmd, params });
    if (opts.fail) return { id: '1', success: false, error: 'ERR' };
    if (cmd === 'set_multi_acks') {
      const rb = opts.multiAcksReadback === undefined ? params.value : opts.multiAcksReadback;
      return { id: '1', success: true, data: { multi_acks: rb, requested: params.value } };
    }
    if (cmd === 'device_query') return { id: '1', success: true, data: { 'fw ver': opts.fw ?? 7, ble_pin: 123456 } };
    return { id: '1', success: true, data: { ok: true } };
  };
  return { m, calls };
}

describe('MeshCoreManager Companion commands (P8a #6257)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('setBlePin sends the pin; rejects bad pins; needs a connected Companion', async () => {
    const { m, calls } = make();
    await m.setBlePin(654321);
    expect(calls).toEqual([{ cmd: 'set_device_pin', params: { pin: 654321 } }]);
    await expect(m.setBlePin(1234567)).rejects.toMatchObject({ code: 'INVALID_PIN' });
    await expect(make({ connected: false }).m.setBlePin(123456)).rejects.toMatchObject({ code: 'SOURCE_NOT_CONNECTED' });
    await expect(make({ type: MeshCoreDeviceType.REPEATER }).m.setBlePin(123456)).rejects.toMatchObject({ code: 'SOURCE_NOT_CONNECTED' });
  });

  it('setBlePin maps a device refusal to COMMAND_FAILED', async () => {
    await expect(make({ fail: true }).m.setBlePin(123456)).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
  });

  it('getBlePin reads DeviceInfo', async () => {
    const { m } = make();
    expect(await m.getBlePin()).toBe(123456);
  });

  it('firmware gate: version 6 refused, 7 allowed (multi-acks and factory reset)', async () => {
    const six = make({ fw: 6 });
    await expect(six.m.setMultiAcks(1)).rejects.toMatchObject({ code: 'FIRMWARE_UNSUPPORTED' });
    await expect(six.m.factoryReset()).rejects.toMatchObject({ code: 'FIRMWARE_UNSUPPORTED' });
    expect(six.calls.filter((c) => c.cmd !== 'device_query')).toEqual([]);
    const seven = make({ fw: 7 });
    expect(await seven.m.setMultiAcks(1)).toBe(1);
    expect(seven.m.getLocalNode()?.multiAcks).toBe(1);
  });

  it('multi-acks readback mismatch -> MULTI_ACKS_UNSUPPORTED, localNode untouched', async () => {
    const { m } = make({ multiAcksReadback: 0 });
    await expect(m.setMultiAcks(1)).rejects.toMatchObject({ code: 'MULTI_ACKS_UNSUPPORTED' });
    expect(m.getLocalNode()?.multiAcks).toBeUndefined();
  });

  it('a missing multi-acks readback is a retryable COMMAND_FAILED, not old firmware', async () => {
    const none = make({ multiAcksReadback: null });
    await expect(none.m.setMultiAcks(1)).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
  });

  it('factoryReset sends the command, drops the PKI row and announces the identity change', async () => {
    const del = vi.spyOn(databaseService.meshcoreSourcePkiKeys, 'deleteBySourceId').mockResolvedValue(undefined);
    const expect_ = vi.spyOn(meshcoreOwnIdentityTracker, 'expectChange');
    const { m, calls } = make();
    await m.factoryReset();
    expect(calls).toEqual([{ cmd: 'factory_reset', params: {} }]);
    expect(del).toHaveBeenCalledWith('src-p8');
    expect(expect_).toHaveBeenCalledWith('src-p8', { reason: 'factory_reset' });
  });

  it('a failed reset leaves the key row and tracker alone', async () => {
    const del = vi.spyOn(databaseService.meshcoreSourcePkiKeys, 'deleteBySourceId').mockResolvedValue(undefined);
    const expect_ = vi.spyOn(meshcoreOwnIdentityTracker, 'expectChange');
    await expect(make({ fail: true }).m.factoryReset()).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
    expect(del).not.toHaveBeenCalled();
    expect(expect_).not.toHaveBeenCalled();
  });

  it('the next identity change after a reset writes the audit row and no alert', async () => {
    const audit = vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined as any);
    vi.spyOn(meshcoreOwnIdentityTracker, 'observe').mockResolvedValue('expected');
    vi.spyOn(meshcoreOwnIdentityTracker, 'takeExpectedReason').mockReturnValue('factory_reset');
    const getChange = vi.spyOn(meshcoreOwnIdentityTracker, 'getChange');
    const { m } = make();
    await (m as any).observeOwnIdentity('cd'.repeat(32));
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0][1]).toBe('meshcore_identity_changed_expected');
    expect(JSON.parse(audit.mock.calls[0][3] as string).reason).toBe('factory_reset');
    expect(getChange).not.toHaveBeenCalled();
  });
});
