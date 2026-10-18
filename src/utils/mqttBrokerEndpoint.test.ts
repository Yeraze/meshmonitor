import { describe, it, expect } from 'vitest';
import {
  bridgeUrlForEndpoint,
  bridgeUrlReachesEndpoint,
  deviceFieldsReachEndpoint,
  parseBridgeUrl,
  splitDeviceAddress,
} from './mqttBrokerEndpoint';

const FL = { host: 'broker.fl-mesh.org', port: 1883, tls: false };

describe('mqttBrokerEndpoint (#5794)', () => {
  it('splits a device address on the first colon', () => {
    expect(splitDeviceAddress(' Host.Example ')).toEqual({ host: 'host.example', port: null });
    expect(splitDeviceAddress('h:1884')).toEqual({ host: 'h', port: 1884 });
    expect(splitDeviceAddress('h:abc').port).toBeNaN();
  });

  it('matches a device address with or without the default port', () => {
    expect(deviceFieldsReachEndpoint({ address: 'broker.fl-mesh.org', tlsEnabled: false }, FL)).toBe(true);
    expect(deviceFieldsReachEndpoint({ address: 'broker.fl-mesh.org:1883', tlsEnabled: false }, FL)).toBe(true);
    expect(deviceFieldsReachEndpoint({ address: 'broker.fl-mesh.org:1884', tlsEnabled: false }, FL)).toBe(false);
    expect(deviceFieldsReachEndpoint({ address: 'broker.fl-mesh.org', tlsEnabled: true }, FL)).toBe(false);
    // No port under TLS means 8883, so it does not reach a TLS endpoint on 1883.
    expect(deviceFieldsReachEndpoint({ address: 'broker.fl-mesh.org', tlsEnabled: true }, { ...FL, tls: true })).toBe(false);
  });

  it('treats an empty device address as the default public server only', () => {
    const pub = { host: 'mqtt.meshtastic.org', port: 1883, tls: false };
    expect(deviceFieldsReachEndpoint({ address: '', tlsEnabled: false }, pub)).toBe(true);
    expect(deviceFieldsReachEndpoint({ address: '', tlsEnabled: false }, FL)).toBe(false);
  });

  it('parses and matches bridge URLs', () => {
    expect(parseBridgeUrl('mqtts://u:p@Host.example')).toEqual({ host: 'host.example', port: 8883, tls: true });
    expect(parseBridgeUrl('ws://host')).toBeNull();
    // A bare host is read the way the bridge connects to it.
    expect(parseBridgeUrl('mqtt.areyoumeshingwith.us')).toEqual({ host: 'mqtt.areyoumeshingwith.us', port: 1883, tls: false });
    expect(parseBridgeUrl('h.example:8883')).toEqual({ host: 'h.example', port: 8883, tls: true });
    expect(parseBridgeUrl('')).toBeNull();
    expect(bridgeUrlReachesEndpoint('mqtt://broker.fl-mesh.org', FL)).toBe(true);
    expect(bridgeUrlReachesEndpoint('mqtt://broker.fl-mesh.org:1884', FL)).toBe(false);
    expect(bridgeUrlForEndpoint(FL)).toBe('mqtt://broker.fl-mesh.org:1883');
  });
});
