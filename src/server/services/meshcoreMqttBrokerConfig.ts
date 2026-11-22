/**
 * Config shape, defaults and validation for the embedded MeshCore MQTT broker
 * source (`meshcore_mqtt_broker`, #6197).
 *
 * Pure functions only: the create/update routes validate with these, and the
 * manager reads the normalized form, so the two can never disagree about a
 * default.
 *
 * Binding v1 decisions (issue #6197):
 * - Auth: Ed25519 observer token whose audience matches AND whose key is on the
 *   allowlist, or the static username/password. Anonymous is refused.
 * - Limits default to 50 observers, 20 msg/s per connection, 64 KB payload.
 * - Forwarding is off by default and opt-in per target.
 */

/** One upstream Analyzer broker the embedded broker may forward to. */
export interface MeshCoreMqttBrokerForwardTarget {
  /** Stable id, so an edit keeps the stored password for the same target. */
  id: string;
  label?: string;
  /** Off unless the admin turns it on. */
  enabled?: boolean;
  /** mqtt://, mqtts://, ws://, wss:// or host:port. */
  url: string;
  /**
   * `passthrough`: republish verbatim on the original topic with the static
   * username/password below. `own`: republish under MeshMonitor's own observer
   * key with a freshly minted token.
   */
  identityMode: 'passthrough' | 'own';
  /** Pass-through login. */
  username?: string;
  password?: string;
  /** Own-identity token audience (the upstream broker's host, for LetsMesh). */
  tokenAudience?: string;
  /** Observer public keys (64 hex) whose frames this target receives. Empty: none. */
  observers?: string[];
  /** Optional IATA filter. Empty or absent: every region. */
  iataFilter?: string[];
  /** Reject an invalid upstream TLS certificate. Default true. */
  rejectUnauthorized?: boolean;
}

/** Persisted `sources.config` for a `meshcore_mqtt_broker` source. */
export interface MeshCoreMqttBrokerSourceConfig {
  listener: { port: number; host?: string };
  auth: {
    /** Audience a token must carry. Token logins are refused when unset. */
    tokenAudience?: string;
    /** Observer public keys allowed to log in with a token. */
    allowedObservers?: string[];
    /** Static login. Both halves must be set for it to work. */
    username?: string;
    password?: string;
  };
  /** Allowed IATA region codes. Empty or absent: any well-formed code. */
  regions?: string[];
  limits?: {
    maxClients?: number;
    maxMessagesPerSecond?: number;
    maxPayloadBytes?: number;
  };
  forwarding?: {
    /** Name sent as `origin` on frames forwarded under our own identity. */
    ownIdentityName?: string;
    targets?: MeshCoreMqttBrokerForwardTarget[];
  };
  autoConnect?: boolean;
  /**
   * The observer that is the user's own node (#6532): shown as "my node" on
   * the dashboard map and the source page. Display only. Must be on the
   * observer allowlist when one is set.
   */
  localObserverKey?: string;
}

export const MESHCORE_BROKER_DEFAULT_PORT = 1884;
export const MESHCORE_BROKER_DEFAULT_MAX_CLIENTS = 50;
export const MESHCORE_BROKER_DEFAULT_MSGS_PER_SEC = 20;
export const MESHCORE_BROKER_DEFAULT_MAX_PAYLOAD = 64 * 1024;

/** Hard ceilings on the admin-adjustable limits, so a typo cannot open the floodgates. */
export const MESHCORE_BROKER_MAX_CLIENTS_CEILING = 1000;
export const MESHCORE_BROKER_MSGS_PER_SEC_CEILING = 200;
export const MESHCORE_BROKER_MAX_PAYLOAD_CEILING = 1024 * 1024;
export const MESHCORE_BROKER_MAX_TARGETS = 10;

export const OBSERVER_KEY_RE = /^[0-9a-fA-F]{64}$/;
/** IATA-ish region segment: letters and digits, 2 to 8 long (`test` included). */
export const IATA_RE = /^[A-Za-z0-9]{2,8}$/;

export interface NormalizedMeshCoreBrokerConfig {
  port: number;
  host: string;
  tokenAudience: string | null;
  allowedObservers: Set<string>;
  staticUsername: string | null;
  staticPassword: string | null;
  regions: Set<string>;
  maxClients: number;
  maxMessagesPerSecond: number;
  maxPayloadBytes: number;
  ownIdentityName: string;
  targets: NormalizedForwardTarget[];
  /** Upper-case 64-hex key of the user's own observer (#6532), or null. */
  localObserverKey: string | null;
}

