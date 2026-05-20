/**
 * Ingestion-level tests for the fail-closed geo membership check.
 *
 * These complement the unit tests in `mqttPacketFilter.test.ts` by
 * proving the wiring through `ingestServiceEnvelope` — i.e. that
 * non-position packets actually short-circuit before touching the
 * database when the bbox is enabled.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/database.js', () => ({
  default: {
    upsertNode: vi.fn(),
    insertMessage: vi.fn(),
    insertTelemetry: vi.fn(),
    insertTraceroute: vi.fn(),
    insertRouteSegment: vi.fn(),
    nodes: {
      getNode: vi.fn(async () => null),
      getNodesByNums: vi.fn(async () => new Map()),
      upsertNode: vi.fn(async () => undefined),
    },
    neighbors: {
      deleteNeighborInfoForNode: vi.fn(async () => undefined),
      insertNeighborInfoBatch: vi.fn(async () => undefined),
    },
    messages: {
      getMessage: vi.fn(async () => null),
      insertMessage: vi.fn((_msg: any, _sourceId?: string) => true),
    },
    channels: {
      upsertChannel: vi.fn(async () => undefined),
    },
    channelDatabase: {
      // Returns undefined by default so the resolver falls back to the raw
      // slot — keeps every pre-existing test seeing the same channel values
      // it asserted under the old behavior. Tests that want to exercise
      // the channel_database-keyed path override the mock per-case.
      findOrCreatePassiveByNameAsync: vi.fn(async () => undefined),
    },
  },
}));

vi.mock('./meshtasticProtobufService.js', () => ({
  default: {
    processPayload: vi.fn((portnum: number, _payload: Uint8Array) => {
      // Minimal payloads for the portnums the tests exercise.
      if (portnum === 4 /* NODEINFO_APP */) {
        return { longName: 'Test', shortName: 'TST', hwModel: 1 };
      }
      if (portnum === 3 /* POSITION_APP */) {
        return { latitudeI: 437_000_000, longitudeI: -793_000_000, altitude: 100 };
      }
      if (portnum === 1 /* TEXT_MESSAGE_APP */) {
        return 'hello';
      }
      if (portnum === 67 /* TELEMETRY_APP */) {
        return { deviceMetrics: { batteryLevel: 90 } };
      }
      if (portnum === 70 /* TRACEROUTE_APP */) {
        return { route: [], routeBack: [], snrTowards: [40], snrBack: [] };
      }
      if (portnum === 71 /* NEIGHBORINFO_APP */) {
        return { neighbors: [{ nodeId: 0xaaaa1111, snr: 4.5, lastRxTime: 1700000000 }] };
      }
      if (portnum === 34 /* PAXCOUNTER_APP */) {
        return { wifi: 12, ble: 5, uptime: 360 };
      }
      if (portnum === 65 /* STORE_FORWARD_APP */) {
        return { rr: 9 /* ROUTER_TEXT_BROADCAST */, text: new TextEncoder().encode('replayed') };
      }
      return null;
    }),
  },
}));

import { ingestServiceEnvelope, _resetMqttIngestCachesForTest } from './mqttIngestion.js';
import { MqttPacketFilter, type ServiceEnvelopeShape } from './mqttPacketFilter.js';
import databaseService from '../services/database.js';
import { CHANNEL_DB_OFFSET } from './constants/meshtastic.js';

const NODE_IN = 0x7ff80a48;
const NODE_OUT = 0x11111111;
const NODE_UNKNOWN = 0x22222222;
const ON_BBOX = { minLat: 43, maxLat: 45, minLng: -80, maxLng: -77 };

function envFor(from: number, portnum: number): ServiceEnvelopeShape {
  return {
    channelId: 'LongFast',
    gatewayId: '!00000001',
    packet: {
      id: 0x12345678,
      from,
      to: 0xffffffff,
      channel: 0,
      decoded: { portnum, payload: new Uint8Array([0]) },
    },
  };
}

