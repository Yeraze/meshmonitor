/**
 * 2.8-preview protobuf pin — compatibility guarantees (#3548/#3854/#3923)
 *
 * The protobufs submodule is pinned to develop@ba16bfc (a 2.8 preview, ahead
 * of v2.7.26) so MeshBeacon / XEdDSA work can start before the stable tag.
 * Upstream removed the v2.7.x TrafficManagementConfig bool-toggle fields in
 * that range; protobufLoader re-adds them at load time so encode/decode for
 * Traffic Management stays byte-for-byte v2.7.26-compatible for shipping
 * 2.7-alpha firmware.
 *
 * These tests load the REAL submodule .proto files (no mocks) and assert:
 *  1. the legacy TMM fields exist with their original tags and types,
 *  2. the wire bytes for a representative TM config are exactly what the
 *     v2.7.26 schema produced (proto3 varint encoding, ascending tags),
 *  3. round-trip decode restores the toggle state a 2.7 device reports,
 *  4. the 2.8-preview surface MeshMonitor is waiting on is actually present
 *     (MESH_BEACON_APP portnum, MeshBeacon message, MeshPacket.xeddsa_signed).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type protobuf from 'protobufjs';
import { loadProtobufDefinitions, restoreLegacyTrafficManagementFields } from './protobufLoader.js';

let root: protobuf.Root;

beforeAll(async () => {
  root = await loadProtobufDefinitions();
});

describe('TrafficManagementConfig 2.7 compat patch', () => {
  const LEGACY_FIELDS: Array<[name: string, id: number, type: string]> = [
    ['enabled', 1, 'bool'],
    ['positionDedupEnabled', 2, 'bool'],
    ['positionPrecisionBits', 3, 'uint32'],
    ['nodeinfoDirectResponse', 5, 'bool'],
    ['rateLimitEnabled', 7, 'bool'],
    ['dropUnknownEnabled', 10, 'bool'],
    ['exhaustHopTelemetry', 12, 'bool'],
    ['exhaustHopPosition', 13, 'bool'],
    ['routerPreserveHops', 14, 'bool'],
  ];

  it('restores every removed v2.7.26 field with its original tag and type', () => {
    const tmm = root.lookupType('meshtastic.ModuleConfig.TrafficManagementConfig');
    for (const [name, id, type] of LEGACY_FIELDS) {
      const field = tmm.fields[name];
      expect(field, `field ${name} missing`).toBeDefined();
      expect(field.id, `field ${name} tag`).toBe(id);
      expect(field.type, `field ${name} type`).toBe(type);
    }
  });

  it('keeps the fields upstream retained (numeric knobs) untouched', () => {
    const tmm = root.lookupType('meshtastic.ModuleConfig.TrafficManagementConfig');
    for (const [name, id] of [
      ['positionMinIntervalSecs', 4],
      ['nodeinfoDirectResponseMaxHops', 6],
      ['rateLimitWindowSecs', 8],
      ['rateLimitMaxPackets', 9],
      ['unknownPacketThreshold', 11],
    ] as Array<[string, number]>) {
      expect(tmm.fields[name]?.id, name).toBe(id);
    }
  });

  it('encodes a representative TM config to the exact v2.7.26 wire bytes', () => {
    const tmm = root.lookupType('meshtastic.ModuleConfig.TrafficManagementConfig');
    const bytes = tmm.encode(tmm.create({
      enabled: true,
      positionDedupEnabled: true,
      positionPrecisionBits: 13,
      rateLimitEnabled: true,
      rateLimitWindowSecs: 60,
    })).finish();
    // v2.7.26 wire form (proto3 varints, ascending tags):
    //   tag 1 (enabled)               -> 0x08 0x01
    //   tag 2 (position_dedup_enabled)-> 0x10 0x01
    //   tag 3 (position_precision_bits)-> 0x18 0x0d
    //   tag 7 (rate_limit_enabled)    -> 0x38 0x01
    //   tag 8 (rate_limit_window_secs)-> 0x40 0x3c
    expect(Array.from(bytes)).toEqual([
      0x08, 0x01,
      0x10, 0x01,
      0x18, 0x0d,
      0x38, 0x01,
      0x40, 0x3c,
    ]);
  });

  it('decodes 2.7-firmware wire bytes back to the toggle state (no field loss)', () => {
    const tmm = root.lookupType('meshtastic.ModuleConfig.TrafficManagementConfig');
    // What a 2.7-alpha device reports for an enabled module with
    // position_precision_bits=13 (tag 3 -> 0x18 0x0d, the only non-bool
    // restored field), exhaust_hop_position (tag 13 -> 0x68), and
    // router_preserve_hops (tag 14 -> 0x70).
    const deviceBytes = Uint8Array.from([0x08, 0x01, 0x18, 0x0d, 0x68, 0x01, 0x70, 0x01]);
    const decoded = tmm.toObject(tmm.decode(deviceBytes)) as Record<string, unknown>;
    expect(decoded.enabled).toBe(true);
    expect(decoded.positionPrecisionBits).toBe(13);
    expect(decoded.exhaustHopPosition).toBe(true);
    expect(decoded.routerPreserveHops).toBe(true);
  });

  it('is idempotent — re-running the patch neither throws nor duplicates fields', () => {
    const tmm = root.lookupType('meshtastic.ModuleConfig.TrafficManagementConfig');
    const fieldCountBefore = Object.keys(tmm.fields).length;
    expect(() => restoreLegacyTrafficManagementFields(root)).not.toThrow();
    expect(Object.keys(tmm.fields).length).toBe(fieldCountBefore);
    // The restored fields are still intact after the second pass.
    expect(tmm.fields.enabled?.id).toBe(1);
    expect(tmm.fields.routerPreserveHops?.id).toBe(14);
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
