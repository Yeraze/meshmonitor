import { describe, it, expect } from 'vitest';
import {
  classifyBrokerAddress,
  resolveSourceBrokerAddress,
  classifySourceBrokerAddress,
  combineBrokerClasses,
} from './privateBrokerAddress.js';

describe('classifyBrokerAddress', () => {
  it('treats null/undefined as unknown', () => {
    expect(classifyBrokerAddress(null)).toBe('unknown');
    expect(classifyBrokerAddress(undefined)).toBe('unknown');
  });

  it('treats an empty string as the public default server', () => {
    expect(classifyBrokerAddress('')).toBe('public');
    expect(classifyBrokerAddress('   ')).toBe('public');
  });

  it('treats mqtt.meshtastic.org (any case, with/without port) as public', () => {
    expect(classifyBrokerAddress('mqtt.meshtastic.org')).toBe('public');
    expect(classifyBrokerAddress('MQTT.MESHTASTIC.ORG')).toBe('public');
    expect(classifyBrokerAddress('mqtt.meshtastic.org:1883')).toBe('public');
  });

  it('treats other hostnames as unknown', () => {
    expect(classifyBrokerAddress('mqtt.example.com')).toBe('unknown');
    expect(classifyBrokerAddress('my-private-broker.local:1883')).toBe('unknown');
  });

  it('treats IPv6 literals as unknown', () => {
    expect(classifyBrokerAddress('::1')).toBe('unknown');
    expect(classifyBrokerAddress('[::1]')).toBe('unknown');
    expect(classifyBrokerAddress('[::1]:1883')).toBe('unknown');
    expect(classifyBrokerAddress('[2001:db8::1]:8883')).toBe('unknown');
  });

  describe('10.0.0.0/8', () => {
    it('is private', () => {
      expect(classifyBrokerAddress('10.0.0.0')).toBe('private');
      expect(classifyBrokerAddress('10.1.2.3')).toBe('private');
      expect(classifyBrokerAddress('10.255.255.255')).toBe('private');
      expect(classifyBrokerAddress('10.1.2.3:1883')).toBe('private');
    });
  });

  describe('172.16.0.0/12 boundary', () => {
    it('172.15.x is public (just below the block)', () => {
      expect(classifyBrokerAddress('172.15.255.255')).toBe('public');
    });
    it('172.16.x .. 172.31.x is private', () => {
      expect(classifyBrokerAddress('172.16.0.0')).toBe('private');
      expect(classifyBrokerAddress('172.20.1.1')).toBe('private');
      expect(classifyBrokerAddress('172.31.255.255')).toBe('private');
    });
    it('172.32.x is public (just above the block)', () => {
      expect(classifyBrokerAddress('172.32.0.0')).toBe('public');
    });
  });

  describe('192.168.0.0/16', () => {
    it('is private', () => {
      expect(classifyBrokerAddress('192.168.0.1')).toBe('private');
      expect(classifyBrokerAddress('192.168.255.255')).toBe('private');
    });
    it('neighboring 192.167.x / 192.169.x are public', () => {
      expect(classifyBrokerAddress('192.167.0.1')).toBe('public');
      expect(classifyBrokerAddress('192.169.0.1')).toBe('public');
    });
  });

  describe('169.254.0.0/16 (link-local)', () => {
    it('is private', () => {
      expect(classifyBrokerAddress('169.254.1.1')).toBe('private');
    });
  });

  describe('100.64.0.0/10 boundary (CGNAT)', () => {
    it('100.63.x is public (just below the block)', () => {
      expect(classifyBrokerAddress('100.63.255.255')).toBe('public');
    });
    it('100.64.x .. 100.127.x is private', () => {
      expect(classifyBrokerAddress('100.64.0.0')).toBe('private');
      expect(classifyBrokerAddress('100.100.1.1')).toBe('private');
      expect(classifyBrokerAddress('100.127.255.255')).toBe('private');
    });
    it('100.128.x is public (just above the block)', () => {
      expect(classifyBrokerAddress('100.128.0.0')).toBe('public');
    });
  });

  describe('127.0.0.1/32 quirk', () => {
    it('127.0.0.1 exactly is private', () => {
      expect(classifyBrokerAddress('127.0.0.1')).toBe('private');
      expect(classifyBrokerAddress('127.0.0.1:1883')).toBe('private');
    });
    it('127.0.0.2 and the rest of 127.0.0.0/8 are NOT private', () => {
      expect(classifyBrokerAddress('127.0.0.2')).toBe('public');
      expect(classifyBrokerAddress('127.0.0.0')).toBe('public');
      expect(classifyBrokerAddress('127.1.2.3')).toBe('public');
      expect(classifyBrokerAddress('127.255.255.255')).toBe('public');
    });
  });

  describe('literal public IPv4', () => {
    it('is public, not unknown', () => {
      expect(classifyBrokerAddress('8.8.8.8')).toBe('public');
      expect(classifyBrokerAddress('203.0.113.5:8883')).toBe('public');
    });
  });

  describe('port suffix handling', () => {
    it('strips the port on the first colon before classifying', () => {
      expect(classifyBrokerAddress('192.168.1.5:1883')).toBe('private');
      expect(classifyBrokerAddress('8.8.8.8:8883')).toBe('public');
    });
  });

  describe('malformed IPv4-shaped input', () => {
    it('out-of-range octets are not treated as a literal IPv4', () => {
      expect(classifyBrokerAddress('999.1.1.1')).toBe('unknown');
      expect(classifyBrokerAddress('10.999.0.1')).toBe('unknown');
    });
  });
});

