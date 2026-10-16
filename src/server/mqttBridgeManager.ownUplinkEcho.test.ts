/**
 * #5858 — a packet this bridge sent upstream comes back down on its own
 * subscription. That copy must still be ingested on this source (the user's
 * own messages were missing from forwarder sources), but must not be handed
 * back to devices or the local broker. Drives the private handlers directly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/database.js', () => ({
  default: { ignoredNodes: { isIgnoredCached: () => false } },
}));
vi.mock('./utils/okToMqtt.js', () => ({
  allowsUplink: () => true,
  resolveOkToMqttForEnvelope: async () => 'allowed',
}));
vi.mock('./mqttIngestion.js', () => ({
  ingestServiceEnvelope: vi.fn().mockResolvedValue({ ingested: true }),
}));

import { MqttBridgeManager } from './mqttBridgeManager.js';
import { ingestServiceEnvelope } from './mqttIngestion.js';
import meshtasticProtobufService from './meshtasticProtobufService.js';

const TOPIC = 'msh/US/2/e/LongFast/!aaaa0001';
const NODE_A = 0xaaaa0001;

function makeBridge() {
  const bridge = new MqttBridgeManager('forwarder', 'Forwarder', {
    brokerSourceId: 'local-broker',
    upstream: { url: 'mqtt://127.0.0.1:1' },
    subscriptions: ['msh/US/#'],
    forwardingMode: 'single',
  });
  const upstreamPublish = vi.fn(async () => undefined);
  (bridge as any).client = {
    isConnected: () => true,
    publish: upstreamPublish,
    getCapabilities: () => ({ canSubscribe: true, canPublish: true, authFailed: false, deniedSubscriptions: [] }),
    getLastError: () => null,
  };
  const brokerPublish = vi.fn(async () => undefined);
  (bridge as any).parentBroker = {
    publish: brokerPublish,
    markBridgeOrigin: vi.fn(),
    markSkipRaise: vi.fn(),
    bridgeOriginOf: () => null,
  };
  const localPackets: unknown[] = [];
  bridge.on('local-packet', (p) => localPackets.push(p));
  return { bridge, upstreamPublish, brokerPublish, localPackets };
}

const envelope = (id: number) =>
  ({ channelId: 'LongFast', gatewayId: '!aaaa0001', packet: { from: NODE_A, id } }) as never;

describe('MqttBridgeManager — own uplink echo (#5858)', () => {
  beforeEach(() => {
    vi.mocked(ingestServiceEnvelope).mockClear();
    vi.spyOn(meshtasticProtobufService, 'decodeServiceEnvelope').mockImplementation(
      (payload: Buffer) => envelope(payload.readUInt32BE(0)),
    );
  });

  const payloadFor = (id: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(id, 0);
    return b;
  };

  it('ingests the echo of its own uplink but does not republish or relay it', async () => {
    const { bridge, upstreamPublish, brokerPublish, localPackets } = makeBridge();

    // The user's own message reaches the local broker and goes upstream.
    await (bridge as any).handleUplink({
      topic: TOPIC,
      payload: payloadFor(0x1001),
      retained: false,
      envelope: envelope(0x1001),
      clientId: '!aaaa0001',
    });
    expect(upstreamPublish).toHaveBeenCalledTimes(1);

    // The upstream broker hands the same packet back on our subscription.
    (bridge as any).handleDownlink(TOPIC, payloadFor(0x1001), false);

    expect(ingestServiceEnvelope).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ingestServiceEnvelope).mock.calls[0][0]).toMatchObject({ sourceId: 'forwarder' });
    expect(brokerPublish).not.toHaveBeenCalled();
    expect(localPackets).toHaveLength(0);
  });

  it('still ingests, republishes and relays traffic it did not send', () => {
    const { brokerPublish, localPackets, bridge } = makeBridge();

    (bridge as any).handleDownlink(TOPIC, payloadFor(0x2002), false);

    expect(ingestServiceEnvelope).toHaveBeenCalledTimes(1);
    expect(brokerPublish).toHaveBeenCalledTimes(1);
    expect(localPackets).toHaveLength(1);
  });
});
