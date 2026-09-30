/**
 * protobufs submodule bump past v2.8.0 (2026-09-30, protobufs 2542e06).
 *
 * Loads the REAL submodule .proto files (no mocks) and asserts:
 *  1. the loader resolves `google/protobuf/descriptor.proto`, which
 *     `field_metadata.proto` imports; without it the server fails at startup,
 *  2. the fields #5248 (AEAD channels) and #5279 (ack proof) build on decode,
 *  3. the soil/water chemistry fields left EnvironmentMetrics for their own
 *     SoilWaterMetrics message, with the old tags reserved.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import type protobuf from 'protobufjs';
import { loadProtobufDefinitions, resolveProtoImport } from './protobufLoader.js';

let root: protobuf.Root;

beforeAll(async () => {
  root = await loadProtobufDefinitions();
});

describe('resolveProtoImport', () => {
  const protoRoot = '/app/protobufs';
  const origin = '/app/protobufs/meshtastic/field_metadata.proto';

  it('resolves meshtastic/* against the submodule root', () => {
    expect(resolveProtoImport(protoRoot, origin, 'meshtastic/mesh.proto')).toBe(
      path.join(protoRoot, 'meshtastic/mesh.proto'),
    );
  });

  it('resolves google/protobuf/* to the copy protobufjs ships', () => {
    const resolved = resolveProtoImport(protoRoot, origin, 'google/protobuf/descriptor.proto');
    expect(resolved).toMatch(/protobufjs[\\/]google[\\/]protobuf[\\/]descriptor\.proto$/);
    expect(resolved.startsWith(protoRoot)).toBe(false);
  });

  it('resolves other imports relative to the importing file', () => {
    expect(resolveProtoImport(protoRoot, origin, 'nanopb.proto')).toBe('/app/protobufs/meshtastic/nanopb.proto');
  });
});

describe('protobufs past v2.8.0', () => {
  it('parses the field_metadata annotations', () => {
    const role = root.lookupType('meshtastic.Config.DeviceConfig').fields.role;
    expect(role.options?.['(meshtastic.field_metadata).label']).toBe('Device Role');
  });

  it('round-trips ChannelSettings.use_aead (tag 8, #5248)', () => {
    const CS = root.lookupType('meshtastic.ChannelSettings');
    expect(CS.fields.useAead.id).toBe(8);
    const decoded = CS.decode(CS.encode(CS.create({ name: 'x', useAead: true })).finish()) as unknown as { useAead: boolean };
    expect(decoded.useAead).toBe(true);
  });

  it('round-trips Routing.ack_proof and MeshPacket.ack_proof_status (#5279)', () => {
    const R = root.lookupType('meshtastic.Routing');
    const MP = root.lookupType('meshtastic.MeshPacket');
    expect(R.fields.ackProof.id).toBe(4);
    expect(MP.fields.ackProofStatus.id).toBe(23);
    const status = root.lookupEnum('meshtastic.MeshPacket.AckProofStatus').values;
    expect(status).toEqual({ ACK_PROOF_ABSENT: 0, ACK_PROOF_VALID: 1, ACK_PROOF_INVALID: 2, ACK_PROOF_NO_KEY: 3 });
    const pkt = MP.decode(MP.encode(MP.create({ id: 1, ackProofStatus: 1 })).finish()) as unknown as { ackProofStatus: number };
    expect(pkt.ackProofStatus).toBe(1);
  });

  it('moves soil/water chemistry into SoilWaterMetrics and reserves the old tags', () => {
    const env = root.lookupType('meshtastic.EnvironmentMetrics');
    expect(env.fields.soilPh).toBeUndefined();
    for (let tag = 42; tag <= 56; tag++) expect(env.isReservedId(tag)).toBe(true);
    expect(root.lookupType('meshtastic.Telemetry').fields.soilWaterMetrics.id).toBe(11);
  });
});