describe('ingestServiceEnvelope — fail-closed membership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('drops a TEXT_MESSAGE from an unknown sender when bbox is enabled', async () => {
    const filter = new MqttPacketFilter({ geo: ON_BBOX });
    const result = await ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor(NODE_UNKNOWN, 1 /* TEXT_MESSAGE_APP */),
      filter,
    });
    expect(result.ingested).toBe(false);
    expect(result.reason).toBe('geo-filtered');
    expect(databaseService.messages.insertMessage).not.toHaveBeenCalled();
    expect(databaseService.upsertNode).not.toHaveBeenCalled();
    expect(filter.getDropCounters().geo).toBe(1);
  });

  it('drops NODEINFO from an unknown sender when bbox is enabled', async () => {
    const filter = new MqttPacketFilter({ geo: ON_BBOX });
    const result = await ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor(NODE_UNKNOWN, 4 /* NODEINFO_APP */),
      filter,
    });
    expect(result.ingested).toBe(false);
    expect(result.reason).toBe('geo-filtered');
    expect(databaseService.upsertNode).not.toHaveBeenCalled();
  });

  it('drops TELEMETRY from an unknown sender when bbox is enabled', async () => {
    const filter = new MqttPacketFilter({ geo: ON_BBOX });
    const result = await ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor(NODE_UNKNOWN, 67 /* TELEMETRY_APP */),
      filter,
    });
    expect(result.ingested).toBe(false);
    expect(result.reason).toBe('geo-filtered');
    expect(databaseService.insertTelemetry).not.toHaveBeenCalled();
  });

  it('allows a TEXT_MESSAGE after the same sender posted an in-bbox POSITION', async () => {
    const filter = new MqttPacketFilter({ geo: ON_BBOX });

    // Step 1: position learns NODE_IN as 'in'.
    const posResult = await ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor(NODE_IN, 3 /* POSITION_APP */),
      filter,
    });
    expect(posResult.ingested).toBe(true);
    expect(filter.getMembershipSize()).toBe(1);

    // Step 2: text message from the same sender now passes the gate.
    vi.clearAllMocks();
    const txtResult = await ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor(NODE_IN, 1 /* TEXT_MESSAGE_APP */),
      filter,
    });
    expect(txtResult.ingested).toBe(true);
    expect(databaseService.messages.insertMessage).toHaveBeenCalledTimes(1);
  });

  it('blocks TEXT_MESSAGE after the same sender posted an out-of-bbox POSITION', async () => {
    // Override processPayload for this test to return an out-of-bbox position.
    const { default: protobuf } = await import('./meshtasticProtobufService.js');
    (protobuf.processPayload as any).mockImplementationOnce(() => ({
      latitudeI: 492_000_000, // Vancouver — outside ON_BBOX
      longitudeI: -1_230_000_000,
    }));

    const filter = new MqttPacketFilter({ geo: ON_BBOX });

    // Position is out → bbox rejects, cache marks NODE_OUT as 'out'.
    const posResult = await ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor(NODE_OUT, 3 /* POSITION_APP */),
      filter,
    });
    expect(posResult.ingested).toBe(false);
    expect(posResult.reason).toBe('geo-filtered');

    // Subsequent text from the same sender — known-out → drop.
    const txtResult = await ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor(NODE_OUT, 1 /* TEXT_MESSAGE_APP */),
      filter,
    });
    expect(txtResult.ingested).toBe(false);
    expect(txtResult.reason).toBe('geo-filtered');
    expect(databaseService.messages.insertMessage).not.toHaveBeenCalled();
  });

  it('passes everything when no filter is supplied (back-compat)', async () => {
    const result = await ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor(NODE_UNKNOWN, 1 /* TEXT_MESSAGE_APP */),
      // No filter argument → no fail-closed enforcement.
    });
    expect(result.ingested).toBe(true);
    expect(databaseService.messages.insertMessage).toHaveBeenCalledTimes(1);
  });

  it('passes non-position packets when bbox is configured with empty bounds', async () => {
    const filter = new MqttPacketFilter({ geo: {} });
    const result = await ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor(NODE_UNKNOWN, 1 /* TEXT_MESSAGE_APP */),
      filter,
    });
    expect(result.ingested).toBe(true);
    expect(filter.getDropCounters().geo).toBe(0);
  });
});

