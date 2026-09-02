/**
 * Tests for the Analyzer Observer config-conversion helpers added to
 * meshcoreConfig.ts (#4457 Phase 1 WP2).
 *
 * Scope: observerConfigFromSource in isolation, plus confirmation that
 * meshcoreConfigFromSource carries `observer` on both the SERIAL and TCP
 * return branches. No publisher, no MQTT connection — see
 * docs/internal/dev-notes/MESHCORE_OBSERVER_PHASE1_SPEC.md §8.1.
 */
import { describe, it, expect } from 'vitest';
import { meshcoreConfigFromSource, observerConfigFromSource } from './meshcoreConfig.js';
import { ConnectionType } from './meshcoreManager.js';
import type { Source } from '../db/repositories/sources.js';

function fakeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: 'src-a',
    name: 'A',
    type: 'meshcore',
    config: { transport: 'usb', port: '/dev/ttyACM0', deviceType: 'companion' },
    enabled: true,
    displayOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    createdBy: null,
    ...overrides,
  };
}

describe('observerConfigFromSource', () => {
  it('returns undefined when observer is not configured', () => {
    expect(observerConfigFromSource({})).toBeUndefined();
  });

  it('returns undefined when enabled is false', () => {
    expect(
      observerConfigFromSource({
        observer: { enabled: false, brokerUrl: 'mqtts://host:8883', iataCode: 'MCO', tokenAudience: 'aud' },
      }),
    ).toBeUndefined();
  });

  it('returns undefined when enabled is absent', () => {
    expect(
      observerConfigFromSource({
        observer: { brokerUrl: 'mqtts://host:8883', iataCode: 'MCO', tokenAudience: 'aud' },
      }),
    ).toBeUndefined();
  });

  it('returns undefined when brokerUrl is missing', () => {
    expect(
      observerConfigFromSource({
        observer: { enabled: true, iataCode: 'MCO', tokenAudience: 'aud' },
      }),
    ).toBeUndefined();
  });

  it('returns undefined when iataCode is missing', () => {
    expect(
      observerConfigFromSource({
        observer: { enabled: true, brokerUrl: 'mqtts://host:8883', tokenAudience: 'aud' },
      }),
    ).toBeUndefined();
  });

  it('returns undefined when tokenAudience is missing', () => {
    expect(
      observerConfigFromSource({
        observer: { enabled: true, brokerUrl: 'mqtts://host:8883', iataCode: 'MCO' },
      }),
    ).toBeUndefined();
  });

  it('returns a normalized object when all required fields are present', () => {
    const observer = observerConfigFromSource({
      observer: { enabled: true, brokerUrl: 'mqtts://host:8883', iataCode: 'MCO', tokenAudience: 'my-aud' },
    });
    // #5014 Phase 1: brokers[] now carries the (single, legacy-synthesized)
    // broker, and the flat fields remain a mirror of brokers[0].
    expect(observer).toEqual({
      enabled: true,
      iataCode: 'MCO',
      brokers: [
        {
          key: 'mqtts://host:8883',
          url: 'mqtts://host:8883',
          authMode: 'token',
          tokenAudience: 'my-aud',
          legacy: true,
        },
      ],
      authMode: 'token',
      brokerUrl: 'mqtts://host:8883',
      tokenAudience: 'my-aud',
    });
    // Flat mirrors equal brokers[0] exactly (#5014 §2.2 contract).
    expect(observer?.brokers?.[0]).toBeDefined();
    expect(observer?.brokerUrl).toBe(observer?.brokers?.[0]?.url);
    expect(observer?.authMode).toBe(observer?.brokers?.[0]?.authMode);
    expect(observer?.tokenAudience).toBe(observer?.brokers?.[0]?.tokenAudience);
  });

  it('normalizes a bare host:port brokerUrl using normalizeBrokerUrl (mqtts for 8883)', () => {
    const observer = observerConfigFromSource({
      observer: { enabled: true, brokerUrl: 'host:8883', iataCode: 'MCO', tokenAudience: 'aud' },
    });
    expect(observer?.brokerUrl).toBe('mqtts://host:8883');
  });

  it('normalizes a bare host:port brokerUrl to mqtt when the port is not a canonical TLS port', () => {
    const observer = observerConfigFromSource({
      observer: { enabled: true, brokerUrl: 'host:1883', iataCode: 'MCO', tokenAudience: 'aud' },
    });
    expect(observer?.brokerUrl).toBe('mqtt://host:1883');
  });

  it('upper-cases iataCode', () => {
    const observer = observerConfigFromSource({
      observer: { enabled: true, brokerUrl: 'mqtts://host:8883', iataCode: 'mco', tokenAudience: 'aud' },
    });
    expect(observer?.iataCode).toBe('MCO');
  });

  it('trims tokenAudience', () => {
    const observer = observerConfigFromSource({
      observer: { enabled: true, brokerUrl: 'mqtts://host:8883', iataCode: 'MCO', tokenAudience: '  my-aud  ' },
    });
    expect(observer?.tokenAudience).toBe('my-aud');
  });
});

