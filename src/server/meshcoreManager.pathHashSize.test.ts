/**
 * MeshCore default path hash size (#4945).
 *
 * The width is a per-source setting pushed to the companion firmware's
 * persistent NodePrefs (CMD_SET_PATH_HASH_MODE=61). These tests prove the
 * manager's get/set/push plumbing without a real device or DB.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const getSettingForSource = vi.fn().mockResolvedValue(undefined);
const setSourceSetting = vi.fn().mockResolvedValue(undefined);

vi.mock('../services/database.js', () => ({
  default: {
    settings: {
      getSettingForSource: (...a: unknown[]) => getSettingForSource(...a),
      setSourceSetting: (...a: unknown[]) => setSourceSetting(...a),
    },
  },
}));

import { MeshCoreManager } from './meshcoreManager.js';

function makeManager(): { manager: MeshCoreManager; bridge: ReturnType<typeof vi.fn> } {
  const m = new MeshCoreManager('src-1');
  const bridge = vi.fn().mockResolvedValue({ id: '1', success: true, data: {} });
  (m as any).sendBridgeCommand = bridge;
  // applyDefaultPathHashSize is Companion/native only.
  (m as any).nativeBackend = {};
  return { manager: m, bridge };
}

describe('MeshCoreManager — default path hash size (#4945)', () => {
  beforeEach(() => {
    getSettingForSource.mockReset().mockResolvedValue(undefined);
    setSourceSetting.mockReset().mockResolvedValue(undefined);
  });

  it('getDefaultPathHashSize defaults to 1 and preserves 2/3', async () => {
    const { manager } = makeManager();
    getSettingForSource.mockResolvedValueOnce(undefined);
    expect(await manager.getDefaultPathHashSize()).toBe(1);
    getSettingForSource.mockResolvedValueOnce('2');
    expect(await manager.getDefaultPathHashSize()).toBe(2);
    getSettingForSource.mockResolvedValueOnce('3');
    expect(await manager.getDefaultPathHashSize()).toBe(3);
    // Out-of-range / garbage -> 1.
    getSettingForSource.mockResolvedValueOnce('4');
    expect(await manager.getDefaultPathHashSize()).toBe(1);
  });

  it('setDefaultPathHashSize persists the value and pushes it to the device', async () => {
    const { manager, bridge } = makeManager();
    const applied = await manager.setDefaultPathHashSize(2);
    expect(applied).toBe(2);
    expect(setSourceSetting).toHaveBeenCalledWith('src-1', 'meshcoreDefaultPathHashSize', '2');
    expect(bridge).toHaveBeenCalledWith('set_path_hash_mode', { size: 2 }, 5000);
  });

  it('clamps an invalid size to 1 before persisting/pushing', async () => {
    const { manager, bridge } = makeManager();
    const applied = await manager.setDefaultPathHashSize(9);
    expect(applied).toBe(1);
    expect(setSourceSetting).toHaveBeenCalledWith('src-1', 'meshcoreDefaultPathHashSize', '1');
    expect(bridge).toHaveBeenCalledWith('set_path_hash_mode', { size: 1 }, 5000);
  });

  it('a device rejection is non-fatal — the setting is still persisted', async () => {
    const { manager, bridge } = makeManager();
    bridge.mockResolvedValueOnce({ id: '1', success: false, error: 'nope' });
    const applied = await manager.setDefaultPathHashSize(3);
    expect(applied).toBe(3); // does not throw
    expect(setSourceSetting).toHaveBeenCalledWith('src-1', 'meshcoreDefaultPathHashSize', '3');
    expect(bridge).toHaveBeenCalledWith('set_path_hash_mode', { size: 3 }, 5000);
  });

  it('does not push to a non-native (repeater) backend', async () => {
    const { manager, bridge } = makeManager();
    (manager as any).nativeBackend = null;
    await manager.setDefaultPathHashSize(2);
    expect(setSourceSetting).toHaveBeenCalledWith('src-1', 'meshcoreDefaultPathHashSize', '2');
    expect(bridge).not.toHaveBeenCalled();
  });
});

describe('MeshCoreManager — send path hash size for the Virtual Node (#6441)', () => {
  beforeEach(() => {
    getSettingForSource.mockReset().mockResolvedValue(undefined);
    setSourceSetting.mockReset().mockResolvedValue(undefined);
  });

  it('is unknown until a push or device read says otherwise', () => {
    const { manager } = makeManager();
    expect(manager.getSendPathHashSize()).toBeNull();
  });

  it('takes the pushed width when the device accepts it', async () => {
    const { manager } = makeManager();
    await manager.setDefaultPathHashSize(2);
    expect(manager.getSendPathHashSize()).toBe(2);
  });

  it('falls back to the mode DeviceInfo reports when the push is rejected', async () => {
    const { manager, bridge } = makeManager();
    bridge.mockResolvedValueOnce({ id: '1', success: false, error: 'nope' });
    (manager as any).deviceQuery = vi.fn().mockResolvedValue({ firmwareVer: 10, pathHashMode: 1 });
    await manager.setDefaultPathHashSize(3);
    expect(manager.getSendPathHashSize()).toBe(2);
  });

  it('treats firmware older than protocol v10 as 1-byte when the push is rejected', async () => {
    const { manager, bridge } = makeManager();
    bridge.mockResolvedValueOnce({ id: '1', success: false, error: 'unsupported' });
    (manager as any).deviceQuery = vi.fn().mockResolvedValue({ firmwareVer: 9 });
    await manager.setDefaultPathHashSize(2);
    expect(manager.getSendPathHashSize()).toBe(1);
  });

  it('stays unknown when the push fails and DeviceInfo has no mode', async () => {
    const { manager, bridge } = makeManager();
    bridge.mockRejectedValueOnce(new Error('timeout'));
    (manager as any).deviceQuery = vi.fn().mockResolvedValue(null);
    await manager.setDefaultPathHashSize(2);
    expect(manager.getSendPathHashSize()).toBeNull();
  });
});
