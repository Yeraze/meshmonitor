import { describe, it, expect, beforeAll, vi } from 'vitest';

/**
 * Regression tests for issue #5045 — the MeshBeacon single-transmit settings
 * (`Transmit Region` / `Transmit Modem Preset`, i.e. `broadcast_on_region` and
 * `broadcast_on_preset`) read back as UNSET / "use running config" right after
 * a save, with the Broadcast Targets list empty.
 *
 * Root cause: `setGenericModuleConfig` sent the admin packet but never touched
 * `actualModuleConfig`, and `GET /api/config/current` serves that cache
 * verbatim. Every *other* module config hid the staleness because the firmware
 * reboots the node after `set_module_config`, which drops the TCP link and
 * makes MeshMonitor re-download the whole config. MeshBeacon is on the
 * firmware's no-reboot allowlist (`shouldReboot = false` in AdminModule's
 * `mesh_beacon` case, alongside statusmessage/mqtt/serial), so nothing ever
 * refreshed the cache and the pre-save values were served indefinitely.
 *
 * Confirmed against a real firmware-2.8 node: after POSTing region=US /
 * preset=LONG_FAST the config API kept returning `broadcastOnRegion: 0` with no
 * `broadcastOnPreset` for two solid minutes, and only a forced reconnect
 * (which re-downloads the config) revealed that the device had persisted both
 * values correctly all along.
 *
 * The cache is refreshed with *replace*, not merge, semantics because the
 * firmware whole-struct-assigns `moduleConfig.mesh_beacon = <incoming>`: a
 * field the client omitted is cleared on the device, so a merge would leave the
 * cache claiming a value the node no longer holds.
 */

// Stub the TCP transport so constructing a manager never touches a real socket
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

// Prevent the constructor's async position-recalc path from touching the DB
vi.mock('../services/database.js', () => {
  const shared = {
    waitForReady: vi.fn().mockResolvedValue(undefined),
    settings: {
      getSetting: vi.fn().mockResolvedValue(null),
      setSetting: vi.fn().mockResolvedValue(undefined),
    },
    getAllTraceroutesForRecalculationAsync: vi.fn().mockResolvedValue([]),
    sources: {
      getSource: vi.fn().mockResolvedValue(null),
    },
    nodes: {
      getNode: vi.fn().mockResolvedValue(null),
      upsertNode: vi.fn().mockResolvedValue(undefined),
      getActiveNodes: vi.fn().mockResolvedValue([]),
      getAllNodes: vi.fn().mockResolvedValue([]),
    },
    recordTracerouteRequestAsync: vi.fn().mockResolvedValue(undefined),
  };
  return { default: shared, databaseService: shared };
});

import { MeshtasticManager } from './meshtasticManager.js';
import protobufService from './protobufService.js';
import { loadProtobufDefinitions, getProtobufRoot } from './protobufLoader.js';

/**
 * Enum wire values. Note the deliberate asymmetry, which is the whole trap in
 * this area: `RegionCode.UNSET` is 0, so region 0 genuinely means "not set",
 * while `broadcast_on_preset` is declared `optional` in the proto — it has
 * explicit presence, and preset 0 (LONG_FAST) is a real, selectable value that
 * a `|| null` / `?? 0` style default would erase or invent.
 */
const REGION_UNSET = 0;
const REGION_US = 1;
const PRESET_LONG_FAST = 0;
const PRESET_MEDIUM_SLOW = 3;

/**
 * The payload `buildMeshBeaconConfigPayload` produces for the issue's repro:
 * targets list empty, single-transmit region US, single-transmit preset
 * LONG_FAST. `broadcastOnPreset` is included only when non-null, mirroring the
 * builder's `optional`-field handling.
 */
function transmitPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    flags: 2,
    broadcastMessage: '',
    broadcastSendAsNode: 0,
    broadcastOfferRegion: REGION_UNSET,
    broadcastIntervalSecs: 3600,
    broadcastOnRegion: REGION_US,
    broadcastTargets: [],
    broadcastOnPreset: PRESET_LONG_FAST,
    ...overrides,
  };
}

/**
 * The shape `processConfig` stores in `actualModuleConfig` after the device's
 * config download: a decoded `ModuleConfig.meshBeacon` message. Here it holds
 * the pre-save state — beacon enabled, no transmit region, no transmit preset.
 */
function decodedMeshBeaconConfig(meshBeacon: Record<string, unknown>): any {
  const ModuleConfig = getProtobufRoot()!.lookupType('meshtastic.ModuleConfig');
  const encoded = ModuleConfig.encode(ModuleConfig.create({ meshBeacon })).finish();
  return { ...(ModuleConfig.decode(encoded) as any) };
}

function makeManager(moduleConfig: any) {
  const mgr = new MeshtasticManager('src-1', { host: '127.0.0.1', port: 4403 });
  (mgr as any).localNodeInfo = { nodeNum: 123, nodeId: '!0000007b', firmwareVersion: '2.8.0' };
  (mgr as any).actualModuleConfig = moduleConfig;
  // Let the admin send succeed without a socket.
  (mgr as any).isTransportReady = () => true;
  (mgr as any).sendLocalAdminPacket = vi.fn().mockResolvedValue(undefined);
  return mgr;
}

