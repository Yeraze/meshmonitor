import { describe, it, expect, beforeAll, vi } from 'vitest';

/**
 * Regression tests for issue #5030 — MeshBeacon broadcast targets lost their
 * preset and region on every reload.
 *
 * `broadcast_targets` is the only *repeated message* field the config API
 * returns. Every other sub-message in `getCurrentConfig()` is spread into a
 * plain object (which incidentally turns its enums into numbers), so the target
 * entries stayed protobufjs `Message` instances. `res.json()` then serialized
 * them via protobufjs's own `Message.toJSON()`, which uses `enums: String` —
 * the UI received `{ preset: "MEDIUM_SLOW", region: "US" }`, matched no
 * `<option>` value, and rendered every target as "Running config" / "UNSET".
 *
 * These tests go through a real decoded protobuf message and assert the values
 * survive a JSON round-trip as numbers.
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

import { MeshtasticManager, normalizeBroadcastTargets } from './meshtasticManager.js';
import { loadProtobufDefinitions, getProtobufRoot } from './protobufLoader.js';

/** RegionCode.US and the two presets used below, as their wire values. */
const REGION_US = 1;
const PRESET_LONG_FAST = 0;
const PRESET_MEDIUM_SLOW = 3;

/**
 * Build the exact object shape `processConfig` stores in `actualModuleConfig`:
 * a decoded `ModuleConfig.meshBeacon` message, whose repeated targets are
 * themselves message instances.
 */
function decodedMeshBeaconConfig(meshBeacon: Record<string, unknown>): any {
  const ModuleConfig = getProtobufRoot()!.lookupType('meshtastic.ModuleConfig');
  const encoded = ModuleConfig.encode(ModuleConfig.create({ meshBeacon })).finish();
  const decoded = ModuleConfig.decode(encoded) as any;
  // Mirrors `this.actualModuleConfig = { ...this.actualModuleConfig, ...parsed.data }`
  return { ...decoded };
}

function makeManager(moduleConfig: any) {
  const mgr = new MeshtasticManager('src-1', { host: '127.0.0.1', port: 4403 });
  (mgr as any).localNodeInfo = { nodeNum: 123, nodeId: '!0000007b', firmwareVersion: '2.8.0' };
  (mgr as any).actualModuleConfig = moduleConfig;
  return mgr;
}

describe('normalizeBroadcastTargets (#5030)', () => {
  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  it('keeps preset and region as numbers, not enum names', () => {
    const targets = normalizeBroadcastTargets([
      { preset: PRESET_MEDIUM_SLOW, region: REGION_US, channelIndex: 2 },
    ]);
    expect(targets).toEqual([{ preset: PRESET_MEDIUM_SLOW, region: REGION_US, channelIndex: 2 }]);
  });

  it('omits an absent optional preset instead of collapsing it to LONG_FAST', () => {
    // On a decoded message an unset `optional preset` reads 0 off the prototype,
    // so presence has to come from the own-property check, not the value.
    const decoded = decodedMeshBeaconConfig({ broadcastTargets: [{ region: REGION_US }] });
    const targets = normalizeBroadcastTargets(decoded.meshBeacon.broadcastTargets);
    expect(targets).toEqual([{ region: REGION_US }]);
    expect('preset' in targets[0]).toBe(false);
    expect('channelIndex' in targets[0]).toBe(false);
  });

  it('preserves an explicit preset 0 (LONG_FAST), which is not the same as absent', () => {
    const decoded = decodedMeshBeaconConfig({
      broadcastTargets: [{ preset: PRESET_LONG_FAST, region: REGION_US, channelIndex: 0 }],
    });
    const targets = normalizeBroadcastTargets(decoded.meshBeacon.broadcastTargets);
    expect(targets).toEqual([{ preset: PRESET_LONG_FAST, region: REGION_US, channelIndex: 0 }]);
  });

  it('returns an empty list for an absent or non-array value', () => {
    expect(normalizeBroadcastTargets(undefined)).toEqual([]);
    expect(normalizeBroadcastTargets(null)).toEqual([]);
    expect(normalizeBroadcastTargets({} as unknown)).toEqual([]);
  });
});

describe('getCurrentConfig — MeshBeacon broadcast targets survive JSON serialization (#5030)', () => {
  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  it('serializes target preset/region as numbers over the wire', () => {
    const mgr = makeManager(
      decodedMeshBeaconConfig({
        flags: 2,
        broadcastOfferRegion: REGION_US,
        broadcastOnRegion: REGION_US,
        broadcastIntervalSecs: 3600,
        broadcastTargets: [
          { preset: PRESET_MEDIUM_SLOW, region: REGION_US },
          { preset: PRESET_LONG_FAST, region: REGION_US, channelIndex: 1 },
        ],
      }),
    );

    // The route does `res.json(config)`, so the round-trip — not the in-process
    // object — is what the UI actually parses.
    const wire = JSON.parse(JSON.stringify(mgr.getCurrentConfig()));
    const targets = wire.moduleConfig.meshBeacon.broadcastTargets;

    expect(targets).toEqual([
      { preset: PRESET_MEDIUM_SLOW, region: REGION_US },
      { preset: PRESET_LONG_FAST, region: REGION_US, channelIndex: 1 },
    ]);
    expect(typeof targets[0].preset).toBe('number');
    expect(typeof targets[0].region).toBe('number');
  });

  it('returns an empty target list when the device sent none', () => {
    const mgr = makeManager(decodedMeshBeaconConfig({ flags: 2 }));
    const wire = JSON.parse(JSON.stringify(mgr.getCurrentConfig()));
    expect(wire.moduleConfig.meshBeacon.broadcastTargets).toEqual([]);
  });
});
