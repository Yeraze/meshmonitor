/**
 * Pure unit tests for DashboardPage.observerConfig.ts (#4457 Phase 3,
 * extended #5014 Phase 2 WP1). No DOM required — table-driven over spec
 * MESHMAPPER_OBSERVER_PHASE2_SPEC.md §3 (form <-> config mapping, the
 * `brokers[]` migration, `buildObserverConfig` check order) and §3.2
 * (presets) / §3.1 (observerErrorMessageKey mapping, unchanged from Phase 1).
 */
import { describe, it, expect } from 'vitest';
import {
  emptyObserverForm,
  observerFormFromConfig,
  buildObserverConfig,
  observerErrorMessageKey,
  observerBrokerFormFromPreset,
  OBSERVER_BROKER_PRESETS,
  MAX_OBSERVER_BROKERS,
  type ObserverForm,
  type ObserverBrokerForm,
} from './DashboardPage.observerConfig';

function brokerRow(overrides: Partial<ObserverBrokerForm> = {}): ObserverBrokerForm {
  return {
    id: 'row-1',
    url: 'wss://mqtt-us-v1.letsmesh.net:443',
    authMode: 'token',
    tokenAudience: 'meshcore-mqtt',
    label: '',
    ...overrides,
  };
}

function form(overrides: Partial<ObserverForm> = {}): ObserverForm {
  return {
    enabled: true,
    iataCode: 'MCO',
    brokers: [brokerRow()],
    ...overrides,
  };
}

/** Convenience: a form with a single row, some of whose fields are overridden. */
function formWithRow(
  rowOverrides: Partial<ObserverBrokerForm> = {},
  formOverrides: Partial<Omit<ObserverForm, 'brokers'>> = {},
): ObserverForm {
  return form({ brokers: [brokerRow(rowOverrides)], ...formOverrides });
}

/** Strip the client-only `id` field for equality assertions against fixed shapes. */
function withoutIds(f: ObserverForm) {
  return { ...f, brokers: f.brokers.map(({ id: _id, ...rest }) => rest) };
}

function nineRows(): ObserverBrokerForm[] {
  return Array.from({ length: 9 }, (_, i) =>
    brokerRow({ id: `r${i}`, url: `wss://host${i}.example:443`, tokenAudience: `aud${i}` }),
  );
}

describe('emptyObserverForm', () => {
  it('returns all-empty disabled form', () => {
    expect(emptyObserverForm()).toEqual({ enabled: false, iataCode: '', brokers: [] });
  });
});

describe('buildObserverConfig — disabled (preserves operator work)', () => {
  it('returns a disabled block preserving brokers/iataCode, with no validation of row content', () => {
    const result = buildObserverConfig(
      form({ enabled: false, iataCode: 'garbage', brokers: [brokerRow({ url: '', tokenAudience: 'a b' })] }),
    );
    expect(result.error).toBeUndefined();
    expect(result.config).toEqual({
      enabled: false,
      authMode: 'token',
      iataCode: 'GARBAGE',
      brokers: [{ url: '', authMode: 'token', tokenAudience: 'a b' }],
    });
  });

  it('disabled form preserves multiple brokers and iataCode, sets enabled:false', () => {
    const result = buildObserverConfig(
      form({
        enabled: false,
        iataCode: 'mco',
        brokers: [brokerRow({ id: 'r1' }), brokerRow({ id: 'r2', url: 'wss://b.example:443', tokenAudience: 'aud-b' })],
      }),
    );
    expect(result.error).toBeUndefined();
    expect(result.config?.enabled).toBe(false);
    expect(result.config?.iataCode).toBe('MCO');
    expect(result.config?.brokers).toHaveLength(2);
  });

  it('disabled form with 9 rows still returns observer_error_too_many_brokers', () => {
    const result = buildObserverConfig(form({ enabled: false, brokers: nineRows() }));
    expect(result.error?.key).toBe('meshcore.form.observer_error_too_many_brokers');
    expect(result.error?.params).toEqual({ max: MAX_OBSERVER_BROKERS });
  });
});

