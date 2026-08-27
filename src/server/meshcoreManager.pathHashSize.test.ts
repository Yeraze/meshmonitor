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
    expect(bridge).toHaveBeenCalledWith('set_path_hash_mode', { size: 2 });
  });

  it('clamps an invalid size to 1 before persisting/pushing', async () => {
    const { manager, bridge } = makeManager();
    const applied = await manager.setDefaultPathHashSize(9);
    expect(applied).toBe(1);
    expect(setSourceSetting).toHaveBeenCalledWith('src-1', 'meshcoreDefaultPathHashSize', '1');
    expect(bridge).toHaveBeenCalledWith('set_path_hash_mode', { size: 1 });
  });

  it('a device rejection is non-fatal — the setting is still persisted', async () => {
    const { manager, bridge } = makeManager();
    bridge.mockResolvedValueOnce({ id: '1', success: false, error: 'nope' });
    const applied = await manager.setDefaultPathHashSize(3);
    expect(applied).toBe(3); // does not throw
    expect(setSourceSetting).toHaveBeenCalledWith('src-1', 'meshcoreDefaultPathHashSize', '3');
    expect(bridge).toHaveBeenCalledWith('set_path_hash_mode', { size: 3 });
  });

  it('does not push to a non-native (repeater) backend', async () => {
    const { manager, bridge } = makeManager();
    (manager as any).nativeBackend = null;
    await manager.setDefaultPathHashSize(2);
    expect(setSourceSetting).toHaveBeenCalledWith('src-1', 'meshcoreDefaultPathHashSize', '2');
    expect(bridge).not.toHaveBeenCalled();
  });
});
