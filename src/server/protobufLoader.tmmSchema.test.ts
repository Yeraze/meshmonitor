/**
 * TrafficManagementConfig — v2.8 schema (#5123) and the 2.8-preview pin
 * (#3548/#3854/#3923).
 *
 * Meshtastic protobufs commit d4f7ddb1 removed the nine TrafficManagementConfig
 * bool toggles plus `position_precision_bits` and reserved their tags, moving
 * the module to a "non-zero implies enabled" convention on the remaining uint32
 * knobs. MeshMonitor used to patch those fields back in at load time; that shim
 * is gone, because the Traffic Management UI is gated on
 * `supportsTrafficManagement()` (firmware 2.8.0+) — the exact firmware that
 * reserved the tags — so re-adding them could only ever put reserved bytes on
 * the wire.
 *
 * These tests load the REAL submodule .proto files (no mocks) and assert:
 *  1. the removed fields are absent and their tags stay reserved,
 *  2. the five retained knobs keep their upstream tags and uint32 type,
 *  3. a representative config encodes to the v2.8 wire bytes with nothing
 *     from a reserved tag,
 *  4. the 2.8-preview surface MeshMonitor is waiting on is actually present
 *     (MESH_BEACON_APP portnum, MeshBeacon message, MeshPacket.xeddsa_signed).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type protobuf from 'protobufjs';
import { loadProtobufDefinitions } from './protobufLoader.js';

let root: protobuf.Root;

beforeAll(async () => {
  root = await loadProtobufDefinitions();
});

describe('TrafficManagementConfig v2.8 schema', () => {
  const REMOVED_FIELDS = [
    'enabled',
    'positionDedupEnabled',
    'positionPrecisionBits',
    'nodeinfoDirectResponse',
    'rateLimitEnabled',
    'dropUnknownEnabled',
    'exhaustHopTelemetry',
    'exhaustHopPosition',
    'routerPreserveHops',
  ];
  const REMOVED_TAGS = [1, 2, 3, 5, 7, 10, 12, 13, 14];

  it('no longer carries the removed bool toggles or position_precision_bits', () => {
    const tmm = root.lookupType('meshtastic.ModuleConfig.TrafficManagementConfig');
    for (const name of REMOVED_FIELDS) {
      expect(tmm.fields[name], `field ${name} should be gone`).toBeUndefined();
    }
    for (const id of REMOVED_TAGS) {
      expect(tmm.fieldsById[id], `tag ${id} should stay reserved`).toBeUndefined();
    }
  });

  it('keeps the five retained knobs on their upstream tags as uint32', () => {
    const tmm = root.lookupType('meshtastic.ModuleConfig.TrafficManagementConfig');
    for (const [name, id] of [
      ['positionMinIntervalSecs', 4],
      ['nodeinfoDirectResponseMaxHops', 6],
      ['rateLimitWindowSecs', 8],
      ['rateLimitMaxPackets', 9],
      ['unknownPacketThreshold', 11],
    ] as Array<[string, number]>) {
      expect(tmm.fields[name]?.id, name).toBe(id);
      expect(tmm.fields[name]?.type, name).toBe('uint32');
    }
    // Exactly five fields — nothing patched back in behind our backs.
    expect(Object.keys(tmm.fields).sort()).toEqual([
      'nodeinfoDirectResponseMaxHops',
      'positionMinIntervalSecs',
      'rateLimitMaxPackets',
      'rateLimitWindowSecs',
      'unknownPacketThreshold',
    ]);
  });

  it('encodes a representative config to v2.8 wire bytes with no reserved tags', () => {
    const tmm = root.lookupType('meshtastic.ModuleConfig.TrafficManagementConfig');
    const bytes = tmm.encode(tmm.create({
      positionMinIntervalSecs: 300,
      nodeinfoDirectResponseMaxHops: 3,
      rateLimitWindowSecs: 60,
      rateLimitMaxPackets: 20,
      unknownPacketThreshold: 5,
    })).finish();
    // proto3 varints, ascending tags:
    //   tag 4 (position_min_interval_secs)        -> 0x20 0xac 0x02
    //   tag 6 (nodeinfo_direct_response_max_hops) -> 0x30 0x03
    //   tag 8 (rate_limit_window_secs)            -> 0x40 0x3c
    //   tag 9 (rate_limit_max_packets)            -> 0x48 0x14
    //   tag 11 (unknown_packet_threshold)         -> 0x58 0x05
    expect(Array.from(bytes)).toEqual([
      0x20, 0xac, 0x02,
      0x30, 0x03,
      0x40, 0x3c,
      0x48, 0x14,
      0x58, 0x05,
    ]);
  });

  it('omits a knob entirely when it is 0 (0 is how the device reads "disabled")', () => {
    const tmm = root.lookupType('meshtastic.ModuleConfig.TrafficManagementConfig');
    const bytes = tmm.encode(tmm.create({
      positionMinIntervalSecs: 0,
      nodeinfoDirectResponseMaxHops: 0,
      rateLimitWindowSecs: 0,
      rateLimitMaxPackets: 0,
      unknownPacketThreshold: 0,
    })).finish();
    expect(Array.from(bytes)).toEqual([]);
  });

  it('decodes a v2.8 device payload back to the numeric knobs', () => {
    const tmm = root.lookupType('meshtastic.ModuleConfig.TrafficManagementConfig');
    const deviceBytes = Uint8Array.from([0x20, 0xac, 0x02, 0x40, 0x3c, 0x48, 0x14]);
    const decoded = tmm.toObject(tmm.decode(deviceBytes)) as Record<string, unknown>;
    expect(decoded.positionMinIntervalSecs).toBe(300);
    expect(decoded.rateLimitWindowSecs).toBe(60);
    expect(decoded.rateLimitMaxPackets).toBe(20);
  });
});

describe('2.8-preview surface (what the pin is for)', () => {
  it('PortNum carries MESH_BEACON_APP = 37', () => {
    const portNum = root.lookupEnum('meshtastic.PortNum');
    expect(portNum.values.MESH_BEACON_APP).toBe(37);
  });

  it('MeshBeacon message type is loaded', () => {
    expect(() => root.lookupType('meshtastic.MeshBeacon')).not.toThrow();
  });

  it('MeshBeaconConfig module config exists', () => {
    expect(() => root.lookupType('meshtastic.ModuleConfig.MeshBeaconConfig')).not.toThrow();
  });

  it('MeshPacket carries the XEdDSA signed flag (tag 22)', () => {
    const meshPacket = root.lookupType('meshtastic.MeshPacket');
    expect(meshPacket.fields.xeddsaSigned?.id).toBe(22);
  });
});
