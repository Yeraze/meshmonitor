/**
 * Direct, table-driven tests for `validateObserverConfig` (#4457 Phase 1 WP2).
 *
 * Synchronous validator — no DB, no harness needed. Covers every row of
 * docs/internal/dev-notes/MESHCORE_OBSERVER_PHASE1_SPEC.md §5.1, in order,
 * including the load-bearing ordering assertion: key-material rejection runs
 * before both the `type !== 'meshcore'` check and the `enabled !== true`
 * short-circuit.
 */
import { describe, it, expect, vi } from 'vitest';

// validateObserverConfig itself never touches the DB, but importing
// sourceRoutes.ts pulls in databaseService at module scope. Stub it the same
// way sourceRoutes.virtualNode.test.ts does for validateVirtualNodeConfig, so
// this file stays a pure unit test with no real :memory: DB spin-up.
vi.mock('../../services/database.js', () => ({
  default: { sources: { getAllSources: vi.fn().mockResolvedValue([]) } },
}));

const { validateObserverConfig } = await import('./sourceRoutes.js');

const VALID_OBSERVER = {
  enabled: true,
  brokerUrl: 'mqtts://host:8883',
  iataCode: 'MCO',
  tokenAudience: 'my-aud',
};

describe('validateObserverConfig', () => {
  // ── Row 1: absent block ──────────────────────────────────────────────────
  it('returns null when config.observer is undefined', () => {
    expect(validateObserverConfig('meshcore', {})).toBeNull();
  });

  it('returns null when config.observer is null', () => {
    expect(validateObserverConfig('meshcore', { observer: null })).toBeNull();
  });

  it('returns null when config itself is undefined', () => {
    expect(validateObserverConfig('meshcore', undefined)).toBeNull();
  });

  // ── Row 2: observer is not an object ─────────────────────────────────────
  it('rejects a non-object observer value (string)', () => {
    const err = validateObserverConfig('meshcore', { observer: 'nope' });
    expect(err).toEqual({ status: 400, error: 'observer must be an object', code: 'INVALID_PARAMETER_TYPE' });
  });

  it('rejects a non-object observer value (number)', () => {
    const err = validateObserverConfig('meshcore', { observer: 42 });
    expect(err?.code).toBe('INVALID_PARAMETER_TYPE');
  });

  it('rejects an array observer value', () => {
    const err = validateObserverConfig('meshcore', { observer: [] });
    expect(err?.code).toBe('INVALID_PARAMETER_TYPE');
  });

  // ── Row 3: key-material rejection, and its ordering guarantee ────────────
  describe('key-material rejection (ordering)', () => {
    const keyFields = ['privateKey', 'privateKeyHex', 'signingKey', 'key', 'secret'] as const;

    it.each(keyFields)('rejects observer.%s when observer is otherwise valid and enabled', (field) => {
      const err = validateObserverConfig('meshcore', {
        observer: { ...VALID_OBSERVER, [field]: 'deadbeef' },
      });
      expect(err).toEqual({
        status: 400,
        error: 'observer config must not contain key material; use POST /api/sources/:id/observer/key',
        code: 'OBSERVER_KEY_IN_CONFIG',
      });
    });

    it('rejects key material even when enabled is false', () => {
      const err = validateObserverConfig('meshcore', {
        observer: { enabled: false, privateKey: 'deadbeef' },
      });
      expect(err?.code).toBe('OBSERVER_KEY_IN_CONFIG');
    });

    it('rejects key material even when enabled is absent', () => {
      const err = validateObserverConfig('meshcore', {
        observer: { privateKey: 'deadbeef' },
      });
      expect(err?.code).toBe('OBSERVER_KEY_IN_CONFIG');
    });

    it('rejects key material even on a non-meshcore source type (runs before the type check)', () => {
      const err = validateObserverConfig('meshtastic_tcp', {
        observer: { enabled: true, privateKey: 'deadbeef' },
      });
      expect(err?.code).toBe('OBSERVER_KEY_IN_CONFIG');
    });

    it('rejects key material on a non-meshcore, disabled block (both short-circuits pre-empted)', () => {
      const err = validateObserverConfig('mqtt_broker', {
        observer: { enabled: false, secret: 'shh' },
      });
      expect(err?.code).toBe('OBSERVER_KEY_IN_CONFIG');
    });
  });

  // ── Row 4: type !== 'meshcore' ────────────────────────────────────────────
  it('rejects a meshtastic_tcp source when observer has no key material', () => {
    const err = validateObserverConfig('meshtastic_tcp', { observer: VALID_OBSERVER });
    expect(err).toEqual({
      status: 400,
      error: 'observer config is only supported on meshcore sources',
      code: 'INVALID_PARAMETER',
    });
  });

  it('rejects an mqtt_broker source when observer has no key material', () => {
    const err = validateObserverConfig('mqtt_broker', { observer: VALID_OBSERVER });
    expect(err?.code).toBe('INVALID_PARAMETER');
  });

  // ── Row 5: enabled !== true → null (matches the VN pattern) ──────────────
  it('returns null when enabled is false on a meshcore source', () => {
    expect(
      validateObserverConfig('meshcore', { observer: { ...VALID_OBSERVER, enabled: false } }),
    ).toBeNull();
  });

  it('returns null when enabled is absent on a meshcore source', () => {
    const { enabled: _enabled, ...rest } = VALID_OBSERVER;
    expect(validateObserverConfig('meshcore', { observer: rest })).toBeNull();
  });

  it('returns null when enabled is truthy but not === true', () => {
    expect(
      validateObserverConfig('meshcore', { observer: { ...VALID_OBSERVER, enabled: 1 as unknown as boolean } }),
    ).toBeNull();
  });

  // ── Row 6: deviceType === 'repeater' ──────────────────────────────────────
  it('rejects an enabled observer block on a repeater deviceType', () => {
    const err = validateObserverConfig('meshcore', {
      deviceType: 'repeater',
      observer: VALID_OBSERVER,
    });
    expect(err).toEqual({
      status: 400,
      error: 'the Analyzer Observer requires a Companion device; repeaters cannot export a signing key',
      code: 'OBSERVER_REQUIRES_COMPANION',
    });
  });

  it('allows a disabled observer block on a repeater deviceType (short-circuited by row 5 first)', () => {
    const err = validateObserverConfig('meshcore', {
      deviceType: 'repeater',
      observer: { ...VALID_OBSERVER, enabled: false },
    });
    expect(err).toBeNull();
  });

  // ── Row 7: brokerUrl must be a non-empty string ───────────────────────────
  it('rejects a missing brokerUrl', () => {
    const { brokerUrl: _brokerUrl, ...rest } = VALID_OBSERVER;
    const err = validateObserverConfig('meshcore', { observer: rest });
    expect(err?.code).toBe('INVALID_PARAMETER');
  });

  it('rejects an empty-string brokerUrl', () => {
    const err = validateObserverConfig('meshcore', { observer: { ...VALID_OBSERVER, brokerUrl: '' } });
    expect(err?.code).toBe('INVALID_PARAMETER');
  });

  it('rejects a non-string brokerUrl', () => {
    const err = validateObserverConfig('meshcore', {
      observer: { ...VALID_OBSERVER, brokerUrl: 1234 as unknown as string },
    });
    expect(err?.code).toBe('INVALID_PARAMETER');
  });

  // ── Row 8: brokerUrl must parse to an allowed ws/wss/mqtt/mqtts URL ───────
  describe('brokerUrl scheme/shape validation', () => {
    it('accepts a bare host:port and normalizes it via normalizeBrokerUrl', () => {
      const err = validateObserverConfig('meshcore', {
        observer: { ...VALID_OBSERVER, brokerUrl: 'broker.example.com:8883' },
      });
      expect(err).toBeNull();
    });

    it('accepts an explicit mqtt:// URL', () => {
      const err = validateObserverConfig('meshcore', {
        observer: { ...VALID_OBSERVER, brokerUrl: 'mqtt://broker.example.com:1883' },
      });
      expect(err).toBeNull();
    });

    it('accepts an explicit ws:// URL', () => {
      const err = validateObserverConfig('meshcore', {
        observer: { ...VALID_OBSERVER, brokerUrl: 'ws://broker.example.com' },
      });
      expect(err).toBeNull();
    });

    it('rejects an explicit tcp:// scheme (passes normalizeBrokerUrl unchanged, then fails the protocol allow-list)', () => {
      const err = validateObserverConfig('meshcore', {
        observer: { ...VALID_OBSERVER, brokerUrl: 'tcp://broker.example.com' },
      });
      expect(err).toEqual({
        status: 400,
        error: 'observer.brokerUrl must be a ws/wss/mqtt/mqtts URL',
        code: 'INVALID_BROKER_URL',
      });
    });

    it('rejects a value that fails URL parsing after normalization (non-numeric port)', () => {
      const err = validateObserverConfig('meshcore', {
        observer: { ...VALID_OBSERVER, brokerUrl: 'mqtt://host:notaport' },
      });
      expect(err?.code).toBe('INVALID_BROKER_URL');
    });

    it('rejects a whitespace-only brokerUrl (normalizes to an empty hostname)', () => {
      const err = validateObserverConfig('meshcore', {
        observer: { ...VALID_OBSERVER, brokerUrl: '   ' },
      });
      expect(err?.code).toBe('INVALID_BROKER_URL');
    });

    // Documented quirk, not a WP2 regression: normalizeBrokerUrl (reused
    // as-is per spec §1.10 — not owned by this work package) only recognizes
    // mqtt/mqtts/ws/wss/tcp/tls as explicit passthrough schemes. Any other
    // bare word (or an explicit foreign scheme like http://) falls through to
    // its "bare host" branch and gets prefixed with mqtt://, so it parses as a
    // syntactically valid (if semantically nonsensical) mqtt:// hostname. This
    // is pre-existing behavior in the shared, reused utility — recorded here
    // rather than silently left untested.
    it('treats a bare unscoped word as a literal (if nonsensical) mqtt hostname — known normalizeBrokerUrl passthrough quirk', () => {
      const err = validateObserverConfig('meshcore', {
        observer: { ...VALID_OBSERVER, brokerUrl: 'garbage' },
      });
      expect(err).toBeNull();
    });
  });

  // ── Row 9: iataCode ────────────────────────────────────────────────────────
  describe('iataCode validation', () => {
    it.each(['ab', 'abcd', '1234', '', 'a1c'])('rejects invalid iataCode %j', (iataCode) => {
      const err = validateObserverConfig('meshcore', { observer: { ...VALID_OBSERVER, iataCode } });
      expect(err).toEqual({
        status: 400,
        error: "observer.iataCode must be a 3-letter IATA code or 'test'",
        code: 'INVALID_IATA_CODE',
      });
    });

    it('accepts a 3-letter IATA code', () => {
      expect(validateObserverConfig('meshcore', { observer: { ...VALID_OBSERVER, iataCode: 'MCO' } })).toBeNull();
    });

    it('accepts lowercase 3-letter IATA code', () => {
      expect(validateObserverConfig('meshcore', { observer: { ...VALID_OBSERVER, iataCode: 'mco' } })).toBeNull();
    });

    it("accepts the literal 'test'", () => {
      expect(validateObserverConfig('meshcore', { observer: { ...VALID_OBSERVER, iataCode: 'test' } })).toBeNull();
    });

    it("accepts 'TEST' case-insensitively", () => {
      expect(validateObserverConfig('meshcore', { observer: { ...VALID_OBSERVER, iataCode: 'TEST' } })).toBeNull();
    });
  });

  // ── Row 10: tokenAudience ──────────────────────────────────────────────────
  describe('tokenAudience validation', () => {
    it('rejects an empty tokenAudience', () => {
      const err = validateObserverConfig('meshcore', { observer: { ...VALID_OBSERVER, tokenAudience: '' } });
      expect(err).toEqual({
        status: 400,
        error: 'observer.tokenAudience must be a non-empty string with no whitespace',
        code: 'INVALID_PARAMETER',
      });
    });

    it('rejects a whitespace-only tokenAudience', () => {
      const err = validateObserverConfig('meshcore', { observer: { ...VALID_OBSERVER, tokenAudience: '   ' } });
      expect(err?.code).toBe('INVALID_PARAMETER');
    });

    it('rejects a tokenAudience containing internal whitespace', () => {
      const err = validateObserverConfig('meshcore', {
        observer: { ...VALID_OBSERVER, tokenAudience: 'my aud' },
      });
      expect(err?.code).toBe('INVALID_PARAMETER');
    });

    it('rejects a tokenAudience longer than 255 chars', () => {
      const err = validateObserverConfig('meshcore', {
        observer: { ...VALID_OBSERVER, tokenAudience: 'a'.repeat(256) },
      });
      expect(err?.code).toBe('INVALID_PARAMETER');
    });

    it('accepts a tokenAudience of exactly 255 chars', () => {
      expect(
        validateObserverConfig('meshcore', {
          observer: { ...VALID_OBSERVER, tokenAudience: 'a'.repeat(255) },
        }),
      ).toBeNull();
    });

    it('rejects a non-string tokenAudience', () => {
      const err = validateObserverConfig('meshcore', {
        observer: { ...VALID_OBSERVER, tokenAudience: 123 as unknown as string },
      });
      expect(err?.code).toBe('INVALID_PARAMETER');
    });
  });

  // ── Fully-valid pass-through ───────────────────────────────────────────────
  it('returns null for a fully valid, enabled observer config on a companion meshcore source', () => {
    expect(
      validateObserverConfig('meshcore', { deviceType: 'companion', observer: VALID_OBSERVER }),
    ).toBeNull();
  });
});
