/**
 * #5231 — MQTT NodeInfo ingest must not report "no value" as a value.
 *
 * protobuf.js decodes an unset `bytes` field to an EMPTY buffer, which is
 * truthy. The ingest path used to encode that to `publicKey: ''` and
 * `macaddr: ''`, and `upsertNode` merges publicKey with `??` — which does not
 * catch `''`. Every keyless NodeInfo packet therefore wiped the public key a
 * user had just filled in through NodeInfo Enrichment, and the report offered
 * the identical copy again on the next refresh.
 *
 * The same applies to the all-zero MAC: `User.macaddr` was deprecated in
 * firmware 2.1.x, so many nodes broadcast six zero bytes, which hex-encoded to
 * '000000000000' and overwrote a real MAC.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const nodeInfoPayload = { value: {} as Record<string, any> };

vi.mock('../services/database.js', () => ({
  default: {
    upsertNodeAsync: vi.fn(async () => undefined),
    nodes: {
      getNode: vi.fn(async () => null),
      getNodesByNums: vi.fn(async () => new Map()),
      upsertNode: vi.fn(async () => undefined),
    },
    messages: { getMessage: vi.fn(async () => null), insertMessage: vi.fn(async () => true) },
    channels: { upsertChannel: vi.fn(async () => undefined) },
    channelDatabase: {
      findOrCreatePassiveByNameAsync: vi.fn(async () => undefined),
      findOrCreateByNameAndHashAsync: vi.fn(async () => undefined),
    },
    ignoredNodes: {
      isIgnoredCached: vi.fn(() => false),
      addGeoIgnoreAsync: vi.fn(async () => true),
      liftGeoIgnoreAsync: vi.fn(async () => true),
    },
    settings: { getSettingForSource: vi.fn(async () => null) },
  },
}));

vi.mock('./meshtasticProtobufService.js', () => ({
  default: {
    processPayload: vi.fn(() => nodeInfoPayload.value),
  },
}));

import { ingestServiceEnvelope } from './mqttIngestion.js';
import databaseService from '../services/database.js';
import type { ServiceEnvelopeShape } from './mqttPacketFilter.js';

const NODE = 0x9e80e848;

const envelope: ServiceEnvelopeShape = {
  channelId: 'LongFast',
  gatewayId: '!00000001',
  packet: {
    id: 0x12345678,
    from: NODE,
    to: 0xffffffff,
    channel: 0,
    decoded: { portnum: 4 /* NODEINFO_APP */, payload: new Uint8Array([0]) },
  },
};

async function ingest(user: Record<string, any>) {
  nodeInfoPayload.value = user;
  const result = await ingestServiceEnvelope({ sourceId: 'mqtt-1', envelope });
  expect(result.ingested).toBe(true);
  return (databaseService.upsertNodeAsync as any).mock.calls.at(-1)?.[0];
}

describe('MQTT NodeInfo ingest — blank public key (#5231)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('omits publicKey when the field decodes to an empty buffer', async () => {
    // This is what protobuf.js hands back for an unset `public_key`.
    const node = await ingest({
      longName: 'SKYC',
      shortName: 'SKYC',
      publicKey: new Uint8Array(0),
    });
    expect(node.publicKey).toBeUndefined();
  });

  it('omits publicKey for the snake_case spelling too', async () => {
    const node = await ingest({ longName: 'SKYC', public_key: new Uint8Array(0) });
    expect(node.publicKey).toBeUndefined();
  });

  it('still carries a real public key through, base64-encoded', async () => {
    const key = new Uint8Array([0xeb, 0xd4, 0x63, 0x06, 0x20, 0x12, 0x11, 0xff]);
    const node = await ingest({ longName: 'SKYC', publicKey: key });
    expect(node.publicKey).toBe(Buffer.from(key).toString('base64'));
  });
});

describe('MQTT NodeInfo ingest — blank MAC address (#5231)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('omits macaddr when the field decodes to an empty buffer', async () => {
    const node = await ingest({ longName: 'SKYB', macaddr: new Uint8Array(0) });
    expect(node.macaddr).toBeUndefined();
  });

  it('omits the deprecated all-zero macaddr instead of storing 000000000000', async () => {
    const node = await ingest({ longName: 'SKYB', macaddr: new Uint8Array([0, 0, 0, 0, 0, 0]) });
    expect(node.macaddr).toBeUndefined();
  });

  it('still carries a real MAC through, hex-encoded', async () => {
    const node = await ingest({
      longName: 'SKYB',
      macaddr: new Uint8Array([0xc4, 0xd2, 0x66, 0xf1, 0xc3, 0x1d]),
    });
    expect(node.macaddr).toBe('c4d266f1c31d');
  });
});
