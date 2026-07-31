/**
 * MeshCore Analyzer Observer (#4457 Phase 3) — pure form <-> config mapping
 * for the source add/edit modal.
 *
 * Extracted out of DashboardPage.tsx deliberately: the page is 1,700+ lines
 * and every branch here is worth a unit test. Mirrors the split used by
 * DashboardPage.bboxSeed.ts and components/MQTT/mqttBridgeConfig.ts.
 *
 * The client-side checks here MIRROR the server's validateObserverConfig
 * (src/server/routes/sourceRoutes.ts, spec'd in
 * MESHCORE_OBSERVER_PHASE1_SPEC.md §5.1). They exist to give fast, specific
 * feedback — the server remains the authority and re-checks everything.
 */

/** The observer block as it is persisted inside `sources.config`. */
export interface ObserverConfigWire {
  enabled: boolean;
  brokerUrl: string;
  iataCode: string;
  tokenAudience: string;
}

/** Modal form state — all strings, because inputs are all strings. */
export interface ObserverForm {
  enabled: boolean;
  brokerUrl: string;
  iataCode: string;
  tokenAudience: string;
}

export function emptyObserverForm(): ObserverForm {
  return { enabled: false, brokerUrl: '', iataCode: '', tokenAudience: '' };
}

/**
 * Seed the form from a source's stored config. Tolerates a missing block, a
 * non-object block, and missing individual fields (all -> '').
 */
export function observerFormFromConfig(config: unknown): ObserverForm {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return emptyObserverForm();
  }
  const c = config as Record<string, unknown>;
  return {
    enabled: c.enabled === true,
    brokerUrl: typeof c.brokerUrl === 'string' ? c.brokerUrl : '',
    iataCode: typeof c.iataCode === 'string' ? c.iataCode : '',
    tokenAudience: typeof c.tokenAudience === 'string' ? c.tokenAudience : '',
  };
}

const ALLOWED_SCHEMES = new Set(['ws', 'wss', 'mqtt', 'mqtts']);

/**
 * Validate + build. Returns `{ config }` on success (config is `undefined`
 * when the observer is disabled — matching the server's
 * `observerConfigFromSource` incomplete-block-to-undefined rule), or
 * `{ error: { key, fallback } }` for the first failing check.
 *
 * `key`/`fallback` are i18n inputs, NOT rendered text — the caller does
 * `t(key, fallback)`. Same convention as the mqtt_bridge builder's error shape
 * consumed by DashboardPage.tsx's save path.
 */
export function buildObserverConfig(
  form: ObserverForm,
): { config?: ObserverConfigWire; error?: { key: string; fallback: string } } {
  // Check 0: disabled — no validation at all, matching the server's check 5.
  if (!form.enabled) {
    return { config: undefined };
  }

  // Check 1: broker URL required.
  const rawBrokerUrl = form.brokerUrl.trim();
  if (!rawBrokerUrl) {
    return {
      error: {
        key: 'meshcore.form.observer_error_broker_required',
        fallback: 'Broker URL is required',
      },
    };
  }

  // Check 2: explicit scheme, if present, must be one of ws/wss/mqtt/mqtts.
  // A bare host:port has no scheme and passes through — the server
  // normalizes it to mqtt://. Do not "fix" this (Phase 1 deviation).
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(rawBrokerUrl);
  if (schemeMatch && !ALLOWED_SCHEMES.has(schemeMatch[1].toLowerCase())) {
    return {
      error: {
        key: 'meshcore.form.observer_error_broker_scheme',
        fallback:
          'Broker URL must use ws://, wss://, mqtt:// or mqtts:// (or a bare host:port)',
      },
    };
  }

  // Check 3: must have a parseable host.
  let hostname: string;
  try {
    hostname = new URL(schemeMatch ? rawBrokerUrl : `mqtt://${rawBrokerUrl}`).hostname;
  } catch {
    hostname = '';
  }
  if (!hostname) {
    return {
      error: {
        key: 'meshcore.form.observer_error_broker_invalid',
        fallback: 'Broker URL is not a valid address',
      },
    };
  }

  // Check 4: IATA code — 3 letters, or the literal 'test' (case-insensitive).
  const rawIata = form.iataCode.trim();
  const isThreeLetters = /^[A-Za-z]{3}$/.test(rawIata);
  const isTest = rawIata.toLowerCase() === 'test';
  if (!isThreeLetters && !isTest) {
    return {
      error: {
        key: 'meshcore.form.observer_error_iata',
        fallback: "Region must be a 3-letter IATA code (e.g. MCO) or 'test'",
      },
    };
  }

  // Check 5: token audience — non-empty, <=255 chars, no whitespace.
  const rawAudience = form.tokenAudience.trim();
  if (!rawAudience || rawAudience.length > 255 || /\s/.test(rawAudience)) {
    return {
      error: {
        key: 'meshcore.form.observer_error_audience',
        fallback: 'Token audience must be non-empty and contain no spaces',
      },
    };
  }

  return {
    config: {
      enabled: true,
      brokerUrl: rawBrokerUrl,
      iataCode: rawIata.toUpperCase(),
      tokenAudience: rawAudience,
    },
  };
}

const ERROR_CODE_KEY_MAP: Record<string, string> = {
  INVALID_BROKER_URL: 'meshcore.form.observer_error_broker_invalid',
  INVALID_IATA_CODE: 'meshcore.form.observer_error_iata',
  OBSERVER_REQUIRES_COMPANION: 'meshcore.form.observer_error_requires_companion',
  OBSERVER_KEY_IN_CONFIG: 'meshcore.form.observer_error_key_in_config',
};

/**
 * Map a server error `code` from a failed source save onto an i18n key, or
 * null when the code is not observer-related (caller then falls back to the
 * server's own `error` string, as today).
 */
export function observerErrorMessageKey(code: string | undefined | null): string | null {
  if (!code) return null;
  return ERROR_CODE_KEY_MAP[code] ?? null;
}
