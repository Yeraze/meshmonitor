/**
 * What a non-admin may read from a source's `config`.
 *
 * This is an ALLOWLIST. Every field of every source type is classified below;
 * a field that is not listed is dropped. A new source type or a new config
 * field therefore stays private until someone classifies it here:
 *
 *   - a new source TYPE fails to compile (`SOURCE_CONFIG_SPECS` is a `Record`
 *     over `Source['type']`),
 *   - a new FIELD on a typed config fails to compile (`Spec<T>` needs a rule
 *     for every key of `T`),
 *   - a field stored outside the typed shape is dropped at run time.
 *
 * Three classes:
 *
 *   open      anyone who can list sources, signed in or not. Feature flags the
 *             UI draws from (`autoConnect`, `virtualNode.enabled`, ...).
 *   granted   connection endpoints: node host and port, serial path, broker
 *             host. Only a signed-in user holding `sources:read` gets them —
 *             the grant `GET /api/sources/:id` asks for. A caller with no login
 *             never does, whatever the anonymous account has been granted.
 *             URLs lose any `user:password@` and query string on the way out.
 *   withheld  never leaves for a non-admin: passwords, tokens, usernames, and
 *             anything the UI does not read for a viewer.
 *
 * Each rule also says how the field reaches a non-admin EDITOR (signed in,
 * holds `sources:write`), who saves the whole config back through PUT:
 *
 *   plain     returned as stored.
 *   secret    a password, key or token. Never returned; the response names
 *             the field in `maskedConfigFields` instead. On save, a missing or
 *             blank value keeps the stored one, `null` clears it, anything
 *             else replaces it.
 *   url       returned without `user:password@`, query string or fragment.
 *             On save, a part the editor left out is put back from the stored
 *             URL; an explicit empty part (`scheme://@host`, a trailing `?` or
 *             `#`) clears it; a new part replaces it.
 *
 * A stored secret is only ever put back for the endpoint it was stored for:
 * when the editor changes the scheme, host or port it was sent to, the stored
 * value is dropped and has to be typed again. See `mergeSourceConfigOnSave`.
 *
 * Admins get the full config (`redactSourceForCaller` in sourceRoutes.ts).
 */
import type { Request } from 'express';
import databaseService from '../../services/database.js';
import type { Source } from '../../db/repositories/sources.js';
import type { MeshtasticSourceConfig } from '../bootstrapSources.js';
import type {
  MeshCoreSourceConfig,
  MeshCoreObserverConfig,
  MeshCoreObserverBrokerConfig,
} from '../meshcoreConfig.js';
import type { MeshCoreMqttSourceConfig } from '../meshcoreMqttManager.js';
import type { MqttBridgeSourceConfig } from '../mqttBridgeManager.js';
import type { MqttBrokerSourceConfig } from '../mqttBrokerManager.js';
import type { ReticulumSourceConfig } from '../reticulumConfig.js';
import type { TcpPeerConfig } from '../reticulumProtocol.js';
import type { MeshtasticMqttLink } from '../meshtasticManager.js';
import { redactBrokerUrl } from './brokerUrl.js';
import type { SourcePermissions } from './sourcePermissions.js';

/** Who is asking, as far as source config goes. */
export type SourceConfigAudience = 'public' | 'viewer' | 'editor' | 'admin';

/** The two audiences the allowlist serves. */
export type RedactedAudience = 'public' | 'viewer';

type RequestUser = { id: number; username?: string; isAdmin?: boolean };

function requestUser(req: Request): RequestUser | undefined {
  return (req as Request & { user?: RequestUser }).user;
}

/**
 * Classify the caller.
 *
 *   admin   `isAdmin`
 *   editor  signed in, holds `sources:write`
 *   viewer  signed in, holds `sources:read`
 *   public  everyone else — no login, the anonymous account, or a signed-in
 *           user with neither grant
 *
 * The anonymous account is always `public`, even if an operator has granted it
 * `sources:read`: a caller with no login never gets a connection endpoint.
 */
export async function resolveSourceConfigAudience(req: Request): Promise<SourceConfigAudience> {
  const user = requestUser(req);
  if (!user || user.username === 'anonymous') return 'public';
  if (user.isAdmin === true) return 'admin';
  if (await databaseService.checkPermissionAsync(user.id, 'sources', 'write')) return 'editor';
  if (await databaseService.checkPermissionAsync(user.id, 'sources', 'read')) return 'viewer';
  return 'public';
}

