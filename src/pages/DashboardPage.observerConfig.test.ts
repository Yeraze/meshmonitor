/**
 * Pure unit tests for DashboardPage.observerConfig.ts (#4457 Phase 3, WP2).
 * No DOM required — table-driven over spec §3.1 (buildObserverConfig check
 * order) and §3.2 (observerErrorMessageKey mapping).
 */
import { describe, it, expect } from 'vitest';
import {
  emptyObserverForm,
  observerFormFromConfig,
  buildObserverConfig,
  observerErrorMessageKey,
  type ObserverForm,
} from './DashboardPage.observerConfig';

function form(overrides: Partial<ObserverForm> = {}): ObserverForm {
  return {
    enabled: true,
    brokerUrl: 'wss://mqtt-us-v1.letsmesh.net:443',
    iataCode: 'MCO',
    tokenAudience: 'meshcore-mqtt',
    ...overrides,
  };
}

describe('emptyObserverForm', () => {
  it('returns all-empty disabled form', () => {
    expect(emptyObserverForm()).toEqual({
      enabled: false,
      brokerUrl: '',
      iataCode: '',
      tokenAudience: '',
    });
  });
});

describe('buildObserverConfig — disabled short-circuit (check 0)', () => {
  it('returns { config: undefined } when disabled, with no validation of other fields', () => {
    const result = buildObserverConfig(
      form({ enabled: false, brokerUrl: '', iataCode: 'garbage', tokenAudience: 'a b' }),
    );
    expect(result).toEqual({ config: undefined });
    expect(result.error).toBeUndefined();
  });
});

describe('buildObserverConfig — broker URL required (check 1)', () => {
  it('empty broker URL fails', () => {
    const result = buildObserverConfig(form({ brokerUrl: '' }));
    expect(result.error?.key).toBe('meshcore.form.observer_error_broker_required');
  });

  it('whitespace-only broker URL fails', () => {
    const result = buildObserverConfig(form({ brokerUrl: '   ' }));
    expect(result.error?.key).toBe('meshcore.form.observer_error_broker_required');
  });
});

describe('buildObserverConfig — broker URL scheme (check 2)', () => {
  it.each(['wss://host:443', 'ws://h', 'mqtt://h', 'mqtts://h', 'mqtt-us-v1.letsmesh.net:443'])(
    'accepts %s',
    (url) => {
      const result = buildObserverConfig(form({ brokerUrl: url }));
      expect(result.error).toBeUndefined();
      expect(result.config).toBeDefined();
    },
  );

  it.each(['http://h', 'https://h', 'tcp://h', 'tls://h'])('rejects %s', (url) => {
    const result = buildObserverConfig(form({ brokerUrl: url }));
    expect(result.error?.key).toBe('meshcore.form.observer_error_broker_scheme');
  });
});

describe('buildObserverConfig — broker URL host parseability (check 3)', () => {
  it('rejects a scheme with no host', () => {
    const result = buildObserverConfig(form({ brokerUrl: 'wss://' }));
    expect(result.error?.key).toBe('meshcore.form.observer_error_broker_invalid');
  });
});

describe('buildObserverConfig — IATA code (check 4)', () => {
  it.each(['MCO', 'mco', 'test', 'TEST'])('accepts %s', (code) => {
    const result = buildObserverConfig(form({ iataCode: code }));
    expect(result.error).toBeUndefined();
  });

  it.each(['MC', 'MCOX', '12', ''])('rejects %s', (code) => {
    const result = buildObserverConfig(form({ iataCode: code }));
    expect(result.error?.key).toBe('meshcore.form.observer_error_iata');
  });
});

describe('buildObserverConfig — token audience (check 5)', () => {
  it.each(['', '  ', 'a b', 'a\tb', 'x'.repeat(256)])('rejects %j', (audience) => {
    const result = buildObserverConfig(form({ tokenAudience: audience }));
    expect(result.error?.key).toBe('meshcore.form.observer_error_audience');
  });

  it('accepts exactly 255 chars', () => {
    const result = buildObserverConfig(form({ tokenAudience: 'x'.repeat(255) }));
    expect(result.error).toBeUndefined();
    expect(result.config?.tokenAudience).toBe('x'.repeat(255));
  });
});

describe('buildObserverConfig — output normalization', () => {
  it('trims brokerUrl and tokenAudience, uppercases iataCode, sets enabled: true', () => {
    const result = buildObserverConfig(
      form({
        brokerUrl: '  wss://mqtt-us-v1.letsmesh.net:443  ',
        iataCode: 'mco',
        tokenAudience: '  meshcore-mqtt  ',
      }),
    );
    expect(result.error).toBeUndefined();
    expect(result.config).toEqual({
      enabled: true,
      brokerUrl: 'wss://mqtt-us-v1.letsmesh.net:443',
      iataCode: 'MCO',
      tokenAudience: 'meshcore-mqtt',
    });
  });

  it("uppercases 'test' to 'TEST'", () => {
    const result = buildObserverConfig(form({ iataCode: 'test' }));
    expect(result.config?.iataCode).toBe('TEST');
  });

  it('accepts a bare host:port and leaves it un-normalized (server normalizes)', () => {
    const result = buildObserverConfig(form({ brokerUrl: 'mqtt-us-v1.letsmesh.net:443' }));
    expect(result.error).toBeUndefined();
    expect(result.config?.brokerUrl).toBe('mqtt-us-v1.letsmesh.net:443');
  });
});

describe('observerFormFromConfig', () => {
  it.each([undefined, null, 42, 'x', []])('returns emptyObserverForm() for %j', (input) => {
    expect(observerFormFromConfig(input)).toEqual(emptyObserverForm());
  });

  it('returns emptyObserverForm() for an empty object', () => {
    expect(observerFormFromConfig({})).toEqual(emptyObserverForm());
  });

  it('round-trips a full block', () => {
    const cfg = {
      enabled: true,
      brokerUrl: 'wss://mqtt-us-v1.letsmesh.net:443',
      iataCode: 'MCO',
      tokenAudience: 'meshcore-mqtt',
    };
    expect(observerFormFromConfig(cfg)).toEqual(cfg);
  });

  it('fills missing individual fields with empty strings', () => {
    expect(observerFormFromConfig({ enabled: true, brokerUrl: 'wss://h' })).toEqual({
      enabled: true,
      brokerUrl: 'wss://h',
      iataCode: '',
      tokenAudience: '',
    });
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