/** What `GET /api/config/current` actually hands the Configuration tab. */
function readBack(mgr: MeshtasticManager): any {
  return JSON.parse(JSON.stringify(mgr.getCurrentConfig())).moduleConfig.meshBeacon;
}

describe('MeshBeacon single-transmit settings survive a save (#5045)', () => {
  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  it('serves the just-saved transmit region and preset, not the pre-save values', async () => {
    const mgr = makeManager(decodedMeshBeaconConfig({ flags: 2, broadcastIntervalSecs: 3600 }));

    // Pre-condition: the device had neither field set.
    expect(readBack(mgr).broadcastOnRegion).toBe(REGION_UNSET);
    expect(readBack(mgr).broadcastOnPreset).toBeUndefined();

    await mgr.setGenericModuleConfig('meshbeacon', transmitPayload());

    const wire = readBack(mgr);
    expect(wire.broadcastOnRegion).toBe(REGION_US);
    // Preset 0 is LONG_FAST, a real selection — it must come back as 0, not be
    // dropped as if it were an absent `optional` field.
    expect(wire.broadcastOnPreset).toBe(PRESET_LONG_FAST);
    expect(typeof wire.broadcastOnRegion).toBe('number');
    expect(typeof wire.broadcastOnPreset).toBe('number');
  });

  it('keeps an empty broadcast targets list empty', async () => {
    const mgr = makeManager(decodedMeshBeaconConfig({ flags: 2 }));
    await mgr.setGenericModuleConfig('meshbeacon', transmitPayload());
    expect(readBack(mgr).broadcastTargets).toEqual([]);
  });

  it('clears an optional preset the user reset to "use running config"', async () => {
    // The device whole-struct-replaces, so omitting `broadcast_on_preset`
    // clears it there; a merging cache would keep serving the old preset.
    const mgr = makeManager(
      decodedMeshBeaconConfig({ flags: 2, broadcastOnRegion: REGION_US, broadcastOnPreset: PRESET_MEDIUM_SLOW }),
    );
    expect(readBack(mgr).broadcastOnPreset).toBe(PRESET_MEDIUM_SLOW);

    const { broadcastOnPreset: _omitted, ...withoutPreset } = transmitPayload();
    await mgr.setGenericModuleConfig('meshbeacon', withoutPreset);

    const wire = readBack(mgr);
    expect(wire.broadcastOnPreset).toBeUndefined();
    expect(wire.broadcastOnRegion).toBe(REGION_US);
  });

  it('leaves the cache alone when the send fails', async () => {
    const mgr = makeManager(decodedMeshBeaconConfig({ flags: 2 }));
    (mgr as any).sendLocalAdminPacket = vi.fn().mockRejectedValue(new Error('transmit disabled'));

    await expect(mgr.setGenericModuleConfig('meshbeacon', transmitPayload())).rejects.toThrow();
    expect(readBack(mgr).broadcastOnRegion).toBe(REGION_UNSET);
  });

  it('refreshes other module sections too, without disturbing their siblings', async () => {
    const mgr = makeManager({ serial: { enabled: false, baud: 0 }, telemetry: { deviceUpdateInterval: 900 } });
    await mgr.setGenericModuleConfig('serial', { enabled: true, baud: 5, echo: false });

    const wire = JSON.parse(JSON.stringify(mgr.getCurrentConfig())).moduleConfig;
    expect(wire.serial).toEqual({ enabled: true, baud: 5, echo: false });
    expect(wire.telemetry.deviceUpdateInterval).toBe(900);
  });
});

describe('MeshBeacon transmit fields on the wire (#5045)', () => {
  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  /**
   * Asserts the protocol, not our implementation: `broadcast_on_region` is a
   * plain proto3 enum (tag 9) and `broadcast_on_preset` is `optional` (tag 10),
   * so an explicit preset 0 must appear on the wire while an omitted one must
   * not — that is what lets the device tell "LONG_FAST" apart from "use the
   * running config".
   */
  function decodeSetModuleConfig(config: Record<string, unknown>): any {
    const encoded = protobufService.createSetModuleConfigMessageGeneric('meshbeacon', config, new Uint8Array());
    const AdminMessage = getProtobufRoot()!.lookupType('meshtastic.AdminMessage');
    return (AdminMessage.decode(encoded) as any).setModuleConfig.meshBeacon;
  }

  it('encodes an explicit LONG_FAST preset and a US region', () => {
    const beacon = decodeSetModuleConfig(transmitPayload());
    expect(beacon.broadcastOnRegion).toBe(REGION_US);
    expect(Object.prototype.hasOwnProperty.call(beacon, 'broadcastOnPreset')).toBe(true);
    expect(beacon.broadcastOnPreset).toBe(PRESET_LONG_FAST);
  });

  it('omits the preset entirely when the user chose "use running config"', () => {
    const { broadcastOnPreset: _omitted, ...withoutPreset } = transmitPayload();
    const beacon = decodeSetModuleConfig(withoutPreset);
    expect(Object.prototype.hasOwnProperty.call(beacon, 'broadcastOnPreset')).toBe(false);
    expect(beacon.broadcastOnRegion).toBe(REGION_US);
  });
});
