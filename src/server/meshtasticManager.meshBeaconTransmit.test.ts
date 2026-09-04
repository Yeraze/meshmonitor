import { describe, it, expect, beforeAll, vi } from 'vitest';

/**
 * Regression tests for issue #5045 — MeshBeacon transmit settings read back as
 * their pre-save values right after a save.
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
 * Confirmed against a real firmware-2.8 node: after POSTing a transmit
 * destination the config API kept returning the pre-save values for two solid
 * minutes, and only a forced reconnect (which re-downloads the config) revealed
 * that the device had persisted them correctly all along.
 *
 * The cache is refreshed with *replace*, not merge, semantics because the
 * firmware whole-struct-assigns `moduleConfig.mesh_beacon = <incoming>`: a
 * field the client omitted is cleared on the device, so a merge would leave the
 * cache claiming a value the node no longer holds.
 *
 * The original repro used the single `broadcast_on_region` / `broadcast_on_preset`
 * fields. Those tags were deleted and reserved (protobufs #1048 / firmware
 * #11646, issue #5062), so the same behaviour is now exercised through
 * `broadcast_targets` — which carries the identical `optional`-enum trap in a
 * target's `preset`. The cache behaviour under test is unchanged.
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
 * this area: a `BroadcastTarget.region` is a plain proto3 enum, so region 0
 * (`RegionCode.UNSET`) genuinely means "use the running config", while
 * `BroadcastTarget.preset` is declared `optional` — it has explicit presence,
 * and preset 0 (LONG_FAST) is a real, selectable value that a `|| null` / `?? 0`
 * style default would erase or invent.
 */
const REGION_UNSET = 0;
const REGION_US = 1;
const PRESET_LONG_FAST = 0;
const PRESET_MEDIUM_SLOW = 3;

/**
 * The payload `buildMeshBeaconConfigPayload` produces for the issue's repro: one
 * broadcast target on region US, preset LONG_FAST, channel slot 1. A target's
 * `preset` / `channelIndex` are included only when non-null, mirroring the
 * builder's `optional`-field handling.
 */
function transmitPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    flags: 2,
    broadcastMessage: '',
    broadcastOfferRegion: REGION_UNSET,
    broadcastIntervalSecs: 3600,
    broadcastTargets: [{ region: REGION_US, preset: PRESET_LONG_FAST, channelIndex: 1 }],
    ...overrides,
  };
}