describe('ingestServiceEnvelope — TEXT_MESSAGE_APP tapbacks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserves emoji and replyId from the decoded Data protobuf', async () => {
    // Regression: prior to the fix, the TEXT_MESSAGE_APP branch built a
    // DbMessage that dropped emoji/replyId, so MQTT-sourced reactions
    // failed `isReactionMessage` in the unified view and rendered as
    // full inline messages instead of grouping under the parent packet.
    const envelope: ServiceEnvelopeShape = {
      channelId: 'LongFast',
      gatewayId: '!00000001',
      packet: {
        id: 0xdeadbeef,
        from: NODE_IN,
        to: 0xffffffff,
        channel: 0,
        decoded: {
          portnum: 1 /* TEXT_MESSAGE_APP */,
          payload: new Uint8Array([0]),
          emoji: 1,
          replyId: 12345,
        } as any,
      },
    };

    const result = await ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope,
    });

    expect(result.ingested).toBe(true);
    expect(databaseService.messages.insertMessage).toHaveBeenCalledTimes(1);
    const inserted = (databaseService.messages.insertMessage as any).mock.calls[0][0];
    expect(inserted.emoji).toBe(1);
    expect(inserted.replyId).toBe(12345);
  });

  it('accepts snake_case reply_id from a gateway that did not camelCase the field', async () => {
    // Some MQTT bridges publish the raw protobuf field name `reply_id`
    // rather than the protobufjs camelCase `replyId`. Accept both.
    const envelope: ServiceEnvelopeShape = {
      channelId: 'LongFast',
      gatewayId: '!00000001',
      packet: {
        id: 0xdeadbeef,
        from: NODE_IN,
        to: 0xffffffff,
        channel: 0,
        decoded: {
          portnum: 1 /* TEXT_MESSAGE_APP */,
          payload: new Uint8Array([0]),
          emoji: 1,
          reply_id: 99,
        } as any,
      },
    };

    const result = await ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope,
    });

    expect(result.ingested).toBe(true);
    const inserted = (databaseService.messages.insertMessage as any).mock.calls[0][0];
    expect(inserted.replyId).toBe(99);
  });

  it('omits emoji/replyId when the decoded packet has neither', async () => {
    // Regular text messages must not be marked as reactions.
    const result = await ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor(NODE_IN, 1 /* TEXT_MESSAGE_APP */),
    });

    expect(result.ingested).toBe(true);
    const inserted = (databaseService.messages.insertMessage as any).mock.calls[0][0];
    expect(inserted.emoji).toBeUndefined();
    expect(inserted.replyId).toBeUndefined();
  });
});

describe('ingestServiceEnvelope — TRACEROUTE_APP', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists the traceroute record and a messageHops telemetry datum', async () => {
    const result = await ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor(NODE_IN, 70 /* TRACEROUTE_APP */),
    });
    expect(result.ingested).toBe(true);
    expect(databaseService.insertTraceroute).toHaveBeenCalledTimes(1);
    const [record, sourceId] = (databaseService.insertTraceroute as any).mock.calls[0];
    expect(record.fromNodeNum).toBe(NODE_IN);
    expect(record.route).toBe('[]');
    expect(record.snrTowards).toBe('[40]');
    expect(sourceId).toBe('bridge-1');

    const telemetryCall = (databaseService.insertTelemetry as any).mock.calls
      .find((c: any[]) => c[0].telemetryType === 'messageHops');
    expect(telemetryCall).toBeDefined();
    expect(telemetryCall[0].value).toBe(1); // route.length + 1
    expect(telemetryCall[1]).toBe('bridge-1');
  });

  it('upserts the sender node when it has not been seen before', async () => {
    await ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor(NODE_IN, 70 /* TRACEROUTE_APP */),
    });
    expect(databaseService.nodes.upsertNode).toHaveBeenCalled();
    const senderUpsert = (databaseService.nodes.upsertNode as any).mock.calls
      .find((c: any[]) => c[0].nodeNum === NODE_IN);
    expect(senderUpsert).toBeDefined();
    expect(senderUpsert[1]).toBe('bridge-1');
  });
});

