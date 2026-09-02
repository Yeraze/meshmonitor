/**
 * MeshCore Analyzer Observer (#4457 Phase 3, extended #5014 Phase 2) — pure
 * form <-> config mapping for the source add/edit modal.
 *
 * Extracted out of DashboardPage.tsx deliberately: the page is 1,700+ lines
 * and every branch here is worth a unit test. Mirrors the split used by
 * DashboardPage.bboxSeed.ts and components/MQTT/mqttBridgeConfig.ts.
 *
 * The client-side checks here MIRROR the server's validateObserverConfig
 * (src/server/routes/sourceRoutes.ts, spec'd in
 * MESHMAPPER_OBSERVER_PHASE2_SPEC.md §3.4). They exist to give fast, specific
 * feedback — the server remains the authority and re-checks everything.
 *
 * #5014 Phase 2 replaced the single-broker `brokerUrl` / block-level
 * `tokenAudience` shape with a `brokers[]` list. The legacy shape is still
 * read (see `observerFormFromConfig`, mirroring `normalizeObserverBrokers` in
 * src/server/meshcoreConfig.ts), but never written — the first save of any
 * source migrates it to `brokers[0]`.
 */

/**
 * How MeshMonitor authenticates to a broker (#4595).
 * - `token`: Ed25519-signed token, username `v1_{PUBLIC_KEY}`.
 * - `password`: static MQTT username/password. The password is NOT part of
 *   this form — it is stored through PUT /api/sources/:id/observer/credentials
 *   so it never rides along in `sources.config`.
 */
export type ObserverAuthMode = 'token' | 'password';

/**
 * One editable broker row. `id` is a client-only React key + row identity;
 * it is NEVER persisted and is NOT the server's brokerKey (that is derived
 * server-side, and by `observerBrokerFormKey` below for client-only dupe
 * detection).
 */
export interface ObserverBrokerForm {
  id: string;
  url: string;
  authMode: ObserverAuthMode;
  tokenAudience: string;
  label: string;
}

/**
 * Modal form state — all strings, because inputs are all strings.
 * `brokerUrl` / `tokenAudience` / a block-level `authMode` input are GONE —
 * every broker property now lives on its row (#5014 Phase 2).
 */
export interface ObserverForm {
  enabled: boolean;
  iataCode: string;
  brokers: ObserverBrokerForm[];
}

/** One broker as persisted inside `sources.config.observer.brokers[]`. */
export interface ObserverBrokerWire {
  url: string;
  authMode: ObserverAuthMode;
  /** Omitted entirely in password mode. */
  tokenAudience?: string;
  /** Omitted entirely when blank. */
  label?: string;
}

/**
 * The observer block as persisted. NOTE: no `brokerUrl`, no top-level
 * `tokenAudience` — writing this object is what clears the legacy fields.
 * Block-level `authMode` survives only as a mirror of `brokers[0].authMode`,
 * matching what `observerConfigFromSource` reports as the flat mirror.
 */
export interface ObserverConfigWire {
  enabled: boolean;
  authMode: ObserverAuthMode;
  iataCode: string;
  brokers: ObserverBrokerWire[];
}

export function emptyObserverForm(): ObserverForm {
  return { enabled: false, iataCode: '', brokers: [] };
}

/**
 * MUST match MAX_OBSERVER_BROKERS in src/server/routes/sourceRoutes.ts.
 * Duplicated rather than imported — pages must not pull from src/server
 * (same rule as MAX_HOP_LIMIT in DashboardPage.tsx).
 */
export const MAX_OBSERVER_BROKERS = 8;

// Row `id` generation. crypto.randomUUID() is available in every modern
// browser and in jsdom (Vitest), but the fallback keeps this module free of
// an environment assumption.
let rowIdCounter = 0;
function newRowId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  rowIdCounter += 1;
  return `obs-broker-${rowIdCounter}`;
}

