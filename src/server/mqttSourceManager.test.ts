import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock databaseService to capture the sourceId passed to each repo call.
// vi.hoisted is required because vi.mock is hoisted above all imports — without
// it, the const declarations below would be uninitialized at the time the
// factory closure is invoked.
const { upsertNodeMock, insertMessageMock, insertTelemetryMock } = vi.hoisted(() => ({
  upsertNodeMock: vi.fn().mockResolvedValue(undefined),
  insertMessageMock: vi.fn().mockResolvedValue(true),
  insertTelemetryMock: vi.fn().mockResolvedValue(true),
}));

vi.mock('../services/database.js', () => ({
  default: {
    nodes: { upsertNode: upsertNodeMock },
    messages: { insertMessage: insertMessageMock },
    telemetry: { insertTelemetry: insertTelemetryMock },
  },
}));

import { MqttSourceManager, mqttSourceConfigFromSource } from './mqttSourceManager.js';
import meshtasticProtobufService from './meshtasticProtobufService.js';
import { PortNum } from './constants/meshtastic.js';
import { loadProtobufDefinitions, getProtobufRoot } from './protobufLoader.js';

const baseConfig = {
  broker: { url: 'mqtt://127.0.0.1:1883' },
  gateway: {
    nodeNum: 0x7ff80a48,
    nodeId: '!7ff80a48',
    longName: 'MM-GW',
    shortName: 'MMGW',
  },
  rootTopic: 'msh/US',
  subscriptions: ['msh/US/2/e/#'],
};

beforeEach(async () => {
  upsertNodeMock.mockClear();
  insertMessageMock.mockClear();
  insertTelemetryMock.mockClear();
  // Protobufs must be loaded for encode/decode to work
  await loadProtobufDefinitions();
});

describe('MqttSourceManager — interface contract', () => {
  it('implements ISourceManager surface', () => {
    const mgr = new MqttSourceManager('mqtt-1', baseConfig);
    expect(mgr.sourceId).toBe('mqtt-1');
    expect(mgr.sourceType).toBe('mqtt');
    expect(typeof mgr.start).toBe('function');
    expect(typeof mgr.stop).toBe('function');

    const status = mgr.getStatus();
    expect(status.sourceId).toBe('mqtt-1');
    expect(status.sourceType).toBe('mqtt');
    expect(status.connected).toBe(false);
    expect(status.nodeNum).toBe(baseConfig.gateway.nodeNum);

    const local = mgr.getLocalNodeInfo();
    expect(local?.nodeId).toBe('!7ff80a48');
    expect(local?.longName).toBe('MM-GW');
  });
});

describe('mqttSourceConfigFromSource', () => {
  it('returns the config when valid', () => {
    const source = { id: 'x', name: 'y', type: 'mqtt' as const, enabled: true, config: baseConfig } as any;
    expect(mqttSourceConfigFromSource(source)).toBeTruthy();
  });

  it('rejects missing broker URL', () => {
    const source = { id: 'x', name: 'y', type: 'mqtt' as const, enabled: true, config: { ...baseConfig, broker: {} } } as any;
    expect(mqttSourceConfigFromSource(source)).toBeNull();
  });

  it('rejects missing gateway identity', () => {
    const { gateway: _gw, ...rest } = baseConfig;
    void _gw;
    const source = { id: 'x', name: 'y', type: 'mqtt' as const, enabled: true, config: rest } as any;
    expect(mqttSourceConfigFromSource(source)).toBeNull();
  });
});