describe('ingestServiceEnvelope — NEIGHBORINFO_APP', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('replaces the sender neighbor list scoped to this source', async () => {
    const result = await ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor(NODE_IN, 71 /* NEIGHBORINFO_APP */),
    });
    expect(result.ingested).toBe(true);
    // Old rows are wiped first, then the new batch is inserted.
    expect(databaseService.neighbors.deleteNeighborInfoForNode).toHaveBeenCalledWith(NODE_IN, 'bridge-1');
    expect(databaseService.neighbors.insertNeighborInfoBatch).toHaveBeenCalledTimes(1);
    const [records, sourceId] = (databaseService.neighbors.insertNeighborInfoBatch as any).mock.calls[0];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      nodeNum: NODE_IN,
      neighborNodeNum: 0xaaaa1111,
      snr: 4.5,
      lastRxTime: 1700000000,
    });
    expect(sourceId).toBe('bridge-1');
  });

  it('drops a packet with an empty neighbors array as decode-error', async () => {
    const { default: protobuf } = await import('./meshtasticProtobufService.js');
    (protobuf.processPayload as any).mockImplementationOnce(() => ({ neighbors: [] }));
    const result = await ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor(NODE_IN, 71),
    });
    expect(result.ingested).toBe(false);
    expect(result.reason).toBe('decode-error');
    expect(databaseService.neighbors.insertNeighborInfoBatch).not.toHaveBeenCalled();
  });
});

describe('ingestServiceEnvelope — PAXCOUNTER_APP', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes wifi, ble, and uptime telemetry rows with paxcounter type names', async () => {
    const result = await ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor(NODE_IN, 34 /* PAXCOUNTER_APP */),
    });
    expect(result.ingested).toBe(true);
    const types = (databaseService.insertTelemetry as any).mock.calls.map((c: any[]) => c[0].telemetryType);
    expect(types).toEqual(expect.arrayContaining(['paxcounterWifi', 'paxcounterBle', 'paxcounterUptime']));
    // All three carry the bridge's sourceId.
    for (const call of (databaseService.insertTelemetry as any).mock.calls) {
      expect(call[1]).toBe('bridge-1');
    }
  });

  it('returns decode-error when no metrics are decodable', async () => {
    const { default: protobuf } = await import('./meshtasticProtobufService.js');
    (protobuf.processPayload as any).mockImplementationOnce(() => ({}));
    const result = await ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor(NODE_IN, 34),
    });
    expect(result.ingested).toBe(false);
    expect(result.reason).toBe('decode-error');
  });
});

describe('ingestServiceEnvelope — STORE_FORWARD_APP', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('replays a ROUTER_TEXT_BROADCAST as a viaStoreForward text message', async () => {
    const result = await ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor(NODE_IN, 65 /* STORE_FORWARD_APP */),
    });
    expect(result.ingested).toBe(true);
    expect(databaseService.messages.insertMessage).toHaveBeenCalledTimes(1);
    const inserted = (databaseService.messages.insertMessage as any).mock.calls[0][0];
    expect(inserted.text).toBe('replayed');
    expect(inserted.fromNodeNum).toBe(NODE_IN);
    expect(inserted.viaMqtt).toBe(true);
    expect(inserted.viaStoreForward).toBe(true);
    expect(inserted.sourceId).toBe('bridge-1');
  });

  it('does NOT insert a duplicate when the original message already landed', async () => {
    (databaseService.messages.getMessage as any).mockResolvedValueOnce({ id: 'exists' });
    const result = await ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor(NODE_IN, 65),
    });
    expect(result.ingested).toBe(false);
    expect(databaseService.messages.insertMessage).not.toHaveBeenCalled();
  });

  it('marks a node as a Store & Forward server on a ROUTER_HEARTBEAT', async () => {
    const { default: protobuf } = await import('./meshtasticProtobufService.js');
    (protobuf.processPayload as any).mockImplementationOnce(() => ({ rr: 2 /* ROUTER_HEARTBEAT */ }));
    const result = await ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor(NODE_IN, 65),
    });
    expect(result.ingested).toBe(true);
    expect(databaseService.upsertNode).toHaveBeenCalledTimes(1);
    const upserted = (databaseService.upsertNode as any).mock.calls[0][0];
    expect(upserted.nodeNum).toBe(NODE_IN);
    expect(upserted.isStoreForwardServer).toBe(true);
  });

  it('returns unsupported-portnum for log-only S&F subtypes (STATS)', async () => {
    const { default: protobuf } = await import('./meshtasticProtobufService.js');
    (protobuf.processPayload as any).mockImplementationOnce(() => ({ rr: 7 /* ROUTER_STATS */, stats: {} }));
    const result = await ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor(NODE_IN, 65),
    });
    expect(result.ingested).toBe(false);
    expect(result.reason).toBe('unsupported-portnum');
    expect(databaseService.messages.insertMessage).not.toHaveBeenCalled();
    expect(databaseService.upsertNode).not.toHaveBeenCalled();
  });
});

