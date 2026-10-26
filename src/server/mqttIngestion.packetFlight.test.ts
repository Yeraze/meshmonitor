/**
 * Live packet traffic (#4835): every MQTT gateway reception raises one
 * `packet:flight` from the ingestServiceEnvelope wrapper, independent of the
 * MQTT packet log (mocked out here), and only while a map watches the source.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../services/database.js', () => ({
  default: {
    upsertNodeAsync: vi.fn(async () => undefined),
    nodes: {
      getNode: vi.fn(async () => null),
      getNodesByNums: vi.fn(async () => new Map()),
      upsertNode: vi.fn(async () => undefined),
    },
    ignoredNodes: {
      isIgnoredCached: vi.fn(() => false),
      addGeoIgnoreAsync: vi.fn(async () => true),
      liftGeoIgnoreAsync: vi.fn(async () => false),
    },
    messages: {
      getMessage: vi.fn(async () => null),
      insertMessage: vi.fn(async (_msg: any, _sourceId?: string) => true),
    },
    channels: {
      upsertChannel: vi.fn(async () => undefined),
      getChannelById: vi.fn(async () => null),
    },
    channelDatabase: {
      findOrCreateByNameAndHashAsync: vi.fn(async () => undefined),
      findOrCreatePassiveByNameAsync: vi.fn(async () => undefined),
      getEnabledAsync: vi.fn(async () => []),
    },
    settings: {
      getSettingForSource: vi.fn(async () => null),
    },
    sources: {
      getSource: vi.fn(async () => null),
    },
  },
}));

vi.mock('./meshtasticProtobufService.js', () => ({
  default: {
    processPayload: vi.fn((portnum: number, payload: Uint8Array) => {
      if (portnum === 1 /* TEXT_MESSAGE_APP */) {
        return new TextDecoder('utf-8').decode(payload);
      }
      if (portnum === 4 /* NODEINFO_APP */) {
        return { longName: 'Test', shortName: 'TST', hwModel: 1 };
      }
      if (portnum === 65 /* STORE_FORWARD_APP */) {
        return { rr: 9 /* ROUTER_TEXT_BROADCAST */, text: new TextEncoder().encode('replayed') };
      }
      return null;
    }),
    getPortNumName: vi.fn((portnum: number) => `PORT_${portnum}`),
  },
}));

vi.mock('./services/mqttPacketLogService.js', () => ({
  default: { logEnvelope: vi.fn(async () => undefined) },
}));

vi.mock('./services/messagePushNotifier.js', () => ({
  sendMessagePushNotification: vi.fn(async () => undefined),
}));

import { ingestServiceEnvelope, _resetMqttIngestCachesForTest } from './mqttIngestion.js';
import { dataEventEmitter, type DataEvent } from './services/dataEventEmitter.js';
import { watchPacketFlights, resetPacketFlightWatchers } from './services/packetFlightWatchers.js';
import databaseService from '../services/database.js';
import type { ServiceEnvelopeShape } from './mqttPacketFilter.js';
import mqttPacketLogService from './services/mqttPacketLogService.js';

const SOURCE = 'mqtt-1';
const SENDER = 0x0a0b0c0d;

function envFor(gatewayId: string, packet: Record<string, unknown> = {}): ServiceEnvelopeShape {
  return {
    channelId: 'LongFast',
    gatewayId,
    packet: {
      id: 0x12345678,
      from: SENDER,
      to: 0xffffffff,
      channel: 0,
      hopStart: 3,
      hopLimit: 3,
      rxSnr: 7.25,
      rxRssi: -70,
      decoded: { portnum: 1, payload: new TextEncoder().encode('do not leak me') },
      ...packet,
    },
  } as ServiceEnvelopeShape;
}

describe('mqttIngestion: packet:flight (#4835)', () => {
  let events: DataEvent[];
  const listener = (e: DataEvent) => events.push(e);

  beforeEach(() => {
    vi.clearAllMocks();
    _resetMqttIngestCachesForTest();
    (databaseService.messages.insertMessage as any).mockResolvedValue(true);
    (databaseService.ignoredNodes.isIgnoredCached as any).mockReturnValue(false);
    resetPacketFlightWatchers();
    events = [];
    dataEventEmitter.on('data', listener);
  });
  afterEach(() => {
    dataEventEmitter.off('data', listener);
    resetPacketFlightWatchers();
  });

  const flights = () => events.filter((e) => e.type === 'packet:flight').map((e) => e.data as any);

  it('emits one flight per gateway reception (fan-out), with no packet content', async () => {
    watchPacketFlights('sock-1', SOURCE);
    await ingestServiceEnvelope({ sourceId: SOURCE, envelope: envFor('!00000001') });
    await ingestServiceEnvelope({ sourceId: SOURCE, envelope: envFor('!00000002', { hopLimit: 1, relayNode: 0x2b }) });
    const got = flights();
    expect(got).toHaveLength(2);
    expect(got[0]).toMatchObject({ sourceId: SOURCE, protocol: 'mqtt', from: SENDER, to: 1, hopsUsed: 0, relay: null, kind: 'PORT_1', snr: 7.25, rssi: -70 });
    expect(got[1]).toMatchObject({ from: SENDER, to: 2, hopsUsed: 2, relay: 0x2b });
    expect(JSON.stringify(got)).not.toContain('leak');
    expect(mqttPacketLogService.logEnvelope).toHaveBeenCalled();
  });

  it('emits nothing while no map watches the source', async () => {
    await ingestServiceEnvelope({ sourceId: SOURCE, envelope: envFor('!00000001') });
    expect(flights()).toHaveLength(0);
  });

  it('emits nothing for an ignored node', async () => {
    watchPacketFlights('sock-1', SOURCE);
    (databaseService.ignoredNodes.isIgnoredCached as any).mockReturnValue(true);
    await ingestServiceEnvelope({ sourceId: SOURCE, envelope: envFor('!00000001') });
    expect(flights()).toHaveLength(0);
  });

  it('emits nothing without a gateway id', async () => {
    watchPacketFlights('sock-1', SOURCE);
    await ingestServiceEnvelope({ sourceId: SOURCE, envelope: { ...envFor('!00000001'), gatewayId: undefined } });
    expect(flights()).toHaveLength(0);
  });
});
