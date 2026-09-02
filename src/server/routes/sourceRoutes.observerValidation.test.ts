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
    // `password` joined the list in #4595 — the static-credential broker
    // password belongs in `meshcore_observer_credentials`, not the config blob.
    const keyFields = ['privateKey', 'privateKeyHex', 'signingKey', 'key', 'secret', 'password'] as const;

    it.each(keyFields)('rejects observer.%s when observer is otherwise valid and enabled', (field) => {
      const err = validateObserverConfig('meshcore', {
        observer: { ...VALID_OBSERVER, [field]: 'deadbeef' },
      });
      expect(err).toEqual({
        status: 400,
        error:
          'observer config must not contain key material or a broker password; use ' +
          'PUT /api/sources/:id/observer/key or PUT /api/sources/:id/observer/credentials',
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

    it('rejects an explicit tcp:// scheme (caught by the pre-normalization scheme allow-list)', () => {
      const err = validateObserverConfig('meshcore', {
        observer: { ...VALID_OBSERVER, brokerUrl: 'tcp://broker.example.com' },
      });
      expect(err).toEqual({
        status: 400,
        error: 'observer.brokerUrl must be a ws/wss/mqtt/mqtts URL',
        code: 'INVALID_BROKER_URL',
      });
    });

    it('rejects an explicit tls:// scheme (caught by the pre-normalization scheme allow-list)', () => {
      const err = validateObserverConfig('meshcore', {
        observer: { ...VALID_OBSERVER, brokerUrl: 'tls://broker.example.com' },
      });
      expect(err?.code).toBe('INVALID_BROKER_URL');
    });

    // Regression guard for the WP2 review follow-up (#4457): normalizeBrokerUrl
    // (shared with the Phase 2 MQTT client — must not be modified here) only
    // recognizes mqtt/mqtts/ws/wss/tcp/tls as an explicit passthrough scheme.
    // Before this fix, an explicit foreign scheme like http:// or https://
    // fell through its "bare host" branch and got silently prefixed with
    // mqtt://, laundering a bad scheme into an apparently-valid mqtt:// URL
    // (e.g. "http://broker.example" normalized to "mqtt://http://broker.example",
    // hostname "http" — a footgun the Phase 3 UI would have inherited).
    // validateObserverConfig now rejects any explicit "scheme://" prefix that
    // isn't ws/wss/mqtt/mqtts BEFORE calling normalizeBrokerUrl at all.
    it('rejects an explicit http:// scheme instead of silently laundering it into mqtt://', () => {
      const err = validateObserverConfig('meshcore', {
        observer: { ...VALID_OBSERVER, brokerUrl: 'http://broker.example' },
      });
      expect(err).toEqual({
        status: 400,
        error: 'observer.brokerUrl must be a ws/wss/mqtt/mqtts URL',
        code: 'INVALID_BROKER_URL',
      });
    });

    it('rejects an explicit https:// scheme instead of silently laundering it into mqtt://', () => {
      const err = validateObserverConfig('meshcore', {
        observer: { ...VALID_OBSERVER, brokerUrl: 'https://broker.example' },
      });
      expect(err?.code).toBe('INVALID_BROKER_URL');
    });

    it('rejects an explicit scheme case-insensitively (MQTT:// uppercase is still allowed, HTTP:// is still rejected)', () => {
      expect(
        validateObserverConfig('meshcore', {
          observer: { ...VALID_OBSERVER, brokerUrl: 'MQTT://broker.example.com:1883' },
        }),
      ).toBeNull();
      const err = validateObserverConfig('meshcore', {
        observer: { ...VALID_OBSERVER, brokerUrl: 'HTTP://broker.example' },
      });
      expect(err?.code).toBe('INVALID_BROKER_URL');
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

    // Bare-host input (no "://" at all) is unaffected by the scheme-allow-list
    // fix above and still passes through to normalizeBrokerUrl unchanged: a
    // syntactically valid (if semantically nonsensical) literal hostname is
    // still accepted, since MQTT brokers commonly have single-word hostnames
    // on private networks (e.g. "mosquitto"). Only an explicit disallowed
    // scheme is rejected now, not a schemeless bare word.
    it('still treats a bare unscoped word (no "://") as a literal mqtt hostname', () => {
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

  // ── authMode / static credentials (#4595) ─────────────────────────────────
  describe('authMode (#4595)', () => {
    it('accepts an absent authMode (back-compat: means token)', () => {
      expect(validateObserverConfig('meshcore', { observer: VALID_OBSERVER })).toBeNull();
    });

    it("accepts authMode 'token' and 'password'", () => {
      expect(
        validateObserverConfig('meshcore', { observer: { ...VALID_OBSERVER, authMode: 'token' } }),
      ).toBeNull();
      expect(
        validateObserverConfig('meshcore', { observer: { ...VALID_OBSERVER, authMode: 'password' } }),
      ).toBeNull();
    });

    it('rejects any other authMode', () => {
      const err = validateObserverConfig('meshcore', {
        observer: { ...VALID_OBSERVER, authMode: 'oauth' },
      });
      expect(err?.status).toBe(400);
      expect(err?.code).toBe('INVALID_OBSERVER_AUTH_MODE');
    });

    it('rejects a bad authMode even on a DISABLED block (fail early, not on enable)', () => {
      const err = validateObserverConfig('meshcore', {
        observer: { ...VALID_OBSERVER, enabled: false, authMode: 'nope' },
      });
      expect(err?.code).toBe('INVALID_OBSERVER_AUTH_MODE');
    });

    it('password mode does not require a tokenAudience', () => {
      expect(
        validateObserverConfig('meshcore', {
          observer: { enabled: true, authMode: 'password', brokerUrl: 'mqtt://host:1883', iataCode: 'ALA' },
        }),
      ).toBeNull();
      expect(
        validateObserverConfig('meshcore', {
          observer: {
            enabled: true,
            authMode: 'password',
            brokerUrl: 'mqtt://host:1883',
            iataCode: 'ALA',
            tokenAudience: '',
          },
        }),
      ).toBeNull();
    });

    it('password mode still shape-checks a tokenAudience when one IS present', () => {
      const err = validateObserverConfig('meshcore', {
        observer: { ...VALID_OBSERVER, authMode: 'password', tokenAudience: 'has space' },
      });
      expect(err?.code).toBe('INVALID_PARAMETER');
    });

    it('password mode still requires brokerUrl and iataCode', () => {
      expect(
        validateObserverConfig('meshcore', {
          observer: { enabled: true, authMode: 'password', iataCode: 'ALA' },
        })?.code,
      ).toBe('INVALID_PARAMETER');
      expect(
        validateObserverConfig('meshcore', {
          observer: { enabled: true, authMode: 'password', brokerUrl: 'mqtt://host:1883', iataCode: 'XX' },
        })?.code,
      ).toBe('INVALID_IATA_CODE');
    });

    it('token mode still requires a tokenAudience', () => {
      const err = validateObserverConfig('meshcore', {
        observer: { enabled: true, authMode: 'token', brokerUrl: 'mqtt://host:1883', iataCode: 'MCO' },
      });
      expect(err?.code).toBe('INVALID_PARAMETER');
    });

    it('rejects a broker password smuggled into the config block', () => {
      const err = validateObserverConfig('meshcore', {
        observer: { ...VALID_OBSERVER, authMode: 'password', password: 'meshcore' },
      });
      expect(err?.status).toBe(400);
      expect(err?.code).toBe('OBSERVER_KEY_IN_CONFIG');
    });

    it('rejects a password in the config even on a non-meshcore, disabled block', () => {
      const err = validateObserverConfig('mqtt_broker', {
        observer: { enabled: false, password: 'meshcore' },
      });
      expect(err?.code).toBe('OBSERVER_KEY_IN_CONFIG');
    });

    it('password mode is still Companion-only (the repeater backend emits no OTA packets)', () => {
      const err = validateObserverConfig('meshcore', {
        deviceType: 'repeater',
        observer: { ...VALID_OBSERVER, authMode: 'password' },
      });
      expect(err?.code).toBe('OBSERVER_REQUIRES_COMPANION');
    });
  });

  // ── Fully-valid pass-through ───────────────────────────────────────────────
  it('returns null for a fully valid, enabled observer config on a companion meshcore source', () => {
    expect(
      validateObserverConfig('meshcore', { deviceType: 'companion', observer: VALID_OBSERVER }),
    ).toBeNull();
  });

  // ── Multi-broker (#5014 Phase 1) ───────────────────────────────────────────
  describe('brokers[] (#5014 Phase 1)', () => {
    const TWO_BROKERS = {
      enabled: true,
      iataCode: 'MCO',
      brokers: [
        { url: 'wss://mqtt.meshmapper.net:443', tokenAudience: 'mqtt.meshmapper.net', label: 'MeshMapper' },
        { url: 'wss://mqtt-us-v1.letsmesh.net:443', tokenAudience: 'mqtt-us-v1.letsmesh.net', label: 'LetsMesh US' },
      ],
    };

    // ── Test 10 ───────────────────────────────────────────────────────────
    it('accepts a valid two-broker config', () => {
      expect(validateObserverConfig('meshcore', { observer: TWO_BROKERS })).toBeNull();
    });

    // ── Test 11 ───────────────────────────────────────────────────────────
    it('rejects a non-array brokers value', () => {
      const err = validateObserverConfig('meshcore', {
        observer: { ...TWO_BROKERS, brokers: 'nope' },
      });
      expect(err).toEqual({ status: 400, error: 'observer.brokers must be an array', code: 'INVALID_PARAMETER_TYPE' });
    });

    it('rejects 9 brokers with TOO_MANY_BROKERS', () => {
      const nine = Array.from({ length: 9 }, () => ({}));
      const err = validateObserverConfig('meshcore', {
        observer: { enabled: true, iataCode: 'MCO', brokers: nine },
      });
      expect(err?.code).toBe('TOO_MANY_BROKERS');
    });

    it('rejects a non-object entry', () => {
      const err = validateObserverConfig('meshcore', {
        observer: { ...TWO_BROKERS, brokers: [TWO_BROKERS.brokers[0], 'nope'] },
      });
      expect(err?.code).toBe('INVALID_PARAMETER_TYPE');
    });

    it('rejects an http:// entry URL with INVALID_BROKER_URL, proving the scheme pre-check survived the extraction', () => {
      const err = validateObserverConfig('meshcore', {
        observer: {
          enabled: true,
          iataCode: 'MCO',
          brokers: [{ url: 'http://broker.example', tokenAudience: 'aud' }],
        },
      });
      expect(err).toEqual({
        status: 400,
        error: 'observer.brokers[0].url must be a ws/wss/mqtt/mqtts URL',
        code: 'INVALID_BROKER_URL',
      });
    });

    it('rejects a token-mode entry with no audience', () => {
      const err = validateObserverConfig('meshcore', {
        observer: { enabled: true, iataCode: 'MCO', brokers: [{ url: 'mqtt://broker.test:1883' }] },
      });
      expect(err?.code).toBe('INVALID_PARAMETER');
    });

    it('rejects a label over 64 chars', () => {
      const err = validateObserverConfig('meshcore', {
        observer: {
          enabled: true,
          iataCode: 'MCO',
          brokers: [{ url: 'mqtt://broker.test:1883', tokenAudience: 'aud', label: 'x'.repeat(65) }],
        },
      });
      expect(err?.code).toBe('INVALID_PARAMETER');
    });

    it('rejects two entries with the same normalized URL', () => {
      const err = validateObserverConfig('meshcore', {
        observer: {
          enabled: true,
          iataCode: 'MCO',
          brokers: [
            { url: 'broker.test:1883', tokenAudience: 'a' },
            { url: 'mqtt://broker.test:1883', tokenAudience: 'b' },
          ],
        },
      });
      expect(err?.code).toBe('DUPLICATE_BROKER_URL');
    });

    it('rejects an entry carrying a password, and fires even when enabled is false', () => {
      const err = validateObserverConfig('meshcore', {
        observer: {
          enabled: false,
          iataCode: 'MCO',
          brokers: [{ url: 'mqtt://broker.test:1883', password: 'meshcore' }],
        },
      });
      expect(err?.code).toBe('OBSERVER_KEY_IN_CONFIG');
    });

    // ── Test 12 ───────────────────────────────────────────────────────────
    it('accepts enabled:true with brokers[] and no brokerUrl (the MISSING_BROKER relaxation)', () => {
      expect(validateObserverConfig('meshcore', { observer: TWO_BROKERS })).toBeNull();
    });

    it('rejects enabled:true with neither a usable brokerUrl nor a non-empty brokers[] (MISSING_BROKER)', () => {
      const err = validateObserverConfig('meshcore', {
        observer: { enabled: true, iataCode: 'MCO', brokers: [] },
      });
      expect(err).toEqual({
        status: 400,
        error: 'observer requires either brokerUrl or a non-empty brokers array',
        code: 'MISSING_BROKER',
      });
    });

    // ── Test 13: every pre-existing assertion in this file still passes ────
    // (asserted implicitly — this whole file is that regression suite; see
    // the rows above this describe block, all unmodified.)

    // ── Test 14: observer block size cap ────────────────────────────────────
    describe('observer block size cap (MAX_OBSERVER_CONFIG_BYTES)', () => {
      it('rejects an observer block over the byte cap, including when disabled', () => {
        const err = validateObserverConfig('meshcore', {
          observer: { enabled: false, padding: 'x'.repeat(2000) },
        });
        expect(err?.code).toBe('OBSERVER_CONFIG_TOO_LARGE');
      });

      it('rejects an observer block over the byte cap when enabled', () => {
        const err = validateObserverConfig('meshcore', {
          observer: { ...TWO_BROKERS, padding: 'x'.repeat(2000) },
        });
        expect(err?.code).toBe('OBSERVER_CONFIG_TOO_LARGE');
      });

      it('accepts an observer block at exactly the byte limit', () => {
        const base = { enabled: false } as Record<string, unknown>;
        const baseBytes = Buffer.byteLength(JSON.stringify(base), 'utf8');
        // Account for the extra `"padding":"..."`, key/quote/comma overhead.
        const overhead = Buffer.byteLength(JSON.stringify({ ...base, padding: '' }), 'utf8') - baseBytes;
        const paddingLen = 1536 - baseBytes - overhead;
        const withPadding = { ...base, padding: 'x'.repeat(paddingLen) };
        expect(Buffer.byteLength(JSON.stringify(withPadding), 'utf8')).toBe(1536);
        expect(validateObserverConfig('meshcore', { observer: withPadding })).toBeNull();
      });

      it('accepts a valid 8-broker observer block, which fits comfortably under the cap', () => {
        const eight = Array.from({ length: 8 }, (_, i) => ({
          url: `mqtt://b${i}.example:1883`,
          tokenAudience: `aud${i}`,
          label: `B${i}`,
        }));
        const observer = { enabled: true, iataCode: 'MCO', brokers: eight };
        expect(Buffer.byteLength(JSON.stringify(observer), 'utf8')).toBeLessThanOrEqual(1536);
        expect(validateObserverConfig('meshcore', { observer })).toBeNull();
      });

      it('pins the decision NOT to guard the whole config: a non-observer config well over 4096 bytes is accepted', () => {
        const fatMqttBridgeConfig = {
          upstream: { url: 'mqtt://broker.test:1883' },
          topicRewrites: Array.from({ length: 50 }, (_, i) => ({
            from: `from/topic/${i}/${'x'.repeat(50)}`,
            to: `to/topic/${i}/${'y'.repeat(50)}`,
          })),
        };
        expect(Buffer.byteLength(JSON.stringify(fatMqttBridgeConfig), 'utf8')).toBeGreaterThan(4096);
        expect(validateObserverConfig('mqtt_bridge', fatMqttBridgeConfig)).toBeNull();
      });
    });
  });
});
