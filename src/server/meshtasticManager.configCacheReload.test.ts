/**
 * A local config save, then a reload of the Configuration tab
 * (`getCurrentConfig()`, which `GET /api/config/current` serves), with no
 * reconnect in between.
 *
 * Firmware does not reboot after every save: LoRa applies live, device/power/
 * display skip the reboot when no reboot-only field changed, and statusmessage
 * and MeshBeacon never reboot. With no reboot nothing re-downloads the config,
 * so the cache the save wrote is all a reload sees. NeighborInfo used to write
 * the device bucket under a key nothing reads, so the reload showed the old
 * values; merged sections kept fields the device had cleared.
 *
 * The transport is stubbed: nothing reaches a radio.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('./tcpTransport.js', () => ({
  TcpTransport: class {
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn().mockResolvedValue(undefined);
    send = vi.fn().mockResolvedValue(undefined);
    on = vi.fn();
    off = vi.fn();
    isConnected = () => true;
    setStaleConnectionTimeout = vi.fn();
    setConnectTimeout = vi.fn();
    setReconnectTiming = vi.fn();
  },
}));

vi.mock('../services/database.js', () => {
  const shared = {
    waitForReady: vi.fn().mockResolvedValue(undefined),
    settings: {
      getSetting: vi.fn().mockResolvedValue(null),
      setSetting: vi.fn().mockResolvedValue(undefined),
    },
    getAllTraceroutesForRecalculationAsync: vi.fn().mockResolvedValue([]),
    sources: { getSource: vi.fn().mockResolvedValue(null) },
    nodes: {
      getNode: vi.fn().mockResolvedValue(null),
      upsertNode: vi.fn().mockResolvedValue(undefined),
      getActiveNodes: vi.fn().mockResolvedValue([]),
      getAllNodes: vi.fn().mockResolvedValue([]),
    },
    upsertNodeAsync: vi.fn().mockResolvedValue(undefined),
    recordTracerouteRequestAsync: vi.fn().mockResolvedValue(undefined),
  };
  return { default: shared, databaseService: shared };
});

import { MeshtasticManager } from './meshtasticManager.js';
import { loadProtobufDefinitions } from './protobufLoader.js';

/** A manager whose last config download held `device`/`module`, with sends stubbed. */
function connectedManager(device: Record<string, unknown>, module: Record<string, unknown>) {
  const mgr = new MeshtasticManager('src-1', { host: '127.0.0.1', port: 4403 });
  (mgr as any).actualDeviceConfig = device;
  (mgr as any).actualModuleConfig = module;
  vi.spyOn(mgr, 'isTransportReady').mockReturnValue(true);
  vi.spyOn(mgr, 'getLocalNodeInfo').mockReturnValue({ nodeNum: 111 } as any);
  const send = vi.spyOn(mgr, 'sendLocalAdminPacket').mockResolvedValue(undefined as any);
  return { mgr, send };
}

describe('config save then reload, without a reconnect', () => {
  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  it('NeighborInfo: the reload shows the saved values, read from the module config', async () => {
    const { mgr, send } = connectedManager(
      {},
      { neighborInfo: { enabled: false, updateInterval: 21600, transmitOverLora: true } },
    );
    await mgr.setNeighborInfoConfig({ enabled: true, updateInterval: 14400 });

    expect(send).toHaveBeenCalledTimes(1);
    const { deviceConfig, moduleConfig } = mgr.getCurrentConfig();
    // transmitOverLora was left out of the save, so the device cleared it.
    expect(moduleConfig.neighborInfo).toEqual({ enabled: true, updateInterval: 14400, transmitOverLora: false });
    expect(deviceConfig.neighborinfo).toBeUndefined();
    expect(deviceConfig.neighborInfo).toBeUndefined();
  });

  it.each([
    ['telemetry', (m: MeshtasticManager, c: any) => m.setTelemetryConfig(c)],
    ['statusmessage', (m: MeshtasticManager, c: any) => m.setGenericModuleConfig('statusmessage', c)],
    ['serial', (m: MeshtasticManager, c: any) => m.setGenericModuleConfig('serial', c)],
  ] as const)('module %s: the reload shows the save and drops a field it left out', async (key, save) => {
    const { mgr } = connectedManager({}, { [key]: { oldField: 1 } });
    await save(mgr, { newField: 2 });
    const section = mgr.getCurrentConfig().moduleConfig[key];
    expect(section).toMatchObject({ newField: 2 });
    expect(section.oldField).toBeUndefined();
  });

  it('LoRa (applies live, no reboot): the reload shows the save', async () => {
    const { mgr } = connectedManager(
      { lora: { region: 1, hopLimit: 3, txEnabled: true, ignoreIncoming: [42] } },
      {},
    );
    await mgr.setLoRaConfig({ region: 1, hopLimit: 5, txEnabled: true, modemPreset: 0, usePreset: true });
    const lora = mgr.getCurrentConfig().deviceConfig.lora;
    expect(lora).toMatchObject({ region: 1, hopLimit: 5, txEnabled: true, usePreset: true });
    // ignore_incoming was not in the save; firmware's whole-struct assign clears it.
    expect(lora.ignoreIncoming).toBeUndefined();
  });

  it.each([
    ['device', (m: MeshtasticManager, c: any) => m.setDeviceConfig(c), { role: 0, tzdef: 'UTC' }, { tzdef: 'EST5EDT' }],
    ['power', (m: MeshtasticManager, c: any) => m.setPowerConfig(c), { isPowerSaving: true, sdsSecs: 60 }, { isPowerSaving: false }],
    ['display', (m: MeshtasticManager, c: any) => m.setDisplayConfig(c), { screenOnSecs: 60, flipScreen: true }, { screenOnSecs: 30 }],
  ] as const)('device %s: the reload shows the save, not the pre-save values', async (key, save, before, after) => {
    const { mgr } = connectedManager({ [key]: { ...before } }, {});
    await save(mgr, { ...after });
    const section = mgr.getCurrentConfig().deviceConfig[key];
    expect(section).toMatchObject(after);
    for (const field of Object.keys(before)) {
      if (!(field in after)) expect(section[field]).not.toBe((before as any)[field]);
    }
  });
});
