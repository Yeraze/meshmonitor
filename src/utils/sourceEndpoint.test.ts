import { describe, it, expect } from 'vitest';
import { getSourceEndpointLabel } from './sourceEndpoint';

describe('getSourceEndpointLabel', () => {
  it('returns host:port for a meshtastic_tcp source', () => {
    expect(
      getSourceEndpointLabel({
        type: 'meshtastic_tcp',
        config: { host: '192.168.0.50', port: 4403 },
      }),
    ).toBe('192.168.0.50:4403');
  });

  it('returns just the host when no port is configured', () => {
    expect(
      getSourceEndpointLabel({
        type: 'meshtastic_tcp',
        config: { host: 'node.local' },
      }),
    ).toBe('node.local');
  });

  it('falls back to broker when host is missing (mqtt-style sources)', () => {
    expect(
      getSourceEndpointLabel({
        type: 'mqtt',
        config: { broker: 'mqtt.example.com', port: 1883 },
      }),
    ).toBe('mqtt.example.com:1883');
  });

  it('returns null when source is undefined', () => {
    expect(getSourceEndpointLabel(undefined)).toBeNull();
  });

  it('returns null when source has no config', () => {
    expect(getSourceEndpointLabel({ type: 'meshtastic_tcp' })).toBeNull();
  });

  it('returns null when config has neither host nor broker', () => {
    expect(
      getSourceEndpointLabel({
        type: 'mqtt',
        config: { username: 'foo' },
      }),
    ).toBeNull();
  });

  it('ignores non-numeric port values', () => {
    expect(
      getSourceEndpointLabel({
        type: 'meshtastic_tcp',
        config: { host: '10.0.0.1', port: '4403' as unknown as number },
      }),
    ).toBe('10.0.0.1');
  });

  it('ignores non-string host values', () => {
    expect(
      getSourceEndpointLabel({
        type: 'meshtastic_tcp',
        config: { host: 12345 as unknown as string, port: 4403 },
      }),
    ).toBeNull();
  });
});