/**
 * The shape `processConfig` stores in `actualModuleConfig` after the device's
 * config download: a decoded `ModuleConfig.meshBeacon` message.
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

describe('MeshBeacon transmit settings survive a save (#5045)', () => {
  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  it('serves the just-saved broadcast target, not the pre-save empty list', async () => {
    const mgr = makeManager(decodedMeshBeaconConfig({ flags: 2, broadcastIntervalSecs: 3600 }));

    // Pre-condition: the device had no transmit destination at all.
    expect(readBack(mgr).broadcastTargets).toEqual([]);

    await mgr.setGenericModuleConfig('meshbeacon', transmitPayload());

    const target = readBack(mgr).broadcastTargets[0];
    expect(target.region).toBe(REGION_US);
    // Preset 0 is LONG_FAST, a real selection — it must come back as 0, not be
    // dropped as if it were an absent `optional` field.
    expect(target.preset).toBe(PRESET_LONG_FAST);
    expect(target.channelIndex).toBe(1);
    expect(typeof target.region).toBe('number');
    expect(typeof target.preset).toBe('number');
  });

  it('clears every target when the user removed them all', async () => {
    // The device whole-struct-replaces, so an empty list clears the targets
    // there; a merging cache would keep serving the old rows.
    const mgr = makeManager(
      decodedMeshBeaconConfig({
        flags: 2,
        broadcastTargets: [{ region: REGION_US, preset: PRESET_MEDIUM_SLOW }],
      }),
    );
    expect(readBack(mgr).broadcastTargets).toHaveLength(1);

    await mgr.setGenericModuleConfig('meshbeacon', transmitPayload({ broadcastTargets: [] }));
    expect(readBack(mgr).broadcastTargets).toEqual([]);
  });

  it('clears an optional target preset the user reset to "use running config"', async () => {
    const mgr = makeManager(
      decodedMeshBeaconConfig({
        flags: 2,
        broadcastTargets: [{ region: REGION_US, preset: PRESET_MEDIUM_SLOW }],
      }),
    );
    expect(readBack(mgr).broadcastTargets[0].preset).toBe(PRESET_MEDIUM_SLOW);

    await mgr.setGenericModuleConfig(
      'meshbeacon',
      transmitPayload({ broadcastTargets: [{ region: REGION_US }] }),
    );

    const target = readBack(mgr).broadcastTargets[0];
    expect(target.preset).toBeUndefined();
    expect(target.region).toBe(REGION_US);
  });

  it('leaves the cache alone when the send fails', async () => {
    const mgr = makeManager(decodedMeshBeaconConfig({ flags: 2 }));
    (mgr as any).sendLocalAdminPacket = vi.fn().mockRejectedValue(new Error('transmit disabled'));

    await expect(mgr.setGenericModuleConfig('meshbeacon', transmitPayload())).rejects.toThrow();
    expect(readBack(mgr).broadcastTargets).toEqual([]);
  });

  it('refreshes other module sections too, without disturbing their siblings', async () => {
    const mgr = makeManager({ serial: { enabled: false, baud: 0 }, telemetry: { deviceUpdateInterval: 900 } });
    await mgr.setGenericModuleConfig('serial', { enabled: true, baud: 5, echo: false });

    const wire = JSON.parse(JSON.stringify(mgr.getCurrentConfig())).moduleConfig;
    expect(wire.serial).toEqual({ enabled: true, baud: 5, echo: false });
    expect(wire.telemetry.deviceUpdateInterval).toBe(900);
  });
});

describe('MeshBeacon transmit fields on the wire (#5045, #5062)', () => {
  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  /**
   * Asserts the protocol, not our implementation: `BroadcastTarget.region` is a
   * plain proto3 enum (tag 2) and `BroadcastTarget.preset` is `optional` (tag 1),
   * so an explicit preset 0 must appear on the wire while an omitted one must
   * not — that is what lets the device tell "LONG_FAST" apart from "use the
   * running config".
   */
  function decodeSetModuleConfig(config: Record<string, unknown>): any {
    const encoded = protobufService.createSetModuleConfigMessageGeneric('meshbeacon', config, new Uint8Array());
    const AdminMessage = getProtobufRoot()!.lookupType('meshtastic.AdminMessage');
    return (AdminMessage.decode(encoded) as any).setModuleConfig.meshBeacon;
  }

  it('encodes an explicit LONG_FAST preset and a US region on a target', () => {
    const beacon = decodeSetModuleConfig(transmitPayload());
    const target = beacon.broadcastTargets[0];
    expect(target.region).toBe(REGION_US);
    expect(Object.prototype.hasOwnProperty.call(target, 'preset')).toBe(true);
    expect(target.preset).toBe(PRESET_LONG_FAST);
    expect(target.channelIndex).toBe(1);
  });

  it('omits the target preset entirely when the user chose "use running config"', () => {
    const beacon = decodeSetModuleConfig(
      transmitPayload({ broadcastTargets: [{ region: REGION_US }] }),
    );
    const target = beacon.broadcastTargets[0];
    expect(Object.prototype.hasOwnProperty.call(target, 'preset')).toBe(false);
    expect(target.region).toBe(REGION_US);
  });

  /**
   * The reason this whole issue exists: tags 3 and 8/9/10 are `reserved` now, so
   * protobufjs drops them at encode time and nanopb would skip them at decode
   * time — no error either side. Sending them is not a mistake the device
   * reports, so the guard has to live here.
   */
  it('drops the removed broadcast_on_* / send_as_node fields instead of encoding reserved tags', () => {
    const beacon = decodeSetModuleConfig(
      transmitPayload({
        broadcastSendAsNode: 42,
        broadcastOnRegion: REGION_US,
        broadcastOnPreset: PRESET_MEDIUM_SLOW,
        broadcastOnChannel: { name: 'gauntlet' },
      }),
    );
    expect(beacon.broadcastSendAsNode).toBeUndefined();
    expect(beacon.broadcastOnRegion).toBeUndefined();
    expect(beacon.broadcastOnPreset).toBeUndefined();
    expect(beacon.broadcastOnChannel).toBeUndefined();
    // The surviving fields still encode.
    expect(beacon.broadcastTargets[0].region).toBe(REGION_US);
  });
});