/**
 * Client mirror of the server's observerBrokerKey():
 * normalizeBrokerUrl(url).toLowerCase(). Used ONLY for client-side duplicate
 * detection — never sent to the server, which re-derives it.
 *
 * Mirrors normalizeBrokerUrl in src/server/transports/mqttBrokerClient.ts:
 * trim; pass an explicit mqtt/mqtts/ws/wss/tcp/tls scheme through unchanged;
 * otherwise, if the text after the last `:` parses as 8883 or 8884, prefix
 * `mqtts://`; otherwise prefix `mqtt://`. Then lowercase the whole thing.
 */
export function observerBrokerFormKey(url: string): string {
  const trimmed = url.trim();
  let normalized: string;
  if (/^(mqtt|mqtts|ws|wss|tcp|tls):\/\//i.test(trimmed)) {
    normalized = trimmed;
  } else {
    const colonIdx = trimmed.lastIndexOf(':');
    let scheme = 'mqtt://';
    if (colonIdx > 0) {
      const port = Number(trimmed.slice(colonIdx + 1));
      if (port === 8883 || port === 8884) scheme = 'mqtts://';
    }
    normalized = scheme + trimmed;
  }
  return normalized.toLowerCase();
}

/** A one-click starting point for a broker row (#5014 Phase 2). */
export interface ObserverBrokerPreset {
  id: 'meshmapper' | 'letsmesh_us' | 'letsmesh_eu' | 'custom';
  labelKey: string;
  labelFallback: string;
  /** Blank for 'custom'. */
  url: string;
  tokenAudience: string;
  /** Persisted `label`. Blank for 'custom'. */
  label: string;
}

/**
 * Verified against the upstream reference implementation
 * (agessaman/meshcore-packet-capture, presets/meshmapper.toml and
 * presets/letsmesh.toml — see MESHMAPPER_OBSERVER_PHASE2_SPEC.md §1.7). All
 * three named presets are token-mode, WSS on 443, host-as-audience.
 */
export const OBSERVER_BROKER_PRESETS: readonly ObserverBrokerPreset[] = [
  {
    id: 'meshmapper',
    labelKey: 'meshcore.form.observer_preset_meshmapper',
    labelFallback: 'MeshMapper',
    url: 'wss://mqtt.meshmapper.net:443',
    tokenAudience: 'mqtt.meshmapper.net',
    label: 'MeshMapper',
  },
  {
    id: 'letsmesh_us',
    labelKey: 'meshcore.form.observer_preset_letsmesh_us',
    labelFallback: 'LetsMesh US',
    url: 'wss://mqtt-us-v1.letsmesh.net:443',
    tokenAudience: 'mqtt-us-v1.letsmesh.net',
    label: 'LetsMesh US',
  },
  {
    id: 'letsmesh_eu',
    labelKey: 'meshcore.form.observer_preset_letsmesh_eu',
    labelFallback: 'LetsMesh EU',
    url: 'wss://mqtt-eu-v1.letsmesh.net:443',
    tokenAudience: 'mqtt-eu-v1.letsmesh.net',
    label: 'LetsMesh EU',
  },
  {
    id: 'custom',
    labelKey: 'meshcore.form.observer_preset_custom',
    labelFallback: 'Custom…',
    url: '',
    tokenAudience: '',
    label: '',
  },
];

/** Fresh row from a preset, with a generated `id`. */
export function observerBrokerFormFromPreset(preset: ObserverBrokerPreset): ObserverBrokerForm {
  return {
    id: newRowId(),
    url: preset.url,
    authMode: 'token',
    tokenAudience: preset.tokenAudience,
    label: preset.label,
  };
}

/** Blank token-mode row with a generated `id`. */
export function emptyObserverBrokerForm(): ObserverBrokerForm {
  return { id: newRowId(), url: '', authMode: 'token', tokenAudience: '', label: '' };
}