describe('MqttSourceManager — broker message handling', () => {
  /** Build a real ServiceEnvelope wrapping a NODEINFO packet. */
  function buildNodeInfoEnvelope(opts: {
    fromNum: number;
    longName: string;
    shortName: string;
    channelId: string;
    gatewayId: string;
  }): Buffer {
    const root = getProtobufRoot();
    if (!root) throw new Error('protobufs not loaded');
    const User = root.lookupType('meshtastic.User');
    const user = User.create({
      id: `!${(opts.fromNum >>> 0).toString(16).padStart(8, '0')}`,
      longName: opts.longName,
      shortName: opts.shortName,
      hwModel: 0,
    });
    const userPayload = User.encode(user).finish();
    const packet = {
      from: opts.fromNum,
      to: 0xffffffff,
      id: opts.fromNum & 0xffffff,
      channel: 0,
      hopLimit: 3,
      decoded: { portnum: PortNum.NODEINFO_APP, payload: userPayload },
    };
    const envBytes = meshtasticProtobufService.encodeServiceEnvelope({
      packet,
      channelId: opts.channelId,
      gatewayId: opts.gatewayId,
    });
    if (!envBytes) throw new Error('encodeServiceEnvelope failed');
    return Buffer.from(envBytes);
  }

  it('ingests NODEINFO into nodes table with the manager sourceId', async () => {
    const mgr = new MqttSourceManager('source-A', baseConfig);
    const payload = buildNodeInfoEnvelope({
      fromNum: 0xdeadbeef,
      longName: 'External Node',
      shortName: 'EXT',
      channelId: 'LongFast',
      gatewayId: '!cafebabe',
    });
    await (mgr as any).handleBrokerMessage({
      topic: 'msh/US/2/e/LongFast/!deadbeef',
      payload,
      retained: false,
    });
    // ingest is async-fire-and-forget; wait a microtask tick
    await new Promise((r) => setImmediate(r));

    expect(upsertNodeMock).toHaveBeenCalled();
    const [nodeData, sourceId] = upsertNodeMock.mock.calls[0];
    expect(sourceId).toBe('source-A');
    expect(nodeData.nodeNum).toBe(0xdeadbeef);
    expect(nodeData.nodeId).toBe('!deadbeef');
    expect(nodeData.longName).toBe('External Node');
    expect(nodeData.shortName).toBe('EXT');
    expect(nodeData.viaMqtt).toBe(true);
  });

  it('isolates ingestion between two MQTT sources', async () => {
    const a = new MqttSourceManager('source-A', baseConfig);
    const b = new MqttSourceManager('source-B', baseConfig);

    const aPayload = buildNodeInfoEnvelope({ fromNum: 1, longName: 'A', shortName: 'A', channelId: 'C', gatewayId: '!1' });
    const bPayload = buildNodeInfoEnvelope({ fromNum: 2, longName: 'B', shortName: 'B', channelId: 'C', gatewayId: '!2' });

    await (a as any).handleBrokerMessage({ topic: 't/a', payload: aPayload, retained: false });
    await (b as any).handleBrokerMessage({ topic: 't/b', payload: bPayload, retained: false });
    await new Promise((r) => setImmediate(r));

    const sourceIds = upsertNodeMock.mock.calls.map((c) => c[1]).sort();
    expect(sourceIds).toEqual(['source-A', 'source-B']);
  });

  it('preFilter drops packets that violate the filter', async () => {
    const mgr = new MqttSourceManager('source-C', {
      ...baseConfig,
      filters: { nodes: { block: ['!deadbeef'] } },
    });
    const payload = buildNodeInfoEnvelope({
      fromNum: 0xdeadbeef,
      longName: 'Blocked',
      shortName: 'BLK',
      channelId: 'C',
      gatewayId: '!1',
    });
    await (mgr as any).handleBrokerMessage({ topic: 'msh/US/2/e/C/!deadbeef', payload, retained: false });
    await new Promise((r) => setImmediate(r));

    expect(upsertNodeMock).not.toHaveBeenCalled();
    expect(mgr.getDroppedPackets()).toBe(1);
  });

  it('emits brokerMessage event for Quick-Connect listeners regardless of filter', async () => {
    const mgr = new MqttSourceManager('source-D', {
      ...baseConfig,
      filters: { nodes: { block: ['!deadbeef'] } },
    });
    const observed: { topic: string; retained: boolean }[] = [];
    mgr.on('brokerMessage', (msg) => observed.push({ topic: msg.topic, retained: msg.retained }));

    const payload = buildNodeInfoEnvelope({
      fromNum: 0xdeadbeef,
      longName: 'X',
      shortName: 'X',
      channelId: 'C',
      gatewayId: '!1',
    });
    await (mgr as any).handleBrokerMessage({ topic: 'msh/US/2/e/C/!deadbeef', payload, retained: false });

    expect(observed).toEqual([{ topic: 'msh/US/2/e/C/!deadbeef', retained: false }]);
    // But ingestion was still dropped by filter:
    expect(upsertNodeMock).not.toHaveBeenCalled();
  });

  it('echo-suppresses our own previously-published packets', async () => {
    const mgr = new MqttSourceManager('source-E', baseConfig);
    const payload = buildNodeInfoEnvelope({
      fromNum: 0xdeadbeef,
      longName: 'Echo',
      shortName: 'ECHO',
      channelId: 'C',
      gatewayId: '!1',
    });
    // Pretend we just published this envelope
    (mgr as any).recordPublishForEchoSuppression(new Uint8Array(payload));
    // Broker echoes it back
    await (mgr as any).handleBrokerMessage({ topic: 't', payload, retained: false });
    await new Promise((r) => setImmediate(r));

    expect(upsertNodeMock).not.toHaveBeenCalled();
  });
});