describe('buildObserverConfig — no brokers (check: rows.length === 0)', () => {
  it('zero rows fails with observer_error_no_brokers', () => {
    const result = buildObserverConfig(form({ brokers: [] }));
    expect(result.error?.key).toBe('meshcore.form.observer_error_no_brokers');
  });
});

describe('buildObserverConfig — too many brokers (check: rows.length > MAX)', () => {
  it('9 rows fails with observer_error_too_many_brokers and params.max === 8', () => {
    const result = buildObserverConfig(form({ brokers: nineRows() }));
    expect(result.error?.key).toBe('meshcore.form.observer_error_too_many_brokers');
    expect(result.error?.params).toEqual({ max: 8 });
    expect(MAX_OBSERVER_BROKERS).toBe(8);
  });
});

describe('buildObserverConfig — broker URL required (per row)', () => {
  it('empty broker URL fails on row 1', () => {
    const result = buildObserverConfig(formWithRow({ url: '' }));
    expect(result.error?.key).toBe('meshcore.form.observer_error_broker_required');
    expect(result.error?.params).toEqual({ index: 1 });
  });

  it('whitespace-only broker URL fails', () => {
    const result = buildObserverConfig(formWithRow({ url: '   ' }));
    expect(result.error?.key).toBe('meshcore.form.observer_error_broker_required');
  });

  it('reports a later row with 1-based index', () => {
    const result = buildObserverConfig(
      form({ brokers: [brokerRow({ id: 'r1' }), brokerRow({ id: 'r2', url: '' })] }),
    );
    expect(result.error?.key).toBe('meshcore.form.observer_error_broker_required');
    expect(result.error?.params).toEqual({ index: 2 });
  });

  it('a row with only a label is kept (not sanitised away) and fails the URL-required check', () => {
    const result = buildObserverConfig(formWithRow({ url: '', tokenAudience: '', label: 'Only a label' }));
    expect(result.error?.key).toBe('meshcore.form.observer_error_broker_required');
  });
});

describe('buildObserverConfig — broker URL scheme (per row)', () => {
  it.each(['wss://host:443', 'ws://h', 'mqtt://h', 'mqtts://h', 'mqtt-us-v1.letsmesh.net:443'])(
    'accepts %s',
    (url) => {
      const result = buildObserverConfig(formWithRow({ url }));
      expect(result.error).toBeUndefined();
      expect(result.config).toBeDefined();
    },
  );

  it.each(['http://h', 'https://h', 'tcp://h', 'tls://h'])('rejects %s', (url) => {
    const result = buildObserverConfig(formWithRow({ url }));
    expect(result.error?.key).toBe('meshcore.form.observer_error_broker_scheme');
    expect(result.error?.params).toEqual({ index: 1 });
  });
});

describe('buildObserverConfig — broker URL host parseability (per row)', () => {
  it('rejects a scheme with no host', () => {
    const result = buildObserverConfig(formWithRow({ url: 'wss://' }));
    expect(result.error?.key).toBe('meshcore.form.observer_error_broker_invalid');
  });
});

describe('buildObserverConfig — token audience (per row, token mode only)', () => {
  it.each(['', '  ', 'a b', 'a\tb', 'x'.repeat(256)])('rejects %j', (audience) => {
    const result = buildObserverConfig(formWithRow({ tokenAudience: audience }));
    expect(result.error?.key).toBe('meshcore.form.observer_error_broker_audience');
  });

  it('accepts exactly 255 chars', () => {
    const result = buildObserverConfig(formWithRow({ tokenAudience: 'x'.repeat(255) }));
    expect(result.error).toBeUndefined();
    expect(result.config?.brokers[0].tokenAudience).toBe('x'.repeat(255));
  });

  it('is skipped entirely in password mode', () => {
    expect(buildObserverConfig(formWithRow({ authMode: 'password', tokenAudience: '' })).error).toBeUndefined();
    expect(buildObserverConfig(formWithRow({ authMode: 'password', tokenAudience: 'a b' })).error).toBeUndefined();
  });
});

