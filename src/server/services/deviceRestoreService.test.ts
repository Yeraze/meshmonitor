import { describe, it, expect, vi, beforeEach } from 'vitest';
import YAML from 'yamljs';
import { deviceRestoreService } from './deviceRestoreService.js';

// Mock channelUrlService so the channel_url branch decodes deterministically
// without depending on real URL-encoding internals.
vi.mock('./channelUrlService.js', () => ({
  default: {
    decodeUrl: vi.fn(() => ({
      channels: [
        { name: 'Primary', psk: 'none', role: 1, uplinkEnabled: false, downlinkEnabled: false, positionPrecision: 0 },
        { name: 'Secondary', psk: 'base64:AQ==', role: 2, uplinkEnabled: true, downlinkEnabled: true, positionPrecision: 13 },
      ],
    })),
  },
}));

/** A representative backup with STRING enum values, as deviceBackupService writes them. */
function sampleBackup(overrides: Record<string, any> = {}): string {
  const backup: any = {
    channel_url: 'https://meshtastic.org/e/#SAMPLE',
    config: {
      device: { role: 'ROUTER', nodeInfoBroadcastSecs: 10800 },
      lora: { usePreset: true, modemPreset: 'LONG_FAST', region: 'US', hopLimit: 3, txEnabled: true },
      position: { positionBroadcastSecs: 900, fixedPosition: true },
      network: { wifiEnabled: false },
      power: { isPowerSaving: false },
      display: { screenOnSecs: 600 },
      bluetooth: { enabled: true },
    },
    location: { lat: 30.1, lon: -95.2, alt: 42 },
    module_config: {
      mqtt: { enabled: false },
      telemetry: { deviceUpdateInterval: 900 },
      neighborInfo: { enabled: false },
      detectionSensor: { enabled: true, detectionTriggerType: 'LOGIC_LOW' },
      serial: { enabled: false },
    },
    owner: 'Test Node',
    owner_short: 'TN',
    ...overrides,
  };
  return '# start of Meshtastic configure yaml\n' + YAML.stringify(backup, 6, 2);
}

function makeManager() {
  return {
    beginEditSettings: vi.fn().mockResolvedValue(undefined),
    commitEditSettings: vi.fn().mockResolvedValue(undefined),
    setDeviceConfig: vi.fn().mockResolvedValue(undefined),
    setLoRaConfig: vi.fn().mockResolvedValue(undefined),
    setPositionConfig: vi.fn().mockResolvedValue(undefined),
    setNetworkConfig: vi.fn().mockResolvedValue(undefined),
    setPowerConfig: vi.fn().mockResolvedValue(undefined),
    setDisplayConfig: vi.fn().mockResolvedValue(undefined),
    setBluetoothConfig: vi.fn().mockResolvedValue(undefined),
    setMQTTConfig: vi.fn().mockResolvedValue(undefined),
    setTelemetryConfig: vi.fn().mockResolvedValue(undefined),
    setNeighborInfoConfig: vi.fn().mockResolvedValue(undefined),
    setGenericModuleConfig: vi.fn().mockResolvedValue(undefined),
    setChannelConfig: vi.fn().mockResolvedValue(undefined),
    setNodeOwner: vi.fn().mockResolvedValue(undefined),
    isTxEnabled: vi.fn().mockReturnValue(true),
  };
}

/** Drive a restore to completion under fake timers (the service paces with setTimeout). */
async function runRestore(mgr: any, yaml: string) {
  vi.useFakeTimers();
  try {
    // Attach settle handlers immediately so a synchronous rejection (e.g. begin
    // fails before any timer) is never briefly unhandled while we pump timers.
    let outcome: { ok?: any; err?: unknown } = {};
    const settled = deviceRestoreService
      .restoreBackup(mgr, yaml)
      .then((r) => { outcome = { ok: r }; }, (e) => { outcome = { err: e }; });
    await vi.runAllTimersAsync();
    await settled;
    if ('err' in outcome) throw outcome.err;
    return outcome.ok;
  } finally {
    vi.useRealTimers();
  }
}