/**
 * Seed the form from a source's stored config. Tolerates a missing block, a
 * non-object block, and missing individual fields.
 *
 * This is where legacy (pre-#5014) configs get lifted into `brokers[0]`, and
 * it mirrors `normalizeObserverBrokers`'s precedence exactly
 * (src/server/meshcoreConfig.ts):
 *  1. A non-empty `brokers` array WINS OUTRIGHT — `brokerUrl` on the same
 *     block is not unioned in.
 *  2. A `brokers[]` entry with no `authMode` falls back to the block-level
 *     `authMode`; a `brokers[]` entry with no `tokenAudience` gets `''` —
 *     NEVER the block-level `tokenAudience` (that inheritance applies only to
 *     the synthesized legacy entry below).
 *  3. Otherwise, a non-empty legacy `brokerUrl` synthesizes exactly one row,
 *     inheriting the block-level `authMode` and `tokenAudience`.
 *
 * Migration is realised on save, not on load (see `buildObserverConfig`): a
 * user who opens and cancels the modal changes nothing on disk.
 */
export function observerFormFromConfig(config: unknown): ObserverForm {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return emptyObserverForm();
  }
  const c = config as Record<string, unknown>;
  const blockAuthMode: ObserverAuthMode = c.authMode === 'password' ? 'password' : 'token';

  let brokers: ObserverBrokerForm[];
  const brokersRaw = c.brokers;
  if (Array.isArray(brokersRaw) && brokersRaw.length > 0) {
    brokers = brokersRaw.map((entryRaw) => {
      const entry: Record<string, unknown> =
        typeof entryRaw === 'object' && entryRaw !== null && !Array.isArray(entryRaw)
          ? (entryRaw as Record<string, unknown>)
          : {};
      const authMode: ObserverAuthMode =
        entry.authMode === 'password' ? 'password' : entry.authMode === 'token' ? 'token' : blockAuthMode;
      return {
        id: newRowId(),
        url: typeof entry.url === 'string' ? entry.url : '',
        authMode,
        // NEVER inherit the block-level tokenAudience here — see rule 2 above.
        tokenAudience: typeof entry.tokenAudience === 'string' ? entry.tokenAudience : '',
        label: typeof entry.label === 'string' ? entry.label : '',
      };
    });
  } else if (typeof c.brokerUrl === 'string' && c.brokerUrl.trim() !== '') {
    // Legacy -> brokers[0]. This is the ONE case that inherits the
    // block-level tokenAudience.
    brokers = [
      {
        id: newRowId(),
        url: c.brokerUrl,
        authMode: blockAuthMode,
        tokenAudience: typeof c.tokenAudience === 'string' ? c.tokenAudience : '',
        label: '',
      },
    ];
  } else {
    brokers = [];
  }

  return {
    enabled: c.enabled === true,
    iataCode: typeof c.iataCode === 'string' ? c.iataCode : '',
    brokers,
  };
}

const ALLOWED_SCHEMES = new Set(['ws', 'wss', 'mqtt', 'mqtts']);

function toWire(row: ObserverBrokerForm): ObserverBrokerWire {
  return {
    url: row.url.trim(),
    authMode: row.authMode,
    // Password-mode rows drop tokenAudience entirely rather than carrying a
    // stale value — the existing #4595 rule, now per row.
    ...(row.authMode === 'token' ? { tokenAudience: row.tokenAudience.trim() } : {}),
    ...(row.label.trim() ? { label: row.label.trim() } : {}),
  };
}

/**
 * Validate + build. Returns `{ config }` on success, or
 * `{ error: { key, fallback, params? } }` for the first failing check.
 *
 * `key`/`fallback` are i18n inputs, NOT rendered text — the caller does
 * `t(key, fallback, params)` (the three-arg `t()` overload). Fallbacks use
 * `{{index}}` / `{{max}}` placeholders that `params` fills in.
 */
