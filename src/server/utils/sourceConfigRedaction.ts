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
 * Admins, and signed-in users who hold `sources:write` (they edit the config,
 * so the form must round-trip it), do not come through here — see
 * `redactSourceForCaller` in sourceRoutes.ts.
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
 * A URL fit to show a viewer: no `user:password@`, no query string, no
 * fragment (either can carry a token).
 */
export function redactEndpointUrl(url: string): string {
  return redactBrokerUrl(url).replace(/[?#].*$/, '');
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** Maps a stored value to what leaves; `undefined` omits the field. */
type Project = (value: unknown) => unknown;

export interface FieldRule {
  /** Projection for a caller with no grant. Absent: the field is omitted. */
  public?: Project;
  /** Projection for a signed-in `sources:read` holder. Absent: omitted. */
  viewer?: Project;
  /** Child rules, when the field is an object (or a list of objects). */
  fields?: Record<string, FieldRule>;
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
const open = (project: Project = scalar): FieldRule => ({ public: project, viewer: project });
/** A connection endpoint: signed-in `sources:read` only. */
const granted = (project: Project = scalar): FieldRule => ({ viewer: project });
/** Never returned to a non-admin. */
const withheld: FieldRule = {};

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
  };
}

/** A list of objects, for `sources:read` holders only. */
function grantedListOf<T>(spec: Spec<T>): FieldRule {
  const fields = spec as Record<string, FieldRule>;
  return {
    viewer: (v) =>
      Array.isArray(v)
        ? v.map((entry) => projectObject(entry, fields, 'viewer') ?? {})
        : undefined,
    fields,
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
  url: granted(endpointUrl),
  authMode: withheld,
  tokenAudience: withheld,
  label: granted(),
};

const OBSERVER: Spec<MeshCoreObserverConfig> = {
  enabled: open(),
  authMode: withheld,
  brokerUrl: granted(endpointUrl),
  iataCode: granted(),
  tokenAudience: withheld,
  brokers: grantedListOf(OBSERVER_BROKER),
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
  return { public: withCount('public'), viewer: withCount('viewer'), fields: base.fields };
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
  brokerUrl: granted(endpointUrl),
  // The topic segment every observer publishes under; public by nature (#5607).
  region: open(),
  username: withheld,
  password: withheld,
  rejectUnauthorized: withheld,
  autoConnect: open(),
};

const MQTT_BRIDGE: Spec<MqttBridgeSourceConfig> = {
  // The parent broker's source id — already visible in the list.
  brokerSourceId: open(),
  upstream: nested<MqttBridgeSourceConfig['upstream']>({
    url: granted(endpointUrl),
    username: withheld,
    password: withheld,
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
};

const MQTT_BROKER: Spec<MqttBrokerSourceConfig> = {
  listener: nested<MqttBrokerSourceConfig['listener']>({
    port: granted(),
    host: granted(),
  }),
  auth: withheld,
  gateway: withheld,
  rootTopic: granted(),
  zeroHopInjection: withheld,
  downlinkHopLimitOverride: withheld,
  hopLimitPolicy: withheld,
};

const RETICULUM: Spec<ReticulumSourceConfig> = {
  mode: withheld,
  bridgeUrl: granted(endpointUrl),
  token: withheld,
  autoConnect: open(),
  configDir: withheld,
  peers: grantedListOf<TcpPeerConfig>({ host: granted(), port: granted() }),
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