export interface NormalizedForwardTarget {
  id: string;
  label: string;
  url: string;
  identityMode: 'passthrough' | 'own';
  username: string | null;
  password: string | null;
  tokenAudience: string | null;
  observers: Set<string>;
  iataFilter: Set<string>;
  rejectUnauthorized: boolean;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function keyList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim().toUpperCase())
    .filter((x) => OBSERVER_KEY_RE.test(x));
}

function iataList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim().toUpperCase())
    .filter((x) => IATA_RE.test(x));
}

function intIn(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Fill defaults and canonicalize. Never throws; invalid entries are dropped. */
export function normalizeMeshCoreBrokerConfig(raw: unknown): NormalizedMeshCoreBrokerConfig {
  const cfg = (raw && typeof raw === 'object' ? raw : {}) as Partial<MeshCoreMqttBrokerSourceConfig>;
  const listener = (cfg.listener ?? {}) as Partial<MeshCoreMqttBrokerSourceConfig['listener']>;
  const auth = (cfg.auth ?? {}) as Partial<MeshCoreMqttBrokerSourceConfig['auth']>;
  const limits = cfg.limits ?? {};
  const forwarding = cfg.forwarding ?? {};
  const targets = Array.isArray(forwarding.targets) ? forwarding.targets : [];
  return {
    port: intIn(listener.port, MESHCORE_BROKER_DEFAULT_PORT, 1, 65535),
    host: str(listener.host) ?? '0.0.0.0',
    tokenAudience: str(auth.tokenAudience),
    allowedObservers: new Set(keyList(auth.allowedObservers)),
    staticUsername: str(auth.username),
    // Passwords are compared byte-for-byte: never trim them.
    staticPassword: typeof auth.password === 'string' && auth.password !== '' ? auth.password : null,
    regions: new Set(iataList(cfg.regions)),
    maxClients: intIn(limits.maxClients, MESHCORE_BROKER_DEFAULT_MAX_CLIENTS, 1, MESHCORE_BROKER_MAX_CLIENTS_CEILING),
    maxMessagesPerSecond: intIn(
      limits.maxMessagesPerSecond,
      MESHCORE_BROKER_DEFAULT_MSGS_PER_SEC,
      1,
      MESHCORE_BROKER_MSGS_PER_SEC_CEILING,
    ),
    maxPayloadBytes: intIn(limits.maxPayloadBytes, MESHCORE_BROKER_DEFAULT_MAX_PAYLOAD, 256, MESHCORE_BROKER_MAX_PAYLOAD_CEILING),
    ownIdentityName: str(forwarding.ownIdentityName) ?? 'MeshMonitor',
    localObserverKey: keyList([cfg.localObserverKey])[0] ?? null,
    targets: targets
      .filter((t) => t && typeof t === 'object' && t.enabled === true && str(t.url) && str(t.id))
      .map((t) => ({
        id: String(t.id),
        label: str(t.label) ?? String(t.id),
        url: String(t.url).trim(),
        identityMode: t.identityMode === 'own' ? ('own' as const) : ('passthrough' as const),
        username: str(t.username),
        password: typeof t.password === 'string' && t.password !== '' ? t.password : null,
        tokenAudience: str(t.tokenAudience),
        observers: new Set(keyList(t.observers)),
        iataFilter: new Set(iataList(t.iataFilter)),
        rejectUnauthorized: t.rejectUnauthorized !== false,
      })),
  };
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]', '::']);

/** Host and port of a broker URL, or null when it cannot be parsed. */
export function brokerUrlHostPort(url: string): { host: string; port: number | null } | null {
  const trimmed = url.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `mqtt://${trimmed}`;
  try {
    const u = new URL(withScheme);
    const port = u.port ? Number(u.port) : null;
    return { host: u.hostname.toLowerCase(), port };
  } catch {
    return null;
  }
}

/**
 * True when a forward target points back at this broker's own listener. That
 * would feed every forwarded frame straight back in, so it is refused on save.
 */
export function targetPointsAtListener(targetUrl: string, listenerPort: number): boolean {
  const hp = brokerUrlHostPort(targetUrl);
  if (!hp) return false;
  const port = hp.port ?? (/^(mqtts|wss):/i.test(targetUrl.trim()) ? 8883 : 1883);
  return LOOPBACK_HOSTS.has(hp.host) && port === listenerPort;
}

/**
 * Validate a submitted config. Returns an error message, or null when it is
 * usable. Called on create and on every save that sends a config.
 */
export function validateMeshCoreBrokerConfig(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'config must be an object';
  const cfg = raw as Partial<MeshCoreMqttBrokerSourceConfig>;

  const port = cfg.listener?.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    return 'listener.port must be an integer between 1 and 65535';
  }

  const auth = cfg.auth ?? {};
  const hasStatic = !!str(auth.username) || (typeof auth.password === 'string' && auth.password !== '');
  const hasToken = !!str(auth.tokenAudience);
  if (!hasStatic && !hasToken) {
    return 'auth needs a token audience, a static username and password, or both (anonymous logins are refused)';
  }
  if (hasStatic && !str(auth.username)) return 'auth.username is required when a static password is set';
  if (auth.allowedObservers !== undefined) {
    if (!Array.isArray(auth.allowedObservers)) return 'auth.allowedObservers must be a list of public keys';
    for (const k of auth.allowedObservers) {
      if (typeof k !== 'string' || !OBSERVER_KEY_RE.test(k.trim())) {
        return 'every auth.allowedObservers entry must be a 64-character hex public key';
      }
    }
  }

  if (cfg.localObserverKey !== undefined && cfg.localObserverKey !== null && cfg.localObserverKey !== '') {
    const key = typeof cfg.localObserverKey === 'string' ? cfg.localObserverKey.trim() : '';
    if (!OBSERVER_KEY_RE.test(key)) return 'localObserverKey must be a 64-character hex public key';
    const allowed = keyList(auth.allowedObservers);
    if (allowed.length > 0 && !allowed.includes(key.toUpperCase())) {
      return 'localObserverKey must be one of the allowed observers';
    }
  }

  if (cfg.regions !== undefined) {
    if (!Array.isArray(cfg.regions)) return 'regions must be a list of IATA codes';
    for (const r of cfg.regions) {
      if (typeof r !== 'string' || !IATA_RE.test(r.trim())) return `region "${String(r)}" is not a valid IATA code`;
    }
  }

  const limits = cfg.limits ?? {};
  const checkLimit = (v: unknown, name: string, min: number, max: number): string | null => {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      return `limits.${name} must be an integer between ${min} and ${max}`;
    }
    return null;
  };
  const limitErr =
    checkLimit(limits.maxClients, 'maxClients', 1, MESHCORE_BROKER_MAX_CLIENTS_CEILING) ??
    checkLimit(limits.maxMessagesPerSecond, 'maxMessagesPerSecond', 1, MESHCORE_BROKER_MSGS_PER_SEC_CEILING) ??
    checkLimit(limits.maxPayloadBytes, 'maxPayloadBytes', 256, MESHCORE_BROKER_MAX_PAYLOAD_CEILING);
  if (limitErr) return limitErr;

  const targets = cfg.forwarding?.targets;
  if (targets !== undefined) {
    if (!Array.isArray(targets)) return 'forwarding.targets must be a list';
    if (targets.length > MESHCORE_BROKER_MAX_TARGETS) {
      return `at most ${MESHCORE_BROKER_MAX_TARGETS} forwarding targets are allowed`;
    }
    const ids = new Set<string>();
    for (const t of targets) {
      if (!t || typeof t !== 'object') return 'each forwarding target must be an object';
      if (!str(t.id)) return 'each forwarding target needs an id';
      if (ids.has(String(t.id))) return `duplicate forwarding target id "${String(t.id)}"`;
      ids.add(String(t.id));
      if (!str(t.url) || !brokerUrlHostPort(String(t.url))) return 'each forwarding target needs a valid broker URL';
      if (t.identityMode !== 'passthrough' && t.identityMode !== 'own') {
        return 'forwarding target identityMode must be "passthrough" or "own"';
      }
      if (t.identityMode === 'own' && t.enabled === true && !str(t.tokenAudience)) {
        return 'an own-identity forwarding target needs a token audience';
      }
      if (targetPointsAtListener(String(t.url), port)) {
        return 'a forwarding target cannot point at this broker\'s own listener';
      }
      if (t.observers !== undefined && !Array.isArray(t.observers)) {
        return 'forwarding target observers must be a list of public keys';
      }
      for (const k of t.observers ?? []) {
        if (typeof k !== 'string' || !OBSERVER_KEY_RE.test(k.trim())) {
          return 'every forwarding target observer must be a 64-character hex public key';
        }
      }
      for (const r of t.iataFilter ?? []) {
        if (typeof r !== 'string' || !IATA_RE.test(r.trim())) return `IATA filter "${String(r)}" is not valid`;
      }
    }
  }
  return null;
}