/**
 * May this caller see where a source connects to (node address, serial path,
 * broker host)? Signed in, and an admin or a holder of `sources:read`.
 */
export async function mayViewSourceEndpoint(req: Request): Promise<boolean> {
  const user = requestUser(req);
  if (!user || user.username === 'anonymous') return false;
  if (user.isAdmin === true) return true;
  return databaseService.checkPermissionAsync(user.id, 'sources', 'read');
}

/**
 * `mayViewSourceEndpoint` for a handler that has already loaded the caller's
 * grants (`loadSourcePermissions`): the same rule, with no query. `sources` is
 * a global resource, so the answer does not depend on a source.
 */
export function mayViewSourceEndpointWith(
  user: RequestUser | null | undefined,
  permissions: Pick<SourcePermissions, 'isAdmin' | 'can'>,
): boolean {
  if (!user || user.username === 'anonymous') return false;
  if (user.isAdmin === true) return true;
  return permissions.can('sources', 'read', '');
}

/**
 * A URL fit to show a viewer: no `user:password@`, no query string, no
 * fragment (either can carry a token).
 */
export function redactEndpointUrl(url: string): string {
  return redactBrokerUrl(url).replace(/[?#].*$/, '');
}

/**
 * The bridge URL a Reticulum source uses when `bridgeUrl` is unset. Mirrors
 * DEFAULT_BRIDGE_HOST / DEFAULT_BRIDGE_PORT in reticulumConfig.ts.
 */
const RETICULUM_DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:8765';

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/** A URL cut into the parts that can and cannot be shown to an editor. */
export interface UrlParts {
  /** `scheme://`, or '' for a bare `host:port`. */
  scheme: string;
  /** Text before the `@`. `null`: no `@`. '': an `@` with nothing before it. */
  userinfo: string | null;
  hostport: string;
  path: string;
  /** With its `?`. `null`: none. A bare `?` is an explicit empty query. */
  query: string | null;
  /** With its `#`. `null`: none. A bare `#` is an explicit empty fragment. */
  fragment: string | null;
}

/**
 * Split a URL without normalizing it. Returns `null` when the credentials
 * cannot be told from the rest: an `@` that sits after a `/`, `?` or `#` is
 * either part of the path or a password holding one of those characters, and
 * guessing wrong would show the password. Such a URL is treated as one opaque
 * secret.
 */
export function splitUrl(url: string): UrlParts | null {
  const text = url.trim();
  // A backslash, whitespace or control character is read differently by
  // different URL parsers (for ws/wss a backslash ends the host), so where such
  // a URL connects cannot be stated here with confidence.
  if (/[\\\s\x00-\x1f\x7f]/.test(text)) return null;
  const schemeMatch = /^[a-z][a-z0-9+.-]*:\/\//i.exec(text);
  const scheme = schemeMatch ? schemeMatch[0] : '';
  const rest = text.slice(scheme.length);
  const lastAt = rest.lastIndexOf('@');
  let userinfo: string | null = null;
  let tail = rest;
  if (lastAt >= 0) {
    userinfo = rest.slice(0, lastAt);
    if (/[/?#]/.test(userinfo)) return null;
    tail = rest.slice(lastAt + 1);
  }
  const m = /^([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/s.exec(tail);
  if (!m) return null;
  return {
    scheme,
    userinfo,
    hostport: m[1],
    path: m[2],
    query: m[3] ?? null,
    fragment: m[4] ?? null,
  };
}

/**
 * Put a URL back together. An explicit empty part (a bare `?` or `#`, an `@`
 * with nothing before it) is how a save says "clear this", so it is not
 * written out: the stored URL simply has no such part.
 */
function joinUrl(p: UrlParts): string {
  return (
    p.scheme +
    (p.userinfo ? `${p.userinfo}@` : '') +
    p.hostport +
    p.path +
    (p.query && p.query !== '?' ? p.query : '') +
    (p.fragment && p.fragment !== '#' ? p.fragment : '')
  );
}

/**
 * Where a URL connects: scheme, host and port, lower-cased. Two URLs with the
 * same identity reach the same server the same way. Deliberately literal — a
 * default port written out (`mqtt://h` vs `mqtt://h:1883`) reads as a change,
 * which errs toward dropping a stored secret. `null` for an opaque URL.
 */
export function urlEndpointIdentity(url: string): string | null {
  const parts = splitUrl(url);
  if (!parts) return null;
  // Plain host characters only. Anything a parser might decode or fold into a
  // different host (percent-escapes, non-ASCII) has no identity: such a URL
  // matches only an identical one.
  if (!/^[a-z0-9._:[\]-]*$/i.test(parts.hostport)) return null;
  return `${parts.scheme}${parts.hostport}`.toLowerCase();
}

/** True when both URLs name the same scheme, host and port. */
export function sameUrlEndpoint(a: string, b: string): boolean {
  return sameEndpoint(a, b);
}

/** Endpoint plus path: what tells one Observer broker entry from another. */
function urlEntryIdentity(url: string): string | null {
  const endpoint = urlEndpointIdentity(url);
  const parts = splitUrl(url);
  return endpoint !== null && parts ? endpoint + parts.path : null;
}

/** True when both name the same endpoint. */
function sameEndpoint(a: string, b: string): boolean {
  const ia = urlEndpointIdentity(a);
  const ib = urlEndpointIdentity(b);
  if (ia !== null && ib !== null) return ia === ib;
  // No identity for one of them: the same endpoint only when scheme, host and
  // port are the same text, character for character — whatever a parser makes
  // of that text, it makes the same of both.
  const pa = splitUrl(a);
  const pb = splitUrl(b);
  if (pa && pb) return pa.scheme === pb.scheme && pa.hostport === pb.hostport;
  return a.trim() === b.trim();
}

/**
 * A URL for an editor: no credentials, query string or fragment. `masked`
 * says whether anything was left out. An opaque URL is withheld whole.
 */
export function maskUrlForEditor(url: string): { url: string | undefined; masked: boolean } {
  const parts = splitUrl(url);
  if (!parts) return { url: undefined, masked: true };
  const masked = !!parts.userinfo || (!!parts.query && parts.query !== '?') || (!!parts.fragment && parts.fragment !== '#');
  return { url: joinUrl({ ...parts, userinfo: null, query: null, fragment: null }), masked };
}

/**
 * The URL to store when an editor saves `incoming` over `stored`.
 *
 * Each hidden part (credentials, query, fragment) is handled on its own:
 * absent from `incoming` keeps the stored part, but only while the endpoint is
 * the same; an explicit empty part clears it; a new part replaces it.
 */
export function mergeUrlFromEditor(stored: unknown, incoming: unknown): unknown {
  const storedUrl = typeof stored === 'string' ? stored : '';
  if (incoming === undefined || incoming === '') {
    // Only an opaque URL is withheld whole, so only that one is kept on blank.
    return storedUrl !== '' && splitUrl(storedUrl) === null ? storedUrl : incoming;
  }
  if (typeof incoming !== 'string') return incoming;
  const next = splitUrl(incoming);
  if (!next) return incoming;
  const prev = storedUrl !== '' ? splitUrl(storedUrl) : null;
  const keep = prev !== null && sameEndpoint(storedUrl, incoming);
  return joinUrl({
    ...next,
    userinfo: next.userinfo ?? (keep ? prev.userinfo : null),
    query: next.query ?? (keep ? prev.query : null),
    fragment: next.fragment ?? (keep ? prev.fragment : null),
  });
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** Maps a stored value to what leaves; `undefined` omits the field. */
type Project = (value: unknown) => unknown;

/** How a field reaches a non-admin editor. See the file header. */
export type EditClass = 'plain' | 'secret' | 'url' | 'object' | 'list';

export interface FieldRule {
  /** Projection for a caller with no grant. Absent: the field is omitted. */
  public?: Project;
  /** Projection for a signed-in `sources:read` holder. Absent: omitted. */
  viewer?: Project;
  /** Child rules, when the field is an object (or a list of objects). */
  fields?: Record<string, FieldRule>;
  /** What a non-admin editor gets, and how their save is merged. */
  edit: EditClass;
  /**
   * `secret` only: the sibling `url` field this secret is sent to. When an
   * editor's save changes that endpoint, the stored secret is not kept.
   * Absent for a secret that is never sent anywhere (a listener's password).
   */
  endpoint?: string;
  /** The endpoint used when the `endpoint` field is unset. */
  endpointDefault?: string;
  /**
   * `list` only: a stable identity for an entry, so a stored entry is matched
   * to an incoming one by what it is and never by its position.
   */
  identity?: (entry: Record<string, unknown>) => string | null;
}

/** A rule for every key of `T`. A new key on `T` fails to compile until it has one. */
type Spec<T> = { [K in keyof Required<T>]: FieldRule };

/** Only plain values pass: an object needs its own nested spec. */
const scalar: Project = (v) =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : undefined;

const endpointUrl: Project = (v) => (typeof v === 'string' ? redactEndpointUrl(v) : undefined);

const stringList: Project = (v) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;

/** Anyone may read it. */
const open = (project: Project = scalar): FieldRule => ({ public: project, viewer: project, edit: 'plain' });
/** A connection endpoint: signed-in `sources:read` only. */
const granted = (project: Project = scalar): FieldRule => ({ viewer: project, edit: 'plain' });
/**
 * A connection endpoint written as a URL: signed-in `sources:read` only, and
 * never with credentials, query string or fragment — not even for an editor.
 */
const grantedUrl = (): FieldRule => ({ viewer: endpointUrl, edit: 'url' });
/** Not returned to a viewer. An editor gets it: it is a setting, not a credential. */
const withheld: FieldRule = { edit: 'plain' };
/**
 * A credential: a password, key or token. Leaves for an admin only.
 * `endpoint` names the sibling URL field the credential is sent to.
 */
const secret = (opts: { endpoint?: string; endpointDefault?: string } = {}): FieldRule => ({
  edit: 'secret',
  ...opts,
});

function projectObject(
  value: unknown,
  spec: Record<string, FieldRule>,
  audience: RedactedAudience,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(spec)) {
    const project = rule[audience];
    if (!project) continue;
    // Own keys only: a stored `__proto__` or inherited key is not config.
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const projected = project((value as Record<string, unknown>)[key]);
    if (projected !== undefined) out[key] = projected;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** An object field: each child follows its own rule. Omitted when nothing is left. */
function nested<T>(spec: Spec<T>): FieldRule {
  const fields = spec as Record<string, FieldRule>;
  return {
    public: (v) => projectObject(v, fields, 'public'),
    viewer: (v) => projectObject(v, fields, 'viewer'),
    fields,
    edit: 'object',
  };
}

/** A list of objects, for `sources:read` holders only. */
function grantedListOf<T>(
  spec: Spec<T>,
  identity: (entry: Record<string, unknown>) => string | null,
): FieldRule {
  const fields = spec as Record<string, FieldRule>;
  return {
    viewer: (v) =>
      Array.isArray(v)
        ? v.map((entry) => projectObject(entry, fields, 'viewer') ?? {})
        : undefined,
    fields,
    edit: 'list',
    identity,
  };
}

// ---------------------------------------------------------------------------
// Per-type classification
// ---------------------------------------------------------------------------

const MQTT_LINK: Spec<MeshtasticMqttLink> = {
  // Which source relays this node's MQTT proxy traffic: a flag and a source
  // id, both already visible in the list. The MQTT config page reads them.
  enabled: open(),
  mqttBrokerSourceId: open(),
};

const MESHTASTIC_TCP: Spec<MeshtasticSourceConfig & { autoConnect?: boolean }> = {
  host: granted(),
  port: granted(),
  heartbeatIntervalSeconds: withheld,
  virtualNode: nested<NonNullable<MeshtasticSourceConfig['virtualNode']>>({
    enabled: open(),
    // The port MeshMonitor listens on for Virtual Node clients.
    port: granted(),
    allowAdminCommands: withheld,
  }),
  mqttLink: nested(MQTT_LINK),
  passiveMode: withheld,
  passiveResyncStaleMs: withheld,
  autoConnect: open(),
};

const OBSERVER_BROKER: Spec<MeshCoreObserverBrokerConfig> = {
  url: grantedUrl(),
  authMode: withheld,
  tokenAudience: withheld,
  label: granted(),
};

const OBSERVER: Spec<MeshCoreObserverConfig> = {
  enabled: open(),
  authMode: withheld,
  brokerUrl: grantedUrl(),
  iataCode: granted(),
  tokenAudience: withheld,
  // An entry is identified by the endpoint it names, never by its position.
  brokers: grantedListOf(OBSERVER_BROKER, (entry) =>
    typeof entry.url === 'string' ? urlEntryIdentity(entry.url) : null,
  ),
};

/** How many Observer brokers are configured — the count, never the hosts. */
function observerBrokerCount(observer: unknown): number {
  if (!observer || typeof observer !== 'object' || Array.isArray(observer)) return 0;
  const o = observer as { brokers?: unknown; brokerUrl?: unknown };
  if (Array.isArray(o.brokers) && o.brokers.length > 0) return o.brokers.length;
  return typeof o.brokerUrl === 'string' && o.brokerUrl.trim() !== '' ? 1 : 0;
}

/**
 * The observer block plus a derived `brokerCount`, so the source card can draw
 * "OBS 1/2" for a viewer who is not shown the broker list itself.
 */
function observerRule(): FieldRule {
  const base = nested(OBSERVER);
  const withCount = (audience: RedactedAudience): Project => (v) => {
    const projected = base[audience]!(v) as Record<string, unknown> | undefined;
    if (!projected) return undefined;
    return { ...projected, brokerCount: observerBrokerCount(v) };
  };
  return { public: withCount('public'), viewer: withCount('viewer'), fields: base.fields, edit: 'object' };
}

const MESHCORE: Spec<MeshCoreSourceConfig> = {
  transport: open(),
  // Serial device path (legacy `port`, current `serialPort`).
  port: granted(),
  serialPort: granted(),
  baudRate: withheld,
  tcpHost: granted(),
  tcpPort: granted(),
  deviceType: open(),
  autoConnect: open(),
  heartbeatIntervalSeconds: withheld,
  virtualNode: nested<NonNullable<MeshCoreSourceConfig['virtualNode']>>({
    enabled: open(),
    port: granted(),
    allowAdminCommands: withheld,
    allowPkiExport: withheld,
    allowPkiImport: withheld,
  }),
  observer: observerRule(),
};

const MESHCORE_MQTT: Spec<MeshCoreMqttSourceConfig> = {
  brokerUrl: grantedUrl(),
  // The topic segment every observer publishes under; public by nature (#5607).
  region: open(),
  username: withheld,
  password: secret({ endpoint: 'brokerUrl' }),
  rejectUnauthorized: withheld,
  autoConnect: open(),
};

const MQTT_BRIDGE: Spec<MqttBridgeSourceConfig> = {
  // The parent broker's source id — already visible in the list.
  brokerSourceId: open(),
  upstream: nested<MqttBridgeSourceConfig['upstream']>({
    url: grantedUrl(),
    username: withheld,
    password: secret({ endpoint: 'url' }),
  }),
  subscriptions: granted(stringList),
  mode: withheld,
  downlinkFilters: withheld,
  uplinkFilters: withheld,
  downlinkTopicRewrite: withheld,
  uplinkTopicRewrite: withheld,
  forwardingMode: withheld,
  ignoreOkToMqtt: withheld,
  dropAutomationUplinks: withheld,
  skipRaise: withheld,
};

const MQTT_BROKER: Spec<MqttBrokerSourceConfig> = {
  listener: nested<MqttBrokerSourceConfig['listener']>({
    port: granted(),
    host: granted(),
  }),
  // The listener's own login: clients present it to us, we send it nowhere.
  auth: nested<MqttBrokerSourceConfig['auth']>({
    username: withheld,
    password: secret(),
  }),
  gateway: withheld,
  rootTopic: granted(),
  zeroHopInjection: withheld,
  downlinkHopLimitOverride: withheld,
  hopLimitPolicy: withheld,
};

const RETICULUM: Spec<ReticulumSourceConfig> = {
  mode: withheld,
  bridgeUrl: grantedUrl(),
  // Sent to the bridge in the `hello` handshake.
  token: secret({ endpoint: 'bridgeUrl', endpointDefault: RETICULUM_DEFAULT_BRIDGE_URL }),
  autoConnect: open(),
  configDir: withheld,
  // A peer holds no credential; identity is here only so the list has one.
  peers: grantedListOf<TcpPeerConfig>({ host: granted(), port: granted() }, (entry) =>
    `${String(entry.host ?? '').toLowerCase()}:${String(entry.port ?? '')}`,
  ),
  // Serial device path of the RNode.
  device: granted(),
  frequency: withheld,
  bandwidth: withheld,
  spreadingFactor: withheld,
  codingRate: withheld,
  txPower: withheld,
  stAlock: withheld,
  ltAlock: withheld,
  remoteAllowed: withheld,
};

/** Read for every type: the source card draws "Idle" and the Connect button from it. */
const COMMON: Record<string, FieldRule> = {
  autoConnect: open(),
};

/**
 * One entry per source type. Typed as a `Record` over the type union so adding
 * a type without classifying its config does not compile.
 */
export const SOURCE_CONFIG_SPECS: Record<Source['type'], Record<string, FieldRule>> = {
  meshtastic_tcp: MESHTASTIC_TCP,
  meshcore: MESHCORE,
  meshcore_mqtt: MESHCORE_MQTT,
  mqtt_bridge: MQTT_BRIDGE,
  mqtt_broker: MQTT_BROKER,
  reticulum: RETICULUM,
};

/**
 * The config a non-admin, non-editor caller receives. An unknown source type
 * yields `{}`.
 */
export function projectSourceConfig(
  type: string,
  config: unknown,
  audience: RedactedAudience,
): Record<string, unknown> {
  const spec = Object.prototype.hasOwnProperty.call(SOURCE_CONFIG_SPECS, type)
    ? SOURCE_CONFIG_SPECS[type as Source['type']]
    : null;
  if (!spec) return {};
  return projectObject(config, { ...COMMON, ...spec }, audience) ?? {};
}

export type FieldClass = 'open' | 'granted' | 'withheld';

/**
 * Every classified field of a type as `dotted.path -> class`, for the
 * regression test: its fixture must populate each one. A parent object is
 * listed too (`upstream`), with the class of its most open child.
 */
export function classifiedFieldPaths(type: Source['type']): Record<string, FieldClass> {
  const out: Record<string, FieldClass> = {};
  const walk = (spec: Record<string, FieldRule>, prefix: string): void => {
    for (const [key, rule] of Object.entries(spec)) {
      out[`${prefix}${key}`] = rule.public ? 'open' : rule.viewer ? 'granted' : 'withheld';
      if (rule.fields) walk(rule.fields, `${prefix}${key}.`);
    }
  };
  walk({ ...COMMON, ...SOURCE_CONFIG_SPECS[type] }, '');
  return out;
}

// ---------------------------------------------------------------------------
// Non-admin editors: masked read, merge on save
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function specFor(type: string): Record<string, FieldRule> | null {
  return hasOwn(SOURCE_CONFIG_SPECS, type)
    ? { ...COMMON, ...SOURCE_CONFIG_SPECS[type as Source['type']] }
    : null;
}

/** A secret counts as stored when it is anything but missing or blank. */
function isSet(v: unknown): boolean {
  return v !== undefined && v !== null && v !== '';
}

function maskObject(
  value: Record<string, unknown>,
  spec: Record<string, FieldRule>,
  prefix: string,
  masked: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(spec)) {
    if (!hasOwn(value, key)) continue;
    const v = value[key];
    const path = `${prefix}${key}`;
    switch (rule.edit) {
      case 'secret':
        if (isSet(v)) masked.push(path);
        break;
      case 'url': {
        if (typeof v !== 'string') break;
        const m = maskUrlForEditor(v);
        if (m.url !== undefined) out[key] = m.url;
        if (m.masked) masked.push(path);
        break;
      }
      case 'object':
        if (isPlainObject(v)) out[key] = maskObject(v, rule.fields ?? {}, `${path}.`, masked);
        break;
      case 'list':
        if (Array.isArray(v)) {
          out[key] = v.map((entry, i) =>
            isPlainObject(entry) ? maskObject(entry, rule.fields ?? {}, `${path}.${i}.`, masked) : {},
          );
        }
        break;
      case 'plain':
        out[key] = v;
        break;
    }
  }
  return out;
}

/**
 * The config a non-admin editor receives, and the dotted paths of the fields
 * that hold a stored value they were not shown (`upstream.password`,
 * `observer.brokers.0.url`). A field the spec does not classify is left out.
 */
export function maskSourceConfigForEditor(
  type: string,
  config: unknown,
): { config: Record<string, unknown>; masked: string[] } {
  const spec = specFor(type);
  const masked: string[] = [];
  if (!spec || !isPlainObject(config)) return { config: {}, masked };
  return { config: maskObject(config, spec, '', masked), masked };
}

/** Who is saving: an admin was shown everything, anyone else the masked config. */
export type SaveAudience = 'admin' | 'editor';

function endpointOf(obj: Record<string, unknown>, rule: FieldRule): string {
  const v = rule.endpoint ? obj[rule.endpoint] : undefined;
  return typeof v === 'string' && v.trim() !== '' ? v : rule.endpointDefault ?? '';
}

function mergeObject(
  stored: Record<string, unknown>,
  incoming: Record<string, unknown>,
  spec: Record<string, FieldRule>,
  audience: SaveAudience,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...incoming };

  // An editor is never shown a field the spec does not classify, so its
  // absence from their save is not a request to delete it.
  if (audience === 'editor') {
    for (const key of Object.keys(stored)) {
      if (!hasOwn(spec, key) && !hasOwn(incoming, key)) out[key] = stored[key];
    }
  }

  for (const [key, rule] of Object.entries(spec)) {
    const prev = stored[key];
    const next = incoming[key];
    switch (rule.edit) {
      case 'secret': {
        if (next === null) {
          delete out[key];
          break;
        }
        if (next !== undefined && next !== '') break; // a new value
        // Missing or blank: keep the stored value. For an editor, only while it
        // would still go to the endpoint it was stored for.
        const sameTarget =
          audience === 'admin' ||
          rule.endpoint === undefined ||
          sameEndpoint(endpointOf(stored, rule), endpointOf(incoming, rule));
        if (isSet(prev) && sameTarget) out[key] = prev;
        else delete out[key];
        break;
      }
      case 'url':
        if (audience === 'editor') {
          const merged = mergeUrlFromEditor(prev, next);
          if (merged === undefined) delete out[key];
          else out[key] = merged;
        }
        break;
      case 'object':
        // A block the save leaves out is removed, secrets included.
        if (isPlainObject(next)) {
          out[key] = mergeObject(isPlainObject(prev) ? prev : {}, next, rule.fields ?? {}, audience);
        }
        break;
      case 'list':
        if (Array.isArray(next)) {
          const candidates = Array.isArray(prev) ? prev.filter(isPlainObject) : [];
          out[key] = next.map((entry) => {
            if (!isPlainObject(entry)) return entry;
            const id = rule.identity?.(entry) ?? null;
            // Exactly one stored entry with this identity, or none at all:
            // a secret must never move to a different entry.
            const matches = id === null ? [] : candidates.filter((c) => rule.identity?.(c) === id);
            return mergeObject(matches.length === 1 ? matches[0] : {}, entry, rule.fields ?? {}, audience);
          });
        }
        break;
      case 'plain':
        break;
    }
  }
  return out;
}

/**
 * The config to store when `incoming` is saved over `stored`.
 *
 *   admin   a missing or blank secret keeps the stored one; everything else is
 *           taken as sent (they were shown the full config).
 *   editor  as above, but a stored secret is kept only for the endpoint it was
 *           stored for; URL parts they were not shown are put back; a stored
 *           field the spec does not classify is preserved.
 *
 * For both, `null` in a secret field clears it. Nothing here can copy a stored
 * secret into a different field, list entry or source: a value is only ever
 * read from the same path of the same source's stored config.
 */
export function mergeSourceConfigOnSave(
  type: string,
  stored: Record<string, unknown> | null | undefined,
  incoming: Record<string, unknown>,
  audience: SaveAudience,
): Record<string, unknown> {
  const spec = specFor(type);
  if (!spec || !isPlainObject(incoming)) return incoming;
  return mergeObject(isPlainObject(stored) ? stored : {}, incoming, spec, audience);
}

/** How a field reaches an editor, per dotted path — for the regression test and docs. */
export function editClassPaths(type: Source['type']): Record<string, EditClass> {
  const out: Record<string, EditClass> = {};
  const walk = (spec: Record<string, FieldRule>, prefix: string): void => {
    for (const [key, rule] of Object.entries(spec)) {
      out[`${prefix}${key}`] = rule.edit;
      if (rule.fields) walk(rule.fields, `${prefix}${key}.`);
    }
  };
  walk({ ...COMMON, ...SOURCE_CONFIG_SPECS[type] }, '');
  return out;
}

/** Signed in as a real account: not absent, not the anonymous account. */
export function isSignedInCaller(req: Request): boolean {
  const user = requestUser(req);
  return !!user && user.username !== 'anonymous';
}