describe('meshcoreConfigFromSource — observer plumbing', () => {
  it('carries observer through the SERIAL (companion-USB) branch', () => {
    const cfg = meshcoreConfigFromSource(
      fakeSource({
        config: {
          transport: 'usb',
          port: '/dev/ttyACM0',
          deviceType: 'companion',
          observer: { enabled: true, brokerUrl: 'mqtts://host:8883', iataCode: 'MCO', tokenAudience: 'aud' },
        },
      }),
    );
    expect(cfg?.connectionType).toBe(ConnectionType.SERIAL);
    // #5014 Phase 1: brokers[] mirrors the flat legacy fields.
    expect(cfg?.observer).toEqual({
      enabled: true,
      iataCode: 'MCO',
      brokers: [
        { key: 'mqtts://host:8883', url: 'mqtts://host:8883', authMode: 'token', tokenAudience: 'aud', legacy: true },
      ],
      authMode: 'token',
      brokerUrl: 'mqtts://host:8883',
      tokenAudience: 'aud',
    });
    expect(cfg?.observer?.brokerUrl).toBe(cfg?.observer?.brokers?.[0]?.url);
    expect(cfg?.observer?.authMode).toBe(cfg?.observer?.brokers?.[0]?.authMode);
    expect(cfg?.observer?.tokenAudience).toBe(cfg?.observer?.brokers?.[0]?.tokenAudience);
  });

  it('carries observer through the TCP branch', () => {
    const cfg = meshcoreConfigFromSource(
      fakeSource({
        config: {
          transport: 'tcp',
          tcpHost: '10.0.0.5',
          deviceType: 'companion',
          observer: { enabled: true, brokerUrl: 'mqtts://host:8883', iataCode: 'MCO', tokenAudience: 'aud' },
        },
      }),
    );
    expect(cfg?.connectionType).toBe(ConnectionType.TCP);
    // #5014 Phase 1: brokers[] mirrors the flat legacy fields.
    expect(cfg?.observer).toEqual({
      enabled: true,
      iataCode: 'MCO',
      brokers: [
        { key: 'mqtts://host:8883', url: 'mqtts://host:8883', authMode: 'token', tokenAudience: 'aud', legacy: true },
      ],
      authMode: 'token',
      brokerUrl: 'mqtts://host:8883',
      tokenAudience: 'aud',
    });
    expect(cfg?.observer?.brokerUrl).toBe(cfg?.observer?.brokers?.[0]?.url);
    expect(cfg?.observer?.authMode).toBe(cfg?.observer?.brokers?.[0]?.authMode);
    expect(cfg?.observer?.tokenAudience).toBe(cfg?.observer?.brokers?.[0]?.tokenAudience);
  });

  it('leaves observer undefined on both branches when not configured', () => {
    const serialCfg = meshcoreConfigFromSource(
      fakeSource({ config: { transport: 'usb', port: '/dev/ttyACM0', deviceType: 'companion' } }),
    );
    expect(serialCfg?.observer).toBeUndefined();

    const tcpCfg = meshcoreConfigFromSource(
      fakeSource({ config: { transport: 'tcp', tcpHost: '10.0.0.5', deviceType: 'companion' } }),
    );
    expect(tcpCfg?.observer).toBeUndefined();
  });
});