describe('buildObserverConfig — label length (per row)', () => {
  it('65-char label fails', () => {
    const result = buildObserverConfig(formWithRow({ label: 'x'.repeat(65) }));
    expect(result.error?.key).toBe('meshcore.form.observer_error_broker_label');
  });

  it('64-char label passes', () => {
    const result = buildObserverConfig(formWithRow({ label: 'x'.repeat(64) }));
    expect(result.error).toBeUndefined();
  });
});

describe('buildObserverConfig — duplicate broker URLs', () => {
  it('duplicate rows differing only in case/trailing whitespace fail at index 2', () => {
    const result = buildObserverConfig(
      form({
        brokers: [
          brokerRow({ id: 'r1', url: 'wss://HOST.example:443' }),
          brokerRow({ id: 'r2', url: '  wss://host.example:443  ' }),
        ],
      }),
    );
    expect(result.error?.key).toBe('meshcore.form.observer_error_duplicate_broker');
    expect(result.error?.params).toEqual({ index: 2 });
  });

  it('a bare host:8883 row and an explicit mqtts://host:8883 row collide', () => {
    const result = buildObserverConfig(
      form({
        brokers: [
          brokerRow({ id: 'r1', url: 'host.example:8883' }),
          brokerRow({ id: 'r2', url: 'mqtts://host.example:8883' }),
        ],
      }),
    );
    expect(result.error?.key).toBe('meshcore.form.observer_error_duplicate_broker');
    expect(result.error?.params).toEqual({ index: 2 });
  });

  it('distinct URLs do not collide', () => {
    const result = buildObserverConfig(
      form({
        brokers: [
          brokerRow({ id: 'r1', url: 'wss://a.example:443' }),
          brokerRow({ id: 'r2', url: 'wss://b.example:443' }),
        ],
      }),
    );
    expect(result.error).toBeUndefined();
  });
});

describe('buildObserverConfig — IATA code (block-level, checked last)', () => {
  it.each(['MCO', 'mco', 'test', 'TEST'])('accepts %s', (code) => {
    const result = buildObserverConfig(form({ iataCode: code }));
    expect(result.error).toBeUndefined();
  });

  it.each(['MC', 'MCOX', '12', ''])('rejects %s', (code) => {
    const result = buildObserverConfig(form({ iataCode: code }));
    expect(result.error?.key).toBe('meshcore.form.observer_error_iata');
  });
});

describe('buildObserverConfig — row sanitisation', () => {
  it('drops a fully-abandoned blank row', () => {
    const result = buildObserverConfig(
      form({ brokers: [brokerRow(), brokerRow({ id: 'blank', url: '', label: '', tokenAudience: '' })] }),
    );
    expect(result.error).toBeUndefined();
    expect(result.config?.brokers).toHaveLength(1);
  });
});

