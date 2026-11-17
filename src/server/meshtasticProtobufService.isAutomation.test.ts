/**
 * is_automation bit (#6449, meshtastic/protobufs#1134): every client-built
 * packet an automation sends sets Data.bitfield bit 2 (0x04). A manual send
 * leaves `bitfield` absent, so its wire bytes are unchanged.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../services/database.js', () => ({ default: {} }));

import meshtasticProtobufService from './meshtasticProtobufService.js';
import { loadProtobufDefinitions, getProtobufRoot } from './protobufLoader.js';
import { DATA_BITFIELD_IS_AUTOMATION, readIsAutomationBit } from './constants/meshtastic.js';

const DEST = 0x1234abcd;
const WP = { id: 42, latitude: 30, longitude: -90, expire: 0, name: 'Port' };

/** The decoded Data's bitfield, or null when absent on the wire. */
function bitfieldOf(data: Uint8Array): number | null {
  const ToRadio = getProtobufRoot()!.lookupType('meshtastic.ToRadio');
  const decoded = ToRadio.decode(data) as unknown as { packet: { decoded: { bitfield?: number | null } } };
  const bf = decoded.packet.decoded.bitfield;
  return typeof bf === 'number' ? bf : null;
}

const builders: Array<[string, (isAutomation: boolean) => Uint8Array]> = [
  ['text', (a) => meshtasticProtobufService.createTextMessage('hi', DEST, 0, undefined, undefined, false, undefined, a).data],
  ['traceroute', (a) => meshtasticProtobufService.createTracerouteMessage(DEST, 0, 3, undefined, a)],
  ['position', (a) => meshtasticProtobufService.createPositionRequestMessage(DEST, 0, 3, a).data],
  ['nodeinfo', (a) => meshtasticProtobufService.createNodeInfoRequestMessage(DEST, 0, undefined, 3, a).data],
  ['neighborinfo', (a) => meshtasticProtobufService.createNeighborInfoRequestMessage(DEST, 0, 3, a).data],
  ['telemetry', (a) => meshtasticProtobufService.createTelemetryRequestMessage(DEST, 0, 'device', 3, a).data],
  ['localStats', (a) => meshtasticProtobufService.createTelemetryRequestMessage(DEST, 0, 'localStats', 3, a).data],
  ['waypoint', (a) => meshtasticProtobufService.createWaypointMessage(WP, { isAutomation: a }).data],
];

describe('Data.bitfield is_automation bit (#6449)', () => {
  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  it('uses bit 2 (0x04)', () => {
    expect(DATA_BITFIELD_IS_AUTOMATION).toBe(0x04);
  });

  it.each(builders)('%s: an automation send sets bit 2', (_name, build) => {
    expect(bitfieldOf(build(true))).toBe(DATA_BITFIELD_IS_AUTOMATION);
  });

  it.each(builders)('%s: a manual send leaves the bitfield absent', (_name, build) => {
    expect(bitfieldOf(build(false))).toBeNull();
  });

  it('defaults to manual when the caller passes nothing', () => {
    const { data } = meshtasticProtobufService.createTextMessage('hi', DEST, 0);
    expect(bitfieldOf(data)).toBeNull();
  });
});

describe('readIsAutomationBit', () => {
  it('returns null when the bitfield is absent', () => {
    expect(readIsAutomationBit(undefined)).toBeNull();
    expect(readIsAutomationBit(null)).toBeNull();
  });

  it('returns false for a present bitfield with bit 2 clear, including 0', () => {
    expect(readIsAutomationBit(0)).toBe(false);
    expect(readIsAutomationBit(0x03)).toBe(false);
  });

  it('returns true when bit 2 is set, whatever the firmware ORed in', () => {
    expect(readIsAutomationBit(0x04)).toBe(true);
    expect(readIsAutomationBit(0x07)).toBe(true);
  });
});

describe('createFromRadioTextMessage carries is_automation to Virtual Node clients (#6449)', () => {
  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  async function replayBitfield(isAutomation: boolean | null | undefined): Promise<number | null> {
    const bytes = await meshtasticProtobufService.createFromRadioTextMessage({
      fromNodeNum: DEST, toNodeNum: 0xffffffff, text: 'hi', channel: 0, timestamp: Date.now(), isAutomation,
    });
    const FromRadio = getProtobufRoot()!.lookupType('meshtastic.FromRadio');
    const decoded = FromRadio.decode(bytes!) as unknown as { packet: { decoded: { bitfield?: number | null } } };
    const bf = decoded.packet.decoded.bitfield;
    return typeof bf === 'number' ? bf : null;
  }

  it('sets bit 2 for a stored automation message', async () => {
    expect(await replayBitfield(true)).toBe(DATA_BITFIELD_IS_AUTOMATION);
  });

  it('leaves the bitfield absent for human or unknown messages', async () => {
    expect(await replayBitfield(false)).toBeNull();
    expect(await replayBitfield(null)).toBeNull();
    expect(await replayBitfield(undefined)).toBeNull();
  });
});