describe('resolveSourceBrokerAddress', () => {
  it('returns null for non-MQTT source types', () => {
    expect(resolveSourceBrokerAddress('meshtastic_tcp', { host: '10.0.0.1' })).toBeNull();
    expect(resolveSourceBrokerAddress('meshcore', {})).toBeNull();
    expect(resolveSourceBrokerAddress('reticulum', {})).toBeNull();
    expect(resolveSourceBrokerAddress(null, {})).toBeNull();
  });

  it('returns null when config is missing', () => {
    expect(resolveSourceBrokerAddress('mqtt_bridge', null)).toBeNull();
    expect(resolveSourceBrokerAddress('mqtt_bridge', undefined)).toBeNull();
  });

  describe('mqtt_bridge', () => {
    it('extracts host:port from the upstream URL', () => {
      expect(
        resolveSourceBrokerAddress('mqtt_bridge', { upstream: { url: 'mqtt://192.168.1.5:1883' } }),
      ).toBe('192.168.1.5:1883');
    });

    it('extracts bare host when the URL has no explicit port', () => {
      expect(
        resolveSourceBrokerAddress('mqtt_bridge', { upstream: { url: 'mqtts://mqtt.meshtastic.org' } }),
      ).toBe('mqtt.meshtastic.org');
    });

    it('returns null for a missing/empty/invalid upstream url', () => {
      expect(resolveSourceBrokerAddress('mqtt_bridge', {})).toBeNull();
      expect(resolveSourceBrokerAddress('mqtt_bridge', { upstream: {} })).toBeNull();
      expect(resolveSourceBrokerAddress('mqtt_bridge', { upstream: { url: '' } })).toBeNull();
      expect(resolveSourceBrokerAddress('mqtt_bridge', { upstream: { url: 'not a url' } })).toBeNull();
    });
  });

  describe('mqtt_broker', () => {
    it('returns the explicit listener host when it is a real address', () => {
      expect(
        resolveSourceBrokerAddress('mqtt_broker', { listener: { port: 1883, host: '192.168.1.5' } }),
      ).toBe('192.168.1.5');
    });

    it('returns null for wildcard binds and unset host', () => {
      expect(resolveSourceBrokerAddress('mqtt_broker', { listener: { port: 1883 } })).toBeNull();
      expect(
        resolveSourceBrokerAddress('mqtt_broker', { listener: { port: 1883, host: '0.0.0.0' } }),
      ).toBeNull();
      expect(
        resolveSourceBrokerAddress('mqtt_broker', { listener: { port: 1883, host: '::' } }),
      ).toBeNull();
    });
  });
});

describe('classifySourceBrokerAddress', () => {
  it('composes resolveSourceBrokerAddress and classifyBrokerAddress', () => {
    expect(
      classifySourceBrokerAddress('mqtt_bridge', { upstream: { url: 'mqtt://192.168.1.5:1883' } }),
    ).toBe('private');
    expect(
      classifySourceBrokerAddress('mqtt_bridge', { upstream: { url: 'mqtt://mqtt.example.com' } }),
    ).toBe('unknown');
    expect(
      classifySourceBrokerAddress('mqtt_bridge', { upstream: { url: 'mqtt://mqtt.meshtastic.org' } }),
    ).toBe('public');
    expect(classifySourceBrokerAddress('meshtastic_tcp', {})).toBe('unknown');
  });
});

describe('combineBrokerClasses', () => {
  it('returns unknown for an empty list', () => {
    expect(combineBrokerClasses([])).toBe('unknown');
  });

  it('returns private only when every class is private', () => {
    expect(combineBrokerClasses(['private'])).toBe('private');
    expect(combineBrokerClasses(['private', 'private'])).toBe('private');
  });

  it('public wins over everything else', () => {
    expect(combineBrokerClasses(['private', 'public'])).toBe('public');
    expect(combineBrokerClasses(['unknown', 'public'])).toBe('public');
    expect(combineBrokerClasses(['public'])).toBe('public');
  });

  it('any unknown without a public makes the combination unknown', () => {
    expect(combineBrokerClasses(['private', 'unknown'])).toBe('unknown');
    expect(combineBrokerClasses(['unknown'])).toBe('unknown');
  });
});
