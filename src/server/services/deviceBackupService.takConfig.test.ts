/**
 * Device backup of the TAK module section (#5613).
 *
 * `cleanConfig` converts enums by KEY NAME, and `role` already means the device
 * role there. Without its own branch, TAKConfig.role (a MemberRole) would be
 * exported under a device role name — MemberRole 2 (TeamLead) as "ROUTER" —
 * and a restore would then write garbage. These tests pin the TAK branch and
 * the full backup → YAML → restore round trip.
 */
import { describe, it, expect, vi } from 'vitest';
import YAML from 'yamljs';
import { deviceBackupService } from './deviceBackupService.js';
import { deviceRestoreService } from './deviceRestoreService.js';

vi.mock('./channelUrlService.js', () => ({
  default: { decodeUrl: vi.fn(() => ({ channels: [] })) },
}));

/** cleanConfig is private; it is the unit that shapes module_config. */
const cleanConfig = (config: unknown): Record<string, any> =>
  (deviceBackupService as unknown as { cleanConfig(c: unknown): Record<string, any> }).cleanConfig(config);

describe('deviceBackupService — TAK module section', () => {
  it('writes team and role under their TAK enum names', () => {
    expect(cleanConfig({ tak: { team: 5, role: 2 } })).toEqual({ tak: { team: 'Red', role: 'TeamLead' } });
  });

  it('does NOT write the TAK role as a device role name', () => {
    // Device role 2 is ROUTER; TAK member role 2 is TeamLead.
    const cleaned = cleanConfig({ device: { role: 2 }, tak: { role: 2 } });
    expect(cleaned.device.role).toBe('ROUTER');
    expect(cleaned.tak.role).toBe('TeamLead');
  });

  it('leaves a default field out, and an all-default section out entirely', () => {
    expect(cleanConfig({ tak: { team: 12 } })).toEqual({ tak: { team: 'Green' } });
    expect(cleanConfig({ tak: { team: 0, role: 0 } })).toEqual({});
    expect(cleanConfig({ tak: {} })).toEqual({});
  });

  it('reads a section that already holds enum names', () => {
    expect(cleanConfig({ tak: { team: 'Blue', role: 'Medic' } })).toEqual({ tak: { team: 'Blue', role: 'Medic' } });
  });

  it('other module sections are untouched', () => {
    const cleaned = cleanConfig({ serial: { enabled: true, baud: 5 }, tak: { team: 1, role: 1 } });
    expect(cleaned.serial).toEqual({ enabled: true, baud: 5 });
  });

  it('round trip: backup YAML restores the same team and role', async () => {
    const backup = {
      config: {},
      module_config: cleanConfig({ tak: { team: 14, role: 7 } }),
      owner: 'Test Node',
      owner_short: 'TN',
    };
    const yaml = '# start of Meshtastic configure yaml\n' + YAML.stringify(backup, 6, 2);
    expect(yaml).toContain('team: Brown');
    expect(yaml).toContain('role: RTO');

    const setGenericModuleConfig = vi.fn().mockResolvedValue(undefined);
    const noop = vi.fn().mockResolvedValue(undefined);
    const manager = {
      beginEditSettings: noop, commitEditSettings: noop, setDeviceConfig: noop, setLoRaConfig: noop,
      setPositionConfig: noop, setNetworkConfig: noop, setPowerConfig: noop, setDisplayConfig: noop,
      setBluetoothConfig: noop, setMQTTConfig: noop, setTelemetryConfig: noop, setNeighborInfoConfig: noop,
      setGenericModuleConfig, setChannelConfig: noop, setNodeOwner: noop,
      isTxEnabled: vi.fn().mockReturnValue(true),
    };

    vi.useFakeTimers();
    try {
      const done = deviceRestoreService.restoreBackup(manager, yaml);
      await vi.runAllTimersAsync();
      await done;
    } finally {
      vi.useRealTimers();
    }

    expect(setGenericModuleConfig).toHaveBeenCalledWith('tak', { team: 14, role: 7 });
  });
});