describe('buildObserverConfig — output shape', () => {
  it('has no brokerUrl key and no top-level tokenAudience key', () => {
    const result = buildObserverConfig(form());
    expect(Object.keys(result.config as object)).toEqual(['enabled', 'authMode', 'iataCode', 'brokers']);
  });

  it('trims url/tokenAudience/label and uppercases iataCode', () => {
    const result = buildObserverConfig(
      form({
        iataCode: 'mco',
        brokers: [
          brokerRow({
            url: '  wss://mqtt-us-v1.letsmesh.net:443  ',
            tokenAudience: '  meshcore-mqtt  ',
            label: '  MeshMapper  ',
          }),
        ],
      }),
    );
    expect(result.error).toBeUndefined();
    expect(result.config).toEqual({
      enabled: true,
      authMode: 'token',
      iataCode: 'MCO',
      brokers: [
        {
          url: 'wss://mqtt-us-v1.letsmesh.net:443',
          authMode: 'token',
          tokenAudience: 'meshcore-mqtt',
          label: 'MeshMapper',
        },
      ],
    });
  });

  it("uppercases 'test' to 'TEST'", () => {
    const result = buildObserverConfig(form({ iataCode: 'test' }));
    expect(result.config?.iataCode).toBe('TEST');
  });

  it('accepts a bare host:port and leaves it un-normalized (server normalizes)', () => {
    const result = buildObserverConfig(formWithRow({ url: 'mqtt-us-v1.letsmesh.net:443' }));
    expect(result.error).toBeUndefined();
    expect(result.config?.brokers[0].url).toBe('mqtt-us-v1.letsmesh.net:443');
  });

  it('omits label when blank', () => {
    const result = buildObserverConfig(formWithRow({ label: '   ' }));
    expect(result.error).toBeUndefined();
    expect(result.config?.brokers[0]).not.toHaveProperty('label');
  });

  it('block-level authMode mirrors brokers[0].authMode (password-then-token)', () => {
    const result = buildObserverConfig(
      form({
        brokers: [
          brokerRow({ id: 'r1', authMode: 'password', url: 'wss://a.example:443' }),
          brokerRow({ id: 'r2', authMode: 'token', url: 'wss://b.example:443', tokenAudience: 'aud-b' }),
        ],
      }),
    );
    expect(result.error).toBeUndefined();
    expect(result.config?.authMode).toBe('password');
  });

  it('block-level authMode mirrors brokers[0].authMode (token-then-password)', () => {
    const result = buildObserverConfig(
      form({
        brokers: [
          brokerRow({ id: 'r1', authMode: 'token', url: 'wss://a.example:443', tokenAudience: 'aud-a' }),
          brokerRow({ id: 'r2', authMode: 'password', url: 'wss://b.example:443' }),
        ],
      }),
    );
    expect(result.error).toBeUndefined();
    expect(result.config?.authMode).toBe('token');
  });
});

describe('buildObserverConfig — password auth mode (#4595), per row', () => {
  it('builds without a tokenAudience and drops any stale one', () => {
    const result = buildObserverConfig(formWithRow({ authMode: 'password', tokenAudience: 'stale-audience' }));
    expect(result.error).toBeUndefined();
    expect(result.config?.brokers[0]).toEqual({
      url: 'wss://mqtt-us-v1.letsmesh.net:443',
      authMode: 'password',
    });
  });

  it('still validates the row URL and the block-level IATA code', () => {
    expect(buildObserverConfig(formWithRow({ authMode: 'password', url: '' })).error?.key).toBe(
      'meshcore.form.observer_error_broker_required',
    );
    expect(
      buildObserverConfig(form({ iataCode: 'garbage', brokers: [brokerRow({ authMode: 'password' })] })).error?.key,
    ).toBe('meshcore.form.observer_error_iata');
  });

  it('token mode still requires an audience', () => {
    expect(buildObserverConfig(formWithRow({ authMode: 'token', tokenAudience: '' })).error?.key).toBe(
      'meshcore.form.observer_error_broker_audience',
    );
  });
});