export function buildObserverConfig(form: ObserverForm): {
  config?: ObserverConfigWire;
  error?: { key: string; fallback: string; params?: Record<string, string | number> };
} {
  // Row sanitisation, run first regardless of enabled/disabled: drop rows
  // whose url/label/tokenAudience are ALL blank (an untouched blank row the
  // user added and abandoned). A row with a blank URL but other content is
  // kept, so it fails the URL-required check loudly instead of vanishing.
  const rows = form.brokers.filter((row) => {
    const allBlank = row.url.trim() === '' && row.label.trim() === '' && row.tokenAudience.trim() === '';
    return !allBlank;
  });

  // Too-many-brokers is checked BEFORE the disabled short-circuit, so a
  // disabled block cannot smuggle more than MAX_OBSERVER_BROKERS rows past
  // client-side validation (the server enforces this regardless of
  // `enabled`, via TOO_MANY_BROKERS / OBSERVER_CONFIG_TOO_LARGE).
  if (rows.length > MAX_OBSERVER_BROKERS) {
    return {
      error: {
        key: 'meshcore.form.observer_error_too_many_brokers',
        fallback: 'At most {{max}} brokers are allowed',
        params: { max: MAX_OBSERVER_BROKERS },
      },
    };
  }

  // Disabled — no further validation. Preserve the operator's work (rows +
  // iataCode) so a disable -> re-enable round-trip does not wipe the broker
  // list. Safe because the server's `enabled !== true` early return precedes
  // every URL/audience/MISSING_BROKER check.
  if (!form.enabled) {
    return {
      config: {
        enabled: false,
        authMode: rows[0]?.authMode ?? 'token',
        iataCode: form.iataCode.trim().toUpperCase(),
        brokers: rows.map(toWire),
      },
    };
  }

  if (rows.length === 0) {
    return {
      error: {
        key: 'meshcore.form.observer_error_no_brokers',
        fallback: 'Add at least one broker',
      },
    };
  }

  // Per-row checks, in row order, 1-based index in the reported error —
  // first failure wins. Duplicate detection is folded into the same pass:
  // each row's normalized key is checked against every prior row's key
  // before being recorded.
  const seenKeys = new Map<string, number>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const index = i + 1;
    const rawUrl = row.url.trim();

    if (!rawUrl) {
      return {
        error: {
          key: 'meshcore.form.observer_error_broker_required',
          fallback: 'Broker {{index}}: broker URL is required',
          params: { index },
        },
      };
    }

    // A bare host:port has no scheme and passes through — the server
    // normalizes it to mqtt://. Do not "fix" this (Phase 1 deviation,
    // carried into Phase 2).
    const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(rawUrl);
    if (schemeMatch && !ALLOWED_SCHEMES.has(schemeMatch[1].toLowerCase())) {
      return {
        error: {
          key: 'meshcore.form.observer_error_broker_scheme',
          fallback: 'Broker {{index}}: URL must use ws://, wss://, mqtt:// or mqtts:// (or a bare host:port)',
          params: { index },
        },
      };
    }

    let hostname = '';
    try {
      hostname = new URL(schemeMatch ? rawUrl : `mqtt://${rawUrl}`).hostname;
    } catch {
      // hostname stays '' — handled below.
    }
    if (!hostname) {
      return {
        error: {
          key: 'meshcore.form.observer_error_broker_invalid',
          fallback: 'Broker {{index}}: URL is not a valid address',
          params: { index },
        },
      };
    }

    // Token audience — non-empty, <=255 chars, no whitespace. Skipped
    // entirely in password mode (#4595): a static-credential broker verifies
    // no signature, so it has no audience to match.
    if (row.authMode === 'token') {
      const rawAudience = row.tokenAudience.trim();
      if (!rawAudience || rawAudience.length > 255 || /\s/.test(rawAudience)) {
        return {
          error: {
            key: 'meshcore.form.observer_error_broker_audience',
            fallback: 'Broker {{index}}: token audience must be non-empty and contain no spaces',
            params: { index },
          },
        };
      }
    }

    if (row.label.trim().length > 64) {
      return {
        error: {
          key: 'meshcore.form.observer_error_broker_label',
          fallback: 'Broker {{index}}: label must be at most 64 characters',
          params: { index },
        },
      };
    }

    const key = observerBrokerFormKey(row.url);
    if (seenKeys.has(key)) {
      return {
        error: {
          key: 'meshcore.form.observer_error_duplicate_broker',
          fallback: "Broker {{index}} duplicates another broker's URL",
          params: { index },
        },
      };
    }
    seenKeys.set(key, i);
  }

  // IATA code — 3 letters, or the literal 'test' (case-insensitive). Shared
  // across every broker (it is the region segment of the topic, not a
  // per-broker property), so this check runs once, block-level, last.
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

  return {
    config: {
      enabled: true,
      // Block-level mirror of brokers[0], matching observerConfigFromSource.
      authMode: rows[0].authMode,
      iataCode: rawIata.toUpperCase(),
      brokers: rows.map(toWire),
    },
  };
}