/**
 * Channel-permission re-wire: MQTT-sourced rows are permission-keyed via
 * channel_database_permissions rather than per-source channel_0..7 slots.
 * The seam is here in the ingest path — `channel` gets rewritten to the
 * `CHANNEL_DB_OFFSET + channelDatabaseId` encoding nodeEnhancer already
 * enforces. These tests pin that contract.
 */
describe('ingestServiceEnvelope — channel_database resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetMqttIngestCachesForTest();
  });

  it('stamps `channel` with CHANNEL_DB_OFFSET + id when the channel name resolves', async () => {
    (databaseService.channelDatabase!.findOrCreatePassiveByNameAsync as any).mockResolvedValueOnce(7);

    const result = await ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor(NODE_IN, 1 /* TEXT_MESSAGE_APP */),
    });

    expect(result.ingested).toBe(true);
    expect(databaseService.channelDatabase!.findOrCreatePassiveByNameAsync).toHaveBeenCalledWith('LongFast');
    const inserted = (databaseService.messages.insertMessage as any).mock.calls[0][0];
    expect(inserted.channel).toBe(CHANNEL_DB_OFFSET + 7);
  });

  it('memoizes lookups per channel name so repeated packets do not hit the DB twice', async () => {
    (databaseService.channelDatabase!.findOrCreatePassiveByNameAsync as any).mockResolvedValue(11);

    await ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor(NODE_IN, 1 /* TEXT_MESSAGE_APP */),
    });
    await ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor(NODE_IN, 1 /* TEXT_MESSAGE_APP */),
    });

    expect(databaseService.channelDatabase!.findOrCreatePassiveByNameAsync).toHaveBeenCalledTimes(1);
    const inserts = (databaseService.messages.insertMessage as any).mock.calls;
    expect(inserts[0][0].channel).toBe(CHANNEL_DB_OFFSET + 11);
    expect(inserts[1][0].channel).toBe(CHANNEL_DB_OFFSET + 11);
  });

  it('falls back to the raw slot when envelope.channelId is missing', async () => {
    const envelope: ServiceEnvelopeShape = {
      // No channelId.
      gatewayId: '!00000001',
      packet: {
        id: 0xfeed0001,
        from: NODE_IN,
        to: 0xffffffff,
        channel: 3,
        decoded: { portnum: 1 /* TEXT_MESSAGE_APP */, payload: new Uint8Array([0]) },
      },
    };

    const result = await ingestServiceEnvelope({ sourceId: 'bridge-1', envelope });
    expect(result.ingested).toBe(true);
    expect(databaseService.channelDatabase!.findOrCreatePassiveByNameAsync).not.toHaveBeenCalled();
    const inserted = (databaseService.messages.insertMessage as any).mock.calls[0][0];
    expect(inserted.channel).toBe(3);
  });

  it('prefers a channelDatabaseId already attached by the decrypt path over the name lookup', async () => {
    // Simulate the server-side-decrypted shape: `packet.decoded.channelDatabaseId`
    // is set by channelDecryptionService.tryDecrypt() in mqttIngestion.ts.
    // The name-based find-or-create must not be invoked when we already know
    // the channel_database row.
    const envelope: ServiceEnvelopeShape = {
      channelId: 'LongFast',
      gatewayId: '!00000001',
      packet: {
        id: 0xfeed0002,
        from: NODE_IN,
        to: 0xffffffff,
        channel: 0,
        decoded: {
          portnum: 1 /* TEXT_MESSAGE_APP */,
          payload: new Uint8Array([0]),
          channelDatabaseId: 42,
        } as any,
      },
    };

    const result = await ingestServiceEnvelope({ sourceId: 'bridge-1', envelope });
    expect(result.ingested).toBe(true);
    expect(databaseService.channelDatabase!.findOrCreatePassiveByNameAsync).not.toHaveBeenCalled();
    const inserted = (databaseService.messages.insertMessage as any).mock.calls[0][0];
    expect(inserted.channel).toBe(CHANNEL_DB_OFFSET + 42);
  });

  it('falls back to the raw slot when the find-or-create resolves to null', async () => {
    // Edge case: an empty/whitespace-only channel name reaches the repo and
    // returns null — surface should still ingest the row with the slot
    // value, just not permission-key it through channel_database.
    (databaseService.channelDatabase!.findOrCreatePassiveByNameAsync as any).mockResolvedValueOnce(null);

    const result = await ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor(NODE_IN, 1 /* TEXT_MESSAGE_APP */),
    });
    expect(result.ingested).toBe(true);
    const inserted = (databaseService.messages.insertMessage as any).mock.calls[0][0];
    expect(inserted.channel).toBe(0); // raw slot from the envelope
  });

  it('encodes the channel on traceroute rows the same way as messages', async () => {
    (databaseService.channelDatabase!.findOrCreatePassiveByNameAsync as any).mockResolvedValueOnce(5);

    const result = await ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor(NODE_IN, 70 /* TRACEROUTE_APP */),
    });
    expect(result.ingested).toBe(true);
    const [record] = (databaseService.insertTraceroute as any).mock.calls[0];
    expect(record.channel).toBe(CHANNEL_DB_OFFSET + 5);
  });

  it('stamps node.channel on NODEINFO upserts so the map filter can honor Virtual Channel Permissions', async () => {
    // Regression: prior to the fix, NODEINFO_APP and POSITION_APP node
    // upserts dropped the resolved channel. The map filter then read
    // `node.channel ?? 0` → channel 0 → required a per-source channel_0
    // grant. But #3108 hides the channel_0..7 toggles for MQTT scopes
    // and directs admins to Virtual Channel Permissions, leaving no
    // way to grant map access — every non-admin saw "No nodes visible".
    (databaseService.channelDatabase!.findOrCreatePassiveByNameAsync as any).mockResolvedValueOnce(9);

    const result = await ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor(NODE_IN, 4 /* NODEINFO_APP */),
    });

    expect(result.ingested).toBe(true);
    const [insertedNode] = (databaseService.upsertNode as any).mock.calls[0];
    expect(insertedNode.channel).toBe(CHANNEL_DB_OFFSET + 9);
  });

  it('stamps node.channel on POSITION upserts the same way as NODEINFO', async () => {
    (databaseService.channelDatabase!.findOrCreatePassiveByNameAsync as any).mockResolvedValueOnce(4);

    const result = await ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor(NODE_IN, 3 /* POSITION_APP */),
    });

    expect(result.ingested).toBe(true);
    const [insertedNode] = (databaseService.upsertNode as any).mock.calls[0];
    expect(insertedNode.channel).toBe(CHANNEL_DB_OFFSET + 4);
  });

  it('falls back to the raw slot on node.channel when name resolution fails', async () => {
    // Mirrors the same fallback semantics as the message-side test
    // above — an empty channelId or null find-or-create should still
    // ingest the node, just keyed to the raw slot.
    (databaseService.channelDatabase!.findOrCreatePassiveByNameAsync as any).mockResolvedValueOnce(null);

    const result = await ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor(NODE_IN, 4 /* NODEINFO_APP */),
    });

    expect(result.ingested).toBe(true);
    const [insertedNode] = (databaseService.upsertNode as any).mock.calls[0];
    expect(insertedNode.channel).toBe(0); // raw slot from the envelope
  });
});