describe('observerFormFromConfig', () => {
  it.each([undefined, null, 42, 'x', []])('returns emptyObserverForm() for %j', (input) => {
    expect(observerFormFromConfig(input)).toEqual(emptyObserverForm());
  });

  it('returns emptyObserverForm() for an empty object', () => {
    expect(observerFormFromConfig({})).toEqual(emptyObserverForm());
  });

  it('legacy { brokerUrl, authMode: token, tokenAudience } -> exactly one row carrying that URL, mode and audience', () => {
    const cfg = {
      enabled: true,
      authMode: 'token',
      brokerUrl: 'wss://legacy.example:443',
      iataCode: 'MCO',
      tokenAudience: 'legacy-aud',
    };
    const result = observerFormFromConfig(cfg);
    expect(withoutIds(result)).toEqual({
      enabled: true,
      iataCode: 'MCO',
      brokers: [{ url: 'wss://legacy.example:443', authMode: 'token', tokenAudience: 'legacy-aud', label: '' }],
    });
  });

  it("legacy { brokerUrl, authMode: password } -> one password-mode row, audience ''", () => {
    const cfg = { enabled: true, authMode: 'password', brokerUrl: 'wss://legacy.example:443' };
    const result = observerFormFromConfig(cfg);
    expect(withoutIds(result)).toEqual({
      enabled: true,
      iataCode: '',
      brokers: [{ url: 'wss://legacy.example:443', authMode: 'password', tokenAudience: '', label: '' }],
    });
  });

  it('brokers[] present -> brokerUrl on the same block is ignored (not unioned)', () => {
    const cfg = {
      enabled: true,
      brokerUrl: 'wss://legacy.example:443',
      brokers: [{ url: 'wss://real.example:443', authMode: 'token', tokenAudience: 'aud' }],
    };
    const result = observerFormFromConfig(cfg);
    expect(result.brokers).toHaveLength(1);
    expect(result.brokers[0].url).toBe('wss://real.example:443');
  });

  it('a brokers[] entry with no authMode inherits the block-level authMode', () => {
    const cfg = { enabled: true, authMode: 'password', brokers: [{ url: 'wss://h.example:443' }] };
    const result = observerFormFromConfig(cfg);
    expect(result.brokers[0].authMode).toBe('password');
  });

  it("a brokers[] entry with no tokenAudience gets '', NOT the block-level tokenAudience", () => {
    const cfg = {
      enabled: true,
      tokenAudience: 'block-level-aud',
      brokers: [{ url: 'wss://h.example:443', authMode: 'token' }],
    };
    const result = observerFormFromConfig(cfg);
    expect(result.brokers[0].tokenAudience).toBe('');
  });

  it('brokers: [] and no brokerUrl -> zero rows', () => {
    const result = observerFormFromConfig({ enabled: true, brokers: [] });
    expect(result.brokers).toEqual([]);
  });

  it('a non-object entry inside brokers yields an all-blank row, no throw', () => {
    const result = observerFormFromConfig({ enabled: true, brokers: [null, 'x', 42, []] });
    expect(result.brokers).toHaveLength(4);
    for (const row of result.brokers) {
      expect(row.url).toBe('');
      expect(row.authMode).toBe('token');
      expect(row.tokenAudience).toBe('');
      expect(row.label).toBe('');
    }
  });

  it('round-trips a full multi-broker block', () => {
    const cfg = {
      enabled: true,
      authMode: 'token',
      iataCode: 'MCO',
      brokers: [
        { url: 'wss://a.example:443', authMode: 'token', tokenAudience: 'aud-a', label: 'A' },
        { url: 'wss://b.example:443', authMode: 'password' },
      ],
    };
    const result = observerFormFromConfig(cfg);
    expect(withoutIds(result)).toEqual({
      enabled: true,
      iataCode: 'MCO',
      brokers: [
        { url: 'wss://a.example:443', authMode: 'token', tokenAudience: 'aud-a', label: 'A' },
        { url: 'wss://b.example:443', authMode: 'password', tokenAudience: '', label: '' },
      ],
    });
  });

  // ── legacy authMode seeding (#4595), now per synthesized row ──────────────
  it('seeds a token-mode legacy row when the stored block predates #4595', () => {
    const result = observerFormFromConfig({ enabled: true, brokerUrl: 'wss://h.example' });
    expect(result.brokers[0].authMode).toBe('token');
  });

  it('seeds a password-mode legacy row from a stored password-mode block', () => {
    const result = observerFormFromConfig({ enabled: true, authMode: 'password', brokerUrl: 'wss://h.example' });
    expect(result.brokers[0].authMode).toBe('password');
  });

  it('falls back to token for an unrecognized stored authMode', () => {
    const result = observerFormFromConfig({ enabled: true, authMode: 'oauth', brokerUrl: 'wss://h.example' });
    expect(result.brokers[0].authMode).toBe('token');
  });
});