describe('deviceRestoreService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('parseBackup throws on invalid YAML content', () => {
    expect(() => deviceRestoreService.parseBackup('')).toThrow();
    expect(() => deviceRestoreService.parseBackup('just a string')).toThrow();
  });

  it('opens and commits an edit transaction around the writes', async () => {
    const mgr = makeManager();
    await runRestore(mgr, sampleBackup());
    expect(mgr.beginEditSettings).toHaveBeenCalledTimes(1);
    expect(mgr.commitEditSettings).toHaveBeenCalledTimes(1);
  });

  it('reverses string enums back to numbers for device role, lora preset/region', async () => {
    const mgr = makeManager();
    const result = await runRestore(mgr, sampleBackup());

    expect(mgr.setDeviceConfig).toHaveBeenCalledWith(expect.objectContaining({ role: 2 })); // ROUTER
    expect(mgr.setLoRaConfig).toHaveBeenCalledWith(
      expect.objectContaining({ modemPreset: 0, region: 1, txEnabled: true }), // LONG_FAST / US, verbatim TX
    );
    expect(result.requiresReboot).toBe(true);
  });

  it('reverses detectionTriggerType inside a generic module section', async () => {
    const mgr = makeManager();
    await runRestore(mgr, sampleBackup());
    expect(mgr.setGenericModuleConfig).toHaveBeenCalledWith(
      'detectionsensor',
      expect.objectContaining({ detectionTriggerType: 2 }), // LOGIC_LOW
    );
  });

  it('merges the fixed location into the position config as latitude/longitude/altitude', async () => {
    const mgr = makeManager();
    await runRestore(mgr, sampleBackup());
    expect(mgr.setPositionConfig).toHaveBeenCalledWith(
      expect.objectContaining({ latitude: 30.1, longitude: -95.2, altitude: 42, positionBroadcastSecs: 900 }),
    );
  });

  it('restores owner, dedicated module setters, and every decoded channel', async () => {
    const mgr = makeManager();
    const result = await runRestore(mgr, sampleBackup());
    expect(mgr.setNodeOwner).toHaveBeenCalledWith('Test Node', 'TN');
    expect(mgr.setMQTTConfig).toHaveBeenCalledTimes(1);
    expect(mgr.setTelemetryConfig).toHaveBeenCalledTimes(1);
    expect(mgr.setNeighborInfoConfig).toHaveBeenCalledTimes(1);
    expect(mgr.setChannelConfig).toHaveBeenCalledTimes(2);
    // psk 'none' becomes undefined; base64 psk passes through.
    expect(mgr.setChannelConfig).toHaveBeenCalledWith(0, expect.objectContaining({ psk: undefined, role: 1 }));
    expect(mgr.setChannelConfig).toHaveBeenCalledWith(1, expect.objectContaining({ psk: 'base64:AQ==', role: 2 }));
    expect(result.channels).toBe(2);
  });

  it('backfills txEnabled from the device when the backup lora omits it', async () => {
    const mgr = makeManager();
    mgr.isTxEnabled.mockReturnValue(false);
    const yaml = sampleBackup({
      config: {
        lora: { usePreset: true, modemPreset: 'SHORT_FAST', region: 'EU_868', hopLimit: 3 }, // no txEnabled
      },
    });
    await runRestore(mgr, yaml);
    expect(mgr.setLoRaConfig).toHaveBeenCalledWith(expect.objectContaining({ txEnabled: false }));
    expect(mgr.isTxEnabled).toHaveBeenCalled();
  });

  it('is best-effort: a failing section is recorded but the restore continues and commits', async () => {
    const mgr = makeManager();
    mgr.setDisplayConfig.mockRejectedValue(new Error('device rejected display'));
    const result = await runRestore(mgr, sampleBackup());
    expect(result.failed).toEqual([{ section: 'config.display', error: 'device rejected display' }]);
    expect(mgr.setLoRaConfig).toHaveBeenCalled(); // later sections still ran
    expect(mgr.commitEditSettings).toHaveBeenCalledTimes(1);
  });

  it('reports requiresReboot=false when the LoRa write itself failed', async () => {
    const mgr = makeManager();
    mgr.setLoRaConfig.mockRejectedValue(new Error('device rejected lora'));
    const result = await runRestore(mgr, sampleBackup());
    expect(result.failed).toContainEqual({ section: 'config.lora', error: 'device rejected lora' });
    // LoRa never landed, so no reboot is actually pending.
    expect(result.requiresReboot).toBe(false);
    expect(mgr.commitEditSettings).toHaveBeenCalledTimes(1);
  });

  it('aborts when the edit transaction cannot be opened', async () => {
    const mgr = makeManager();
    mgr.beginEditSettings.mockRejectedValue(new Error('Not connected to Meshtastic node'));
    await expect(runRestore(mgr, sampleBackup())).rejects.toThrow('Failed to start configuration transaction');
    expect(mgr.setDeviceConfig).not.toHaveBeenCalled();
  });
});