const ERROR_CODE_KEY_MAP: Record<string, string> = {
  INVALID_BROKER_URL: 'meshcore.form.observer_error_broker_invalid',
  INVALID_IATA_CODE: 'meshcore.form.observer_error_iata',
  OBSERVER_REQUIRES_COMPANION: 'meshcore.form.observer_error_requires_companion',
  OBSERVER_KEY_IN_CONFIG: 'meshcore.form.observer_error_key_in_config',
  INVALID_OBSERVER_AUTH_MODE: 'meshcore.form.observer_error_auth_mode',
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

// ---------------------------------------------------------------------------
// Field tables (#5014 Phase 2) — moved out of DashboardPage.tsx so the
// fieldset keeps its `.map()` rendering and the placeholders stay in one
// place. One table for the single block-level field (iataCode), one for the
// fields that repeat per broker row (url, tokenAudience, label).
// ---------------------------------------------------------------------------

export interface ObserverBlockFieldDef {
  key: 'iataCode';
  labelKey: string;
  labelFallback: string;
  placeholder: string;
  helpKey: string;
  helpFallback: string;
}

/** Placeholder `MCO` is load-bearing — existing tests query by it. */
export const OBSERVER_BLOCK_FIELDS: readonly ObserverBlockFieldDef[] = [
  {
    key: 'iataCode',
    labelKey: 'meshcore.form.observer_iata',
    labelFallback: 'Region (IATA)',
    placeholder: 'MCO',
    helpKey: 'meshcore.form.observer_iata_help',
    helpFallback:
      "Three-letter IATA code for your region (e.g. MCO for Central Florida), or 'test' for a local broker.",
  },
];

export interface ObserverBrokerFieldDef {
  key: 'url' | 'tokenAudience' | 'label';
  labelKey: string;
  labelFallback: string;
  placeholder: string;
  helpKey: string;
  helpFallback: string;
}

/**
 * Placeholders `wss://mqtt-us-v1.letsmesh.net:443`, `meshcore-mqtt` and
 * `MeshMapper` are load-bearing — existing tests query by them.
 */
export const OBSERVER_BROKER_FIELDS: readonly ObserverBrokerFieldDef[] = [
  {
    key: 'label',
    labelKey: 'meshcore.form.observer_broker_label',
    labelFallback: 'Label (optional)',
    placeholder: 'MeshMapper',
    helpKey: 'meshcore.form.observer_broker_label_help',
    helpFallback: 'A friendly name shown on the status panel. Never sent to the broker.',
  },
  {
    key: 'url',
    labelKey: 'meshcore.form.observer_broker_url',
    labelFallback: 'Broker URL',
    placeholder: 'wss://mqtt-us-v1.letsmesh.net:443',
    helpKey: 'meshcore.form.observer_broker_url_help',
    helpFallback: 'ws://, wss://, mqtt://, or mqtts://. A bare host:port is accepted and defaults to mqtt://.',
  },
  {
    key: 'tokenAudience',
    labelKey: 'meshcore.form.observer_audience',
    labelFallback: 'Token audience',
    placeholder: 'meshcore-mqtt',
    helpKey: 'meshcore.form.observer_audience_help',
    helpFallback:
      "Must exactly match the broker's expected audience, or authentication is rejected. Ask your region's broker operator.",
  },
];
