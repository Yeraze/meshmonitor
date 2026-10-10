/**
 * The remote-admin MQTT load reply and the Save that sends it back, through the
 * real protobuf definitions. Firmware replaces the node's whole MQTTConfig on a
 * save, so a field lost on either side reaches the node as false / 0.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../../services/database.js', () => ({
  default: {},
}));

import protobufService from '../protobufService.js';
import { loadProtobufDefinitions, getProtobufRoot } from '../protobufLoader.js';
import { formatAdminMqttConfig } from './adminMqttConfig.js';

/** Every MQTTConfig field (tags 1-11), none at its default except encryption. */
const NODE_MQTT = {
  enabled: true,
  address: 'broker.example.org',
  username: 'ops',
  password: 'pw',
  encryptionEnabled: false,
  jsonEnabled: true,
  tlsEnabled: true,
  root: 'msh/EU',
  proxyToClientEnabled: true,
  mapReportingEnabled: true,
  mapReportSettings: { publishIntervalSecs: 7200, positionPrecision: 13, shouldReportLocation: true },
};

/** What a node's MQTTConfig looks like after it crosses the wire and is decoded. */
function decodedFromWire(mqtt: Record<string, unknown>): Record<string, any> {
  const MQTTConfig = getProtobufRoot()!.lookupType('meshtastic.ModuleConfig.MQTTConfig');
  return MQTTConfig.decode(MQTTConfig.encode(MQTTConfig.create(mqtt)).finish()) as any;
}

describe('formatAdminMqttConfig', () => {
  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  it('every field in module_config.proto MQTTConfig is carried', () => {
    const MQTTConfig = getProtobufRoot()!.lookupType('meshtastic.ModuleConfig.MQTTConfig');
    const MapReportSettings = getProtobufRoot()!.lookupType('meshtastic.ModuleConfig.MapReportSettings');
    const out = formatAdminMqttConfig({});
    expect(Object.keys(out).sort()).toEqual(Object.keys(MQTTConfig.fields).sort());
    expect(Object.keys(out.mapReportSettings).sort()).toEqual(Object.keys(MapReportSettings.fields).sort());
  });

  it('reads every field of a decoded node reply', () => {
    expect(formatAdminMqttConfig(decodedFromWire(NODE_MQTT))).toEqual(NODE_MQTT);
  });

  it('reads an elided false as false (encryption used to load as on)', () => {
    const decoded = decodedFromWire({ enabled: true, encryptionEnabled: false });
    expect(formatAdminMqttConfig(decoded)).toMatchObject({
      enabled: true,
      encryptionEnabled: false,
      proxyToClientEnabled: false,
      mapReportingEnabled: false,
      mapReportSettings: { publishIntervalSecs: 0, positionPrecision: 0, shouldReportLocation: false },
    });
  });

  it('an all-default reply ({}) yields every field at its default', () => {
    expect(formatAdminMqttConfig({})).toEqual({
      enabled: false,
      address: '',
      username: '',
      password: '',
      encryptionEnabled: false,
      jsonEnabled: false,
      tlsEnabled: false,
      root: '',
      proxyToClientEnabled: false,
      mapReportingEnabled: false,
      mapReportSettings: { publishIntervalSecs: 0, positionPrecision: 0, shouldReportLocation: false },
    });
  });

  it('load reply → setMQTTConfig admin message keeps every field on the wire', () => {
    const reply = formatAdminMqttConfig(decodedFromWire(NODE_MQTT));
    const encoded = protobufService.createSetMQTTConfigMessage(reply);
    const AdminMessage = getProtobufRoot()!.lookupType('meshtastic.AdminMessage');
    const decoded = AdminMessage.decode(encoded) as any;
    expect(formatAdminMqttConfig(decoded.setModuleConfig.mqtt)).toEqual(NODE_MQTT);
  });
});