describe('OBSERVER_BROKER_PRESETS', () => {
  it('has all four presets, in order', () => {
    expect(OBSERVER_BROKER_PRESETS.map((p) => p.id)).toEqual(['meshmapper', 'letsmesh_us', 'letsmesh_eu', 'custom']);
  });

  it('the three named presets are token mode with host-as-audience', () => {
    const [meshmapper, us, eu] = OBSERVER_BROKER_PRESETS;
    expect(meshmapper.url).toBe('wss://mqtt.meshmapper.net:443');
    expect(meshmapper.tokenAudience).toBe('mqtt.meshmapper.net');
    expect(meshmapper.label).toBe('MeshMapper');

    expect(us.url).toBe('wss://mqtt-us-v1.letsmesh.net:443');
    expect(us.tokenAudience).toBe('mqtt-us-v1.letsmesh.net');
    expect(us.label).toBe('LetsMesh US');

    expect(eu.url).toBe('wss://mqtt-eu-v1.letsmesh.net:443');
    expect(eu.tokenAudience).toBe('mqtt-eu-v1.letsmesh.net');
    expect(eu.label).toBe('LetsMesh EU');
  });

  it('custom is blank', () => {
    const custom = OBSERVER_BROKER_PRESETS.find((p) => p.id === 'custom')!;
    expect(custom.url).toBe('');
    expect(custom.tokenAudience).toBe('');
    expect(custom.label).toBe('');
  });
});

describe('observerBrokerFormFromPreset', () => {
  it('produces unique ids across calls', () => {
    const a = observerBrokerFormFromPreset(OBSERVER_BROKER_PRESETS[0]);
    const b = observerBrokerFormFromPreset(OBSERVER_BROKER_PRESETS[0]);
    expect(a.id).not.toBe(b.id);
  });

  it('produces a token-mode row carrying the preset URL/audience/label', () => {
    const row = observerBrokerFormFromPreset(OBSERVER_BROKER_PRESETS[0]);
    expect(row.authMode).toBe('token');
    expect(row.url).toBe('wss://mqtt.meshmapper.net:443');
    expect(row.tokenAudience).toBe('mqtt.meshmapper.net');
    expect(row.label).toBe('MeshMapper');
  });
});

describe('an 8-broker block built from presets fits the server byte cap', () => {
  it('serializes under MAX_OBSERVER_CONFIG_BYTES (1536)', () => {
    const named = OBSERVER_BROKER_PRESETS.filter((p) => p.id !== 'custom');
    const rows = Array.from({ length: 8 }, (_, i) => {
      const row = observerBrokerFormFromPreset(named[i % named.length]);
      // Presets alone are only 3 distinct hosts; make each row unique so this
      // exercises 8 REAL brokers rather than tripping the duplicate check.
      return { ...row, url: row.url.replace('://', `://n${i}.`) };
    });
    const result = buildObserverConfig(form({ brokers: rows }));
    expect(result.error).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(result.config), 'utf8')).toBeLessThan(1536);
  });
});

describe('observerErrorMessageKey', () => {
  it.each([
    ['INVALID_BROKER_URL', 'meshcore.form.observer_error_broker_invalid'],
    ['INVALID_IATA_CODE', 'meshcore.form.observer_error_iata'],
    ['OBSERVER_REQUIRES_COMPANION', 'meshcore.form.observer_error_requires_companion'],
    ['OBSERVER_KEY_IN_CONFIG', 'meshcore.form.observer_error_key_in_config'],
  ])('maps %s -> %s', (code, key) => {
    expect(observerErrorMessageKey(code)).toBe(key);
  });

  it.each([undefined, null, 'INVALID_PARAMETER', 'NOPE'])('returns null for %j', (code) => {
    expect(observerErrorMessageKey(code)).toBeNull();
  });
});
