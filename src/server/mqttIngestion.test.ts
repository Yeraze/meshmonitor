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
        // Toronto-ish — used to learn 'in' membership for NODE_IN.
        return { latitudeI: 437_000_000, longitudeI: -793_000_000, altitude: 100 };
      }
      if (portnum === 1 /* TEXT_MESSAGE_APP */) {
        return 'hello';
      }
      if (portnum === 67 /* TELEMETRY_APP */) {
        return { deviceMetrics: { batteryLevel: 90 } };
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

  it('drops a TEXT_MESSAGE from an unknown sender when bbox is enabled', () => {
    const filter = new MqttPacketFilter({ geo: ON_BBOX });
    const result = ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor(NODE_UNKNOWN, 1 /* TEXT_MESSAGE_APP */),
      filter,
    });
    expect(result.ingested).toBe(false);
    expect(result.reason).toBe('geo-filtered');
    expect(databaseService.insertMessage).not.toHaveBeenCalled();
    expect(databaseService.upsertNode).not.toHaveBeenCalled();
    expect(filter.getDropCounters().geo).toBe(1);
  });

  it('drops NODEINFO from an unknown sender when bbox is enabled', () => {
    const filter = new MqttPacketFilter({ geo: ON_BBOX });
    const result = ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor(NODE_UNKNOWN, 4 /* NODEINFO_APP */),
      filter,
    });
    expect(result.ingested).toBe(false);
    expect(result.reason).toBe('geo-filtered');
    expect(databaseService.upsertNode).not.toHaveBeenCalled();
  });

  it('drops TELEMETRY from an unknown sender when bbox is enabled', () => {
    const filter = new MqttPacketFilter({ geo: ON_BBOX });
    const result = ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor(NODE_UNKNOWN, 67 /* TELEMETRY_APP */),
      filter,
    });
    expect(result.ingested).toBe(false);
    expect(result.reason).toBe('geo-filtered');
    expect(databaseService.insertTelemetry).not.toHaveBeenCalled();
  });

  it('allows a TEXT_MESSAGE after the same sender posted an in-bbox POSITION', () => {
    const filter = new MqttPacketFilter({ geo: ON_BBOX });

    // Step 1: position learns NODE_IN as 'in'.
    const posResult = ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor(NODE_IN, 3 /* POSITION_APP */),
      filter,
    });
    expect(posResult.ingested).toBe(true);
    expect(filter.getMembershipSize()).toBe(1);

    // Step 2: text message from the same sender now passes the gate.
    vi.clearAllMocks();
    const txtResult = ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor(NODE_IN, 1 /* TEXT_MESSAGE_APP */),
      filter,
    });
    expect(txtResult.ingested).toBe(true);
    expect(databaseService.insertMessage).toHaveBeenCalledTimes(1);
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
    const posResult = ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor(NODE_OUT, 3 /* POSITION_APP */),
      filter,
    });
    expect(posResult.ingested).toBe(false);
    expect(posResult.reason).toBe('geo-filtered');

    // Subsequent text from the same sender — known-out → drop.
    const txtResult = ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor(NODE_OUT, 1 /* TEXT_MESSAGE_APP */),
      filter,
    });
    expect(txtResult.ingested).toBe(false);
    expect(txtResult.reason).toBe('geo-filtered');
    expect(databaseService.insertMessage).not.toHaveBeenCalled();
  });

  it('passes everything when no filter is supplied (back-compat)', () => {
    const result = ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor(NODE_UNKNOWN, 1 /* TEXT_MESSAGE_APP */),
      // No filter argument → no fail-closed enforcement.
    });
    expect(result.ingested).toBe(true);
    expect(databaseService.insertMessage).toHaveBeenCalledTimes(1);
  });

  it('passes non-position packets when bbox is configured with empty bounds', () => {
    const filter = new MqttPacketFilter({ geo: {} });
    const result = ingestServiceEnvelope({
      sourceId: 'bridge-1',
      envelope: envFor(NODE_UNKNOWN, 1 /* TEXT_MESSAGE_APP */),
      filter,
    });
    expect(result.ingested).toBe(true);
    expect(filter.getDropCounters().geo).toBe(0);
  });
});
