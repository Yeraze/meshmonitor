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

import { ingestServiceEnvelope } from './mqttIngestion.js';
import { MqttPacketFilter, type ServiceEnvelopeShape } from './mqttPacketFilter.js';
import databaseService from '../services/database.js';

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
