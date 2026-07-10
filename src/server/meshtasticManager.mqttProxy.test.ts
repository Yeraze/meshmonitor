import { describe, it, expect, vi, beforeAll } from 'vitest';

// Stub the database service before importing the protobuf service (which
// transitively pulls it in). The proxy parse/encode helpers don't touch
// the DB, so any in-memory mock will do.
vi.mock('../services/database.js', () => ({
  default: {},
}));

import meshtasticProtobufService from './meshtasticProtobufService.js';
import { loadProtobufDefinitions, getProtobufRoot } from './protobufLoader.js';

describe('mqttClientProxyMessage parse + encode', () => {
  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  it('encodes a ToRadio.mqttClientProxyMessage that round-trips on the firmware side', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const bytes = meshtasticProtobufService.encodeToRadioMqttClientProxyMessage({
      topic: 'msh/US/2/e/LongFast/!abcdef01',
      data,
      retained: false,
    });
    expect(bytes).toBeTruthy();
    expect(bytes!.length).toBeGreaterThan(0);

    // Decode using the protobuf root to confirm shape — the firmware would
    // see the same structure.
    const root = getProtobufRoot()!;
    const ToRadio = root.lookupType('meshtastic.ToRadio');
    const decoded = ToRadio.decode(bytes!) as any;
    expect(decoded.mqttClientProxyMessage).toBeTruthy();
    expect(decoded.mqttClientProxyMessage.topic).toBe('msh/US/2/e/LongFast/!abcdef01');
    expect(Buffer.from(decoded.mqttClientProxyMessage.data).equals(Buffer.from(data))).toBe(true);
    expect(decoded.mqttClientProxyMessage.retained).toBe(false);
  });

  it('parseIncomingData surfaces FromRadio.mqttClientProxyMessage with type mqttClientProxyMessage', () => {
    const root = getProtobufRoot()!;
    const Mcpm = root.lookupType('meshtastic.MqttClientProxyMessage');
    const FromRadio = root.lookupType('meshtastic.FromRadio');
    const payload = new Uint8Array([9, 9, 9]);
    const m = Mcpm.create({
      topic: 'msh/US/2/e/LongFast/!11111111',
      data: payload,
      retained: true,
    });
    const fr = FromRadio.create({ mqttClientProxyMessage: m });
    const bytes = FromRadio.encode(fr).finish();

    const parsed = meshtasticProtobufService.parseIncomingData(bytes);
    expect(parsed).not.toBeNull();
    expect(parsed!.type).toBe('mqttClientProxyMessage');
    expect(parsed!.data.topic).toBe('msh/US/2/e/LongFast/!11111111');
    expect(parsed!.data.retained).toBe(true);
    expect(Buffer.from(parsed!.data.data).equals(Buffer.from(payload))).toBe(true);
  });

  it('parseIncomingData on an unrelated FromRadio variant still returns its own type, not mqttClientProxyMessage', () => {
    const root = getProtobufRoot()!;
    const FromRadio = root.lookupType('meshtastic.FromRadio');
    const fr = FromRadio.create({ configCompleteId: 1234 });
    const bytes = FromRadio.encode(fr).finish();
    const parsed = meshtasticProtobufService.parseIncomingData(bytes);
    expect(parsed?.type).toBe('configComplete');
  });
});
