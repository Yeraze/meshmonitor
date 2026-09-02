/**
 * Pure unit tests for `normalizeObserverBrokers` / `observerBrokerKey` /
 * `observerConfigFromSource` (#5014 Phase 1 WP1).
 *
 * Covers docs/internal/dev-notes/MESHMAPPER_OBSERVER_PHASE1_SPEC.md §6.1,
 * tests 1-9. No DB, no mocks needed — these functions are pure.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeObserverBrokers,
  observerBrokerKey,
  observerConfigFromSource,
  type MeshCoreObserverConfig,
  type MeshCoreSourceConfig,
} from './meshcoreConfig.js';

describe('observerBrokerKey', () => {
  it('normalizes and lowercases the URL', () => {
    expect(observerBrokerKey('Broker.Test:8883')).toBe('mqtts://broker.test:8883');
    expect(observerBrokerKey('MQTT://Broker.Test:1883')).toBe('mqtt://broker.test:1883');
  });

  it('is case-insensitive: two spellings of the same broker produce the same key', () => {
    expect(observerBrokerKey('broker.test:8883')).toBe(observerBrokerKey('BROKER.TEST:8883'));
  });
});

describe('normalizeObserverBrokers', () => {
  // ── Test 1: legacy config normalizes to one broker ─────────────────────
  it('normalizes a legacy config to one broker, flat mirrors intact', () => {
    const o: MeshCoreObserverConfig = {
      enabled: true,
      brokerUrl: 'mqtts://broker.test:8883',
      iataCode: 'MCO',
      tokenAudience: 'my-aud',
    };
    const brokers = normalizeObserverBrokers(o);
    expect(brokers).toHaveLength(1);
    expect(brokers[0].legacy).toBe(true);
    expect(brokers[0].key).toBe(observerBrokerKey(o.brokerUrl!));
    expect(brokers[0].url).toBe('mqtts://broker.test:8883');
    expect(brokers[0].authMode).toBe('token');
    expect(brokers[0].tokenAudience).toBe('my-aud');

    const runtime = observerConfigFromSource({ observer: o } as MeshCoreSourceConfig);
    expect(runtime?.brokerUrl).toBe('mqtts://broker.test:8883');
    expect(runtime?.authMode).toBe('token');
    expect(runtime?.tokenAudience).toBe('my-aud');
  });

  // ── Test 2: legacy password-mode config ─────────────────────────────────
  it('normalizes a legacy password-mode config with no audience, still enabled', () => {
    const o: MeshCoreObserverConfig = {
      enabled: true,
      authMode: 'password',
      brokerUrl: 'mqtt://broker.test:1883',
      iataCode: 'ALA',
    };
    const brokers = normalizeObserverBrokers(o);
    expect(brokers).toHaveLength(1);
    expect(brokers[0].authMode).toBe('password');
    expect(brokers[0].tokenAudience).toBeUndefined();

    const runtime = observerConfigFromSource({ observer: o } as MeshCoreSourceConfig);
    expect(runtime?.enabled).toBe(true);
    expect(runtime?.authMode).toBe('password');
    expect(runtime?.tokenAudience).toBeUndefined();
  });

  // ── Test 3: brokers[] wins over brokerUrl ────────────────────────────────
  it('uses brokers[] exclusively when present and non-empty; the legacy URL does not appear', () => {
    const o: MeshCoreObserverConfig = {
      enabled: true,
      brokerUrl: 'mqtt://legacy.test:1883',
      tokenAudience: 'legacy-aud',
      iataCode: 'MCO',
      brokers: [{ url: 'mqtt://multi.test:1883', tokenAudience: 'multi-aud' }],
    };
    const brokers = normalizeObserverBrokers(o);
    expect(brokers).toHaveLength(1);
    expect(brokers[0].url).toBe('mqtt://multi.test:1883');
    expect(brokers.some((b) => b.key === observerBrokerKey('mqtt://legacy.test:1883'))).toBe(false);
  });

  // ── Test 4: legacy flag survives the UI migration ───────────────────────
  it('flags the entry matching the legacy brokerUrl as legacy, others not', () => {
    const o: MeshCoreObserverConfig = {
      enabled: true,
      brokerUrl: 'mqtt://x.test:1883',
      iataCode: 'MCO',
      brokers: [
        { url: 'mqtt://x.test:1883', tokenAudience: 'aud-x' },
        { url: 'mqtt://y.test:1883', tokenAudience: 'aud-y' },
      ],
    };
    const brokers = normalizeObserverBrokers(o);
    expect(brokers).toHaveLength(2);
    const x = brokers.find((b) => b.url === 'mqtt://x.test:1883');
    const y = brokers.find((b) => b.url === 'mqtt://y.test:1883');
    expect(x?.legacy).toBe(true);
    expect(y?.legacy).toBe(false);
  });

  // ── Test 5: dedupe ────────────────────────────────────────────────────────
  it('dedupes two entries whose URLs normalize identically, first wins', () => {
    const o: MeshCoreObserverConfig = {
      enabled: true,
      iataCode: 'MCO',
      brokers: [
        { url: 'broker.test:1883', tokenAudience: 'first' },
        { url: 'mqtt://broker.test:1883', tokenAudience: 'second' },
      ],
    };
    const brokers = normalizeObserverBrokers(o);
    expect(brokers).toHaveLength(1);
    expect(brokers[0].tokenAudience).toBe('first');
  });

  // ── Test 6: per-entry auth mode + audience ──────────────────────────────
  describe('per-entry auth mode and audience', () => {
    it('entry-level authMode wins over the block-level default', () => {
      const o: MeshCoreObserverConfig = {
        enabled: true,
        authMode: 'token',
        iataCode: 'MCO',
        brokers: [{ url: 'mqtt://a.test:1883', authMode: 'password' }],
      };
      const brokers = normalizeObserverBrokers(o);
      expect(brokers).toHaveLength(1);
      expect(brokers[0].authMode).toBe('password');
    });

    it('block-level authMode is the default for an entry that omits its own', () => {
      const o: MeshCoreObserverConfig = {
        enabled: true,
        authMode: 'password',
        iataCode: 'MCO',
        brokers: [{ url: 'mqtt://a.test:1883' }],
      };
      const brokers = normalizeObserverBrokers(o);
      expect(brokers).toHaveLength(1);
      expect(brokers[0].authMode).toBe('password');
    });

    it('block-level tokenAudience does NOT leak into a non-legacy brokers[] entry (password mode proves no value crosses over)', () => {
      const o: MeshCoreObserverConfig = {
        enabled: true,
        tokenAudience: 'BLOCK-LEVEL-AUD',
        iataCode: 'MCO',
        brokers: [{ url: 'mqtt://a.test:1883', authMode: 'password' }],
      };
      const brokers = normalizeObserverBrokers(o);
      expect(brokers).toHaveLength(1);
      expect(brokers[0].tokenAudience).toBeUndefined();
    });

    it('block-level tokenAudience does NOT leak into a token-mode non-legacy entry — it is dropped instead of inheriting', () => {
      const o: MeshCoreObserverConfig = {
        enabled: true,
        tokenAudience: 'BLOCK-LEVEL-AUD',
        iataCode: 'MCO',
        brokers: [{ url: 'mqtt://a.test:1883' }], // token mode (default), no own audience
      };
      const brokers = normalizeObserverBrokers(o);
      expect(brokers).toHaveLength(0);
    });
  });

  // ── Test 7: one bad broker does not kill the rest ───────────────────────
  it('drops an unnormalizable URL and a token-mode entry with no audience, keeping the rest', () => {
    const o: MeshCoreObserverConfig = {
      enabled: true,
      iataCode: 'MCO',
      brokers: [
        { url: '', tokenAudience: 'unused' }, // no usable url -> skipped
        { url: 'mqtt://no-audience.test:1883' }, // token mode, no audience -> skipped
        { url: 'mqtt://good.test:1883', tokenAudience: 'good-aud' },
      ],
    };
    const brokers = normalizeObserverBrokers(o);
    expect(brokers).toHaveLength(1);
    expect(brokers[0].url).toBe('mqtt://good.test:1883');
  });

  // ── Test 8: disabling rules ──────────────────────────────────────────────
  describe('observerConfigFromSource disabling rules', () => {
    it('returns undefined when enabled is false', () => {
      expect(
        observerConfigFromSource({
          observer: { enabled: false, brokerUrl: 'mqtt://a.test:1883', iataCode: 'MCO', tokenAudience: 'aud' },
        } as MeshCoreSourceConfig),
      ).toBeUndefined();
    });

    it('returns undefined when iataCode is missing', () => {
      expect(
        observerConfigFromSource({
          observer: { enabled: true, brokerUrl: 'mqtt://a.test:1883', tokenAudience: 'aud' },
        } as MeshCoreSourceConfig),
      ).toBeUndefined();
    });

    it('returns undefined when brokers is [] and there is no brokerUrl', () => {
      expect(
        observerConfigFromSource({
          observer: { enabled: true, iataCode: 'MCO', brokers: [] },
        } as MeshCoreSourceConfig),
      ).toBeUndefined();
    });
  });

  // ── Test 9: order is preserved ───────────────────────────────────────────
  it('preserves broker order in the normalized list', () => {
    const o: MeshCoreObserverConfig = {
      enabled: true,
      iataCode: 'MCO',
      brokers: [
        { url: 'mqtt://c.test:1883', tokenAudience: 'c' },
        { url: 'mqtt://a.test:1883', tokenAudience: 'a' },
        { url: 'mqtt://b.test:1883', tokenAudience: 'b' },
      ],
    };
    const brokers = normalizeObserverBrokers(o);
    expect(brokers.map((b) => b.url)).toEqual([
      'mqtt://c.test:1883',
      'mqtt://a.test:1883',
      'mqtt://b.test:1883',
    ]);
  });

  it('returns [] for a null/undefined observer block', () => {
    expect(normalizeObserverBrokers(undefined)).toEqual([]);
    expect(normalizeObserverBrokers(null)).toEqual([]);
  });
});
