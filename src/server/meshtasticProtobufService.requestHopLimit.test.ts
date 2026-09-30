/**
 * Position, NodeInfo, NeighborInfo and telemetry requests carry the hop limit the caller
 * passes (the node's configured LoRa hop limit), instead of the old hardcoded
 * 3 / 3 / 7 / 3. Same policy as waypoint sends (#5482).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import meshtasticProtobufService from './meshtasticProtobufService.js';
import { loadProtobufDefinitions, getProtobufRoot } from './protobufLoader.js';
import { DEFAULT_HOP_LIMIT } from './constants/meshtastic.js';

const DEST = 0x1234abcd;

function hopLimitOf(data: Uint8Array): number {
  const ToRadio = getProtobufRoot()!.lookupType('meshtastic.ToRadio');
  return (ToRadio.decode(data) as any).packet.hopLimit;
}

const builders: Array<[string, (hop?: number) => Uint8Array]> = [
  ['position', (hop) => meshtasticProtobufService.createPositionRequestMessage(DEST, 0, undefined, hop).data],
  ['nodeinfo', (hop) => meshtasticProtobufService.createNodeInfoRequestMessage(DEST, 0, undefined, hop).data],
  ['neighborinfo', (hop) => meshtasticProtobufService.createNeighborInfoRequestMessage(DEST, 0, hop).data],
  ['telemetry', (hop) => meshtasticProtobufService.createTelemetryRequestMessage(DEST, 0, 'device', hop).data],
];

describe('request messages use the passed hop limit', () => {
  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  it.each(builders)('%s request carries the configured hop limit', (_name, build) => {
    expect(hopLimitOf(build(6))).toBe(6);
    expect(hopLimitOf(build(1))).toBe(1);
  });

  it.each(builders)('%s request falls back to the firmware default when none is passed', (_name, build) => {
    expect(hopLimitOf(build())).toBe(DEFAULT_HOP_LIMIT);
  });

  it.each(builders)('%s request clamps an out-of-range value', (_name, build) => {
    expect(hopLimitOf(build(12))).toBeLessThanOrEqual(7);
  });
});
