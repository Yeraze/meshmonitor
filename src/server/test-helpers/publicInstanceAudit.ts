/**
 * Sentinel catalogue and scanners for the public-instance audit (#5156, Phase 2).
 *
 * The audit seeds every store with values that would identify a person or a
 * place, calls every GET route as an anonymous viewer, and scans the response
 * (body and headers) for those values. Each sentinel carries a store tag
 * (`MT`, `MC`, `RNS`, `MQTT`) so a leak names the store it came from.
 *
 * Test-only. Nothing here may be imported from production code.
 */
import { snapToPrecisionCell } from '../../utils/precisionOffset.js';
import { ALL_SOURCES } from '../../db/repositories/index.js';

export type SentinelClass =
  | 'coordinates'
  | 'longName'
  | 'publicKey'
  | 'text'
  | 'rawPayload'
  | 'timestamp'
  | 'geometry';

/** Toggle that governs a class, or `null` for a class that no toggle may disable. */
export type ToggleName = 'hideLongNames' | 'hidePublicKeys' | 'roundTimestamps' | 'hideMessageText';

export const CLASS_TOGGLE: Record<SentinelClass, ToggleName | null> = {
  coordinates: null,
  geometry: null,
  rawPayload: null,
  longName: 'hideLongNames',
  publicKey: 'hidePublicKeys',
  timestamp: 'roundTimestamps',
  text: 'hideMessageText',
};

export interface SentinelDef {
  cls: SentinelClass;
  store: string;
  /** Short unique name, e.g. `coord:MT-node:lat`. */
  label: string;
  /** Matches a leaf string (numbers are stringified first). */
  re: RegExp;
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ── Coordinates ─────────────────────────────────────────────────────────────

export interface CoordSentinel {
  key: string;
  store: string;
  lat: number;
  lon: number;
}

/** Each pair is unique to one seeded field, so a leak names its source. */
export const COORDS: Record<string, CoordSentinel> = {
  'MT-node': { key: 'MT-node', store: 'MT', lat: 41.9873465, lon: -71.4625831 },
  'MT-override': { key: 'MT-override', store: 'MT', lat: 39.1234567, lon: -76.5432198 },
  'MT-telemetry': { key: 'MT-telemetry', store: 'MT', lat: 38.2468135, lon: -75.1357924 },
  'MT-waypoint': { key: 'MT-waypoint', store: 'MT', lat: 37.3692581, lon: -74.2581473 },
  'MT-marker': { key: 'MT-marker', store: 'MT', lat: 36.4813579, lon: -73.3692581 },
  'MT-estimate': { key: 'MT-estimate', store: 'MT', lat: 35.5791357, lon: -72.4826159 },
  'MT-traceroute': { key: 'MT-traceroute', store: 'MT', lat: 34.6802468, lon: -71.5937159 },
  'MT-local': { key: 'MT-local', store: 'MT', lat: 33.7913579, lon: -70.6048261 },
  'MT-coverage': { key: 'MT-coverage', store: 'MT', lat: 32.8024681, lon: -69.7159373 },
  'MT-device': { key: 'MT-device', store: 'MT', lat: 30.0246801, lon: -67.9371595 },
  'MT-neighbor': { key: 'MT-neighbor', store: 'MT', lat: 31.9135792, lon: -68.8260484 },
  'MC-node': { key: 'MC-node', store: 'MC', lat: 43.2198765, lon: -72.3341957 },
  'MC-history': { key: 'MC-history', store: 'MC', lat: 44.3210987, lon: -69.4455667 },
  'MC-local': { key: 'MC-local', store: 'MC', lat: 45.4321098, lon: -68.5566778 },
  'MC-contact': { key: 'MC-contact', store: 'MC', lat: 46.5432109, lon: -67.6677889 },
};

const intForms = (v: number, scale: number): string[] => {
  const scaled = Math.abs(v) * scale;
  return [String(Math.floor(scaled)), String(Math.ceil(scaled))];
};

function coordDefs(c: CoordSentinel): SentinelDef[] {
  const defs: SentinelDef[] = [];
  for (const [axis, v] of [['lat', c.lat], ['lon', c.lon]] as const) {
    const abs = Math.abs(v);
    const text = String(abs);
    // First five decimals, digit bounded: matches the number, a string, or a longer fraction.
    const prefix = text.slice(0, text.indexOf('.') + 6);
    defs.push({
      cls: 'coordinates', store: c.store, label: `coord:${c.key}:${axis}`,
      re: new RegExp(`(?<![\\d.])${esc(prefix)}\\d*`),
    });
    const ints = [...intForms(v, 1e7), ...intForms(v, 1e6)];
    defs.push({
      cls: 'coordinates', store: c.store, label: `coord:${c.key}:${axis}:int`,
      re: new RegExp(`(?<![\\d.])(?:${ints.map(esc).join('|')})(?![\\d.])`),
    });
  }
  return defs;
}

// ── Names, text, keys, raw payloads ─────────────────────────────────────────

export const NAMES = {
  mtLong: 'SntlLong-MT-q7x',
  mtLocal: 'SntlLocal-MT-q7x',
  mtNeighbor: 'SntlNeighbor-MT-q7x',
  mcAdv: 'SntlAdv-MC-q7x',
  mcLocal: 'SntlLocal-MC-q7x',
  mcSender: 'SntlSend-MC-q7x',
  mcNeighbor: 'SntlNeigh-MC-q7x',
  mtOverride: 'SntlOvr-MT-q7x',
  mtEstimated: 'SntlEst-MT-q7x',
  rns: 'SntlRns-q7x',
  rnsPeer: 'SntlPeer-RNS-q7x',
  embedProfile: 'SntlProfile-MT-q7x',
} as const;

export const TEXTS = {
  mtChannel: 'sntl text MT q7x',
  mtDm: 'sntl text MT dm q7x',
  mtReply: 'sntl text MT reply q7x',
  mtPreview: 'sntl preview MT q7x',
  mtWaypoint: 'sntl text MT waypoint q7x',
  mtWaypointName: 'sntl text MT waypoint name q7x',
  mcChannel: 'sntl text MC q7x',
  mcDm: 'sntl text MC dm q7x',
  mcPrefixed: 'sntl text MC prefixed q7x',
  mqttPreview: 'sntl preview MQTT q7x',
  rnsContent: 'sntl text RNS q7x',
  rnsTitle: 'sntl title RNS q7x',
} as const;

/** Meshtastic key: fixed 32 bytes. */
const MT_KEY_BYTES = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 37 + 91) & 0xff));
export const MT_KEY_B64 = MT_KEY_BYTES.toString('base64');
export const MT_KEY_HEX = MT_KEY_BYTES.toString('hex');
export const MT_KEY_B64_NEIGHBOR = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 53 + 17) & 0xff)).toString('base64');

/** MeshCore keys: 64 hex each. */
export const MC_KEYS = {
  contact: 'e4c7a19b3d5f8206e4c7a19b3d5f8206e4c7a19b3d5f8206e4c7a19b3d5f8206',
  neighbor: '7b2d90c8e1a4f635d87b2d90c8e1a4f6a7b2d90c8e1a4f635d87b2d90c8e1a4f',
  local: 'c19e5a7d2b84f063a9c19e5a7d2b84f0c19e5a7d2b84f063a9c19e5a7d2b84f0',
} as const;
export const MC_LOCAL_KEY = MC_KEYS.local;

/** Reticulum destination hashes. They are routing ids, not keys; the audit does not treat them as secrets. */
export const RNS_HASHES = { dest: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', peer: '0f9e8d7c6b5a49382716f5e4d3c2b1a0' } as const;

export const RAW = {
  MT: Buffer.from('a5e7c0de1122334455667788', 'hex'),
  MC: Buffer.from('a5e7c0df1122334455667788', 'hex'),
  MQTT: Buffer.from('a5e7c0e01122334455667788', 'hex'),
} as const;

// ── Timestamps ──────────────────────────────────────────────────────────────

const HOUR = Math.floor(Date.now() / 3_600_000) * 3600;

/** Seconds: `hh:07:42`, `hoursAgo` hours back. Never on an hour boundary. */
export const tsSec = (hoursAgo: number): number => HOUR - 3600 * hoursAgo + 462;
/** Milliseconds: the same instant plus 137 ms. */
export const tsMs = (hoursAgo: number): number => tsSec(hoursAgo) * 1000 + 137;
export const TS_STORE_HOURS: Record<string, number> = { MT: 1, MC: 2, RNS: 3, MQTT: 4 };

// ── Geometry ────────────────────────────────────────────────────────────────

export const GEOM = { altMT: 2741, altMC: 2743, distanceKm: 13.37, bearing: 123.4 } as const;

// ── Catalogue ───────────────────────────────────────────────────────────────

function nameDefs(): SentinelDef[] {
  const store = (v: string): string => (v.includes('-MT-') ? 'MT' : v.includes('-MC-') ? 'MC' : /rns/i.test(v) ? 'RNS' : 'MT');
  return Object.entries(NAMES).map(([k, v]) => ({
    cls: 'longName' as const, store: store(v), label: `name:${k}`, re: new RegExp(esc(v)),
  }));
}

function textDefs(): SentinelDef[] {
  return Object.entries(TEXTS).map(([k, v]) => ({
    cls: 'text' as const,
    store: v.includes(' MT ') ? 'MT' : v.includes(' MC ') ? 'MC' : v.includes('MQTT') ? 'MQTT' : 'RNS',
    label: `text:${k}`,
    re: new RegExp(esc(v)),
  }));
}

function keyDefs(): SentinelDef[] {
  const defs: SentinelDef[] = [];
  defs.push({ cls: 'publicKey', store: 'MT', label: 'key:MT:b64', re: new RegExp(esc(MT_KEY_B64)) });
  defs.push({ cls: 'publicKey', store: 'MT', label: 'key:MT:b64-8', re: new RegExp(esc(MT_KEY_B64.slice(0, 8))) });
  defs.push({ cls: 'publicKey', store: 'MT', label: 'key:MT:hex', re: new RegExp(esc(MT_KEY_HEX.slice(0, 13)), 'i') });
  defs.push({ cls: 'publicKey', store: 'MT', label: 'key:MT-neighbor:b64', re: new RegExp(esc(MT_KEY_B64_NEIGHBOR)) });
  for (const [k, v] of Object.entries(MC_KEYS)) {
    defs.push({ cls: 'publicKey', store: 'MC', label: `key:MC:${k}`, re: new RegExp(esc(v.slice(0, 13)), 'i') });
  }
  return defs;
}

function rawDefs(): SentinelDef[] {
  const defs: SentinelDef[] = [];
  for (const [store, buf] of Object.entries(RAW)) {
    const csv = Array.from(buf.subarray(0, 6)).join(',\\s*');
    defs.push({ cls: 'rawPayload', store, label: `raw:${store}:hex`, re: new RegExp(esc(buf.toString('hex')), 'i') });
    defs.push({ cls: 'rawPayload', store, label: `raw:${store}:b64`, re: new RegExp(esc(buf.toString('base64'))) });
    defs.push({ cls: 'rawPayload', store, label: `raw:${store}:bytes`, re: new RegExp(`(?<!\\d)${csv}(?!\\d)`) });
  }
  return defs;
}

function timestampDefs(): SentinelDef[] {
  const defs: SentinelDef[] = [];
  for (const [store, hoursAgo] of Object.entries(TS_STORE_HOURS)) {
    const s = tsSec(hoursAgo);
    const ms = tsMs(hoursAgo);
    const forms = [String(s), String(s * 1000), String(ms)];
    defs.push({
      cls: 'timestamp', store, label: `ts:${store}`,
      re: new RegExp(`(?<![\\d.])(?:${forms.map(esc).join('|')})(?![\\d])`),
    });
  }
  // ISO text. Seconds are 07:42 and the date part varies; match on the clock part.
  defs.push({ cls: 'timestamp', store: 'ANY', label: 'ts:iso', re: /T\d\d:07:42(?:\.\d+)?Z?/ });
  return defs;
}

function geometryDefs(): SentinelDef[] {
  return [
    { cls: 'geometry', store: 'MT', label: 'geom:altMT', re: new RegExp(`(?<![\\d.])${GEOM.altMT}(?![\\d])`) },
    { cls: 'geometry', store: 'MC', label: 'geom:altMC', re: new RegExp(`(?<![\\d.])${GEOM.altMC}(?![\\d])`) },
    { cls: 'geometry', store: 'MT', label: 'geom:distance', re: new RegExp(`(?<![\\d.])${esc(String(GEOM.distanceKm))}(?![\\d])`) },
    { cls: 'geometry', store: 'MT', label: 'geom:bearing', re: new RegExp(`(?<![\\d.])${esc(String(GEOM.bearing))}(?![\\d])`) },
  ];
}

export const SENTINELS: readonly SentinelDef[] = [
  ...Object.values(COORDS).flatMap(coordDefs),
  ...nameDefs(),
  ...textDefs(),
  ...keyDefs(),
  ...rawDefs(),
  ...timestampDefs(),
  ...geometryDefs(),
];

// ── Self-check ──────────────────────────────────────────────────────────────

/**
 * A sentinel must not survive honest redaction. Returns one message per
 * sentinel value that the 14-bit snap or the hour rounding would leave
 * matching its own pattern.
 */
export function selfCheckSentinels(): string[] {
  const problems: string[] = [];
  const byLabel = new Map(SENTINELS.map((d) => [d.label, d]));
  for (const c of Object.values(COORDS)) {
    for (const [axis, v] of [['lat', c.lat], ['lon', c.lon]] as const) {
      const snapped = snapToPrecisionCell(v, 14, false);
      const snappedInt = snapToPrecisionCell(Math.round(v * 1e7), 14, true);
      const probes = [String(snapped), String(Math.abs(snapped)), String(snappedInt), String(Math.abs(snappedInt)), String(Math.round(snappedInt / 10))];
      for (const label of [`coord:${c.key}:${axis}`, `coord:${c.key}:${axis}:int`]) {
        const def = byLabel.get(label);
        if (!def) continue;
        for (const probe of probes) if (def.re.test(probe)) problems.push(`${label} matches its own snapped value ${probe}`);
      }
    }
  }
  for (const [store, hoursAgo] of Object.entries(TS_STORE_HOURS)) {
    const floored = Math.floor(tsSec(hoursAgo) / 3600) * 3600;
    for (const form of [String(floored), String(floored * 1000), new Date(floored * 1000).toISOString()]) {
      for (const label of [`ts:${store}`, 'ts:iso']) {
        if (byLabel.get(label)?.re.test(form)) problems.push(`${label} matches its own rounded value ${form}`);
      }
    }
  }
  // No sentinel may match another store's plain value.
  return problems;
}

// ── Scanning ────────────────────────────────────────────────────────────────

export interface LeakHit {
  def: SentinelDef;
  /** JSON path with array indexes collapsed to `[]`, `<body>` or `header:<name>`. */
  path: string;
}

/**
 * Random per-request values that cannot carry seeded data. The numeric
 * sentinels (e.g. altitude 2741) are short digit runs, and a 64-hex CSRF token
 * or a session cookie holds one by chance often enough to fail CI at random.
 * The key or header name is still scanned; only the random value is skipped.
 */
const RANDOM_VALUE_KEYS: ReadonlySet<string> = new Set(['csrfToken']);
const RANDOM_VALUE_HEADERS: ReadonlySet<string> = new Set(['set-cookie', 'etag']);

function matchLeaf(value: string, path: string, hits: LeakHit[], defs: readonly SentinelDef[]): void {
  for (const def of defs) if (def.re.test(value)) hits.push({ def, path });
}

/** Walk parsed JSON; test every leaf and every object key. */
export function scanJson(value: unknown, defs: readonly SentinelDef[] = SENTINELS, path = '$', hits: LeakHit[] = []): LeakHit[] {
  if (value === null || value === undefined) return hits;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    matchLeaf(String(value), path, hits, defs);
    return hits;
  }
  if (Array.isArray(value)) {
    for (const item of value) scanJson(item, defs, `${path}[]`, hits);
    return hits;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      matchLeaf(k, `${path}.<key>`, hits, defs);
      if (RANDOM_VALUE_KEYS.has(k) && typeof v === 'string') continue;
      scanJson(v, defs, `${path}.${k}`, hits);
    }
  }
  return hits;
}

export function scanText(text: string, path: string, defs: readonly SentinelDef[] = SENTINELS): LeakHit[] {
  const hits: LeakHit[] = [];
  matchLeaf(text, path, hits, defs);
  return hits;
}

export function scanHeaders(headers: Record<string, unknown>, defs: readonly SentinelDef[] = SENTINELS): LeakHit[] {
  const hits: LeakHit[] = [];
  for (const [name, v] of Object.entries(headers)) {
    if (RANDOM_VALUE_HEADERS.has(name.toLowerCase())) {
      matchLeaf(name, `header:${name}`, hits, defs);
      continue;
    }
    const text = Array.isArray(v) ? v.join(', ') : String(v);
    matchLeaf(`${name}: ${text}`, `header:${name}`, hits, defs);
  }
  return hits;
}

/** Defs the given toggle (alone) must remove, plus the always-on classes. */
export function defsForToggle(toggle: ToggleName): SentinelDef[] {
  return SENTINELS.filter((d) => CLASS_TOGGLE[d.cls] === null || CLASS_TOGGLE[d.cls] === toggle);
}

// ════════════════════════════════════════════════════════════════════════════
// Seeding
// ════════════════════════════════════════════════════════════════════════════

export const SOURCES = {
  mt: 'audit-mt',
  mc: 'audit-mc',
  mci: 'audit-mci',
  rns: 'audit-rns',
  mqtt: 'audit-mqtt',
} as const;

export const MT_NUM = 0x5e17a1e1;
export const MT_NEIGHBOR_NUM = 0x5e17a1e2;
export const MT_LOCAL_NUM = 0x5e17a1e3;
export const MT_OVERRIDE_NUM = 0x5e17a1e4;
export const MT_ESTIMATED_NUM = 0x5e17a1e5;
export const nodeIdOf = (num: number): string => `!${num.toString(16).padStart(8, '0')}`;
export const MT_ID = nodeIdOf(MT_NUM);

export const MQTT_PACKET_ID = 0x5e17c0de;
export const EMBED_PROFILE_ID = 'audit-embed';
export const EMBED_PROFILE_WIDE = 'audit-embed-wide';

/** The subset of the database singleton the seeders use. Typed loosely: seeders pass plain objects the repositories narrow. */
type Db = typeof import('../../services/database.js').default;

export async function seedSources(db: Db): Promise<void> {
  const make = async (id: string, name: string, type: string): Promise<void> => {
    await db.sources.deleteSource(id).catch(() => {});
    await db.sources.createSource({ id, name, type, config: {}, enabled: true } as never);
  };
  await make(SOURCES.mt, 'Audit MT', 'meshtastic_tcp');
  await make(SOURCES.mc, 'Audit MC', 'meshcore');
  await make(SOURCES.mci, 'Audit MC ingest', 'meshcore_mqtt');
  await make(SOURCES.rns, 'Audit RNS', 'reticulum');
  await make(SOURCES.mqtt, 'Audit MQTT', 'mqtt_bridge');
}

/** Anonymous reads, writes and map views every resource: the widest view an operator can grant. */
export async function grantAnonymousEverything(db: Db, anonymousId: number): Promise<void> {
  const { RESOURCES, SOURCEY_RESOURCES } = await import('../../types/permission.js');
  await db.auth.deletePermissionsForUser(anonymousId);
  for (const { id } of RESOURCES) {
    const scopes: Array<string | null> = SOURCEY_RESOURCES.includes(id) ? Object.values(SOURCES) : [null];
    for (const sourceId of scopes) {
      await db.auth.createPermission({
        userId: anonymousId, resource: id, canRead: true, canWrite: true, canViewOnMap: true,
        sourceId, grantedAt: Date.now(), grantedBy: null,
      } as never);
    }
  }
}

export async function seedMeshtastic(db: Db): Promise<void> {
  const sid = SOURCES.mt;
  const t = tsSec(1);
  const tm = tsMs(1);
  const node = (nodeNum: number, fields: Record<string, unknown>): Promise<unknown> =>
    db.nodes.upsertNode(
      {
        nodeNum, nodeId: nodeIdOf(nodeNum), shortName: 'SNTL', hwModel: 43, channel: 0, hopsAway: 1,
        lastHeard: t, firstHeard: t, positionPrecisionBits: 32, positionTimestamp: tm, ...fields,
      } as never,
      sid,
    );
  await node(MT_NUM, {
    longName: NAMES.mtLong,
    publicKey: MT_KEY_B64,
    lastMeshReceivedKey: MT_KEY_B64,
    keyMismatchDetected: true,
    keySecurityIssueDetails: `Key mismatch: node broadcast key ${MT_KEY_B64.slice(0, 8)}...`,
    hasPKC: true,
    latitude: COORDS['MT-node'].lat, longitude: COORDS['MT-node'].lon, altitude: GEOM.altMT,
    snr: 6.5, rssi: -80,
  });
  // The radio reports one position; the operator overrode it with another.
  await node(MT_OVERRIDE_NUM, {
    longName: NAMES.mtOverride,
    latitude: COORDS['MT-device'].lat, longitude: COORDS['MT-device'].lon,
    positionOverrideEnabled: true,
    latitudeOverride: COORDS['MT-override'].lat, longitudeOverride: COORDS['MT-override'].lon,
    altitudeOverride: GEOM.altMT, positionOverrideIsPrivate: false,
  });
  // Heard, but no position: the only kind of node an estimate applies to.
  await node(MT_ESTIMATED_NUM, { longName: NAMES.mtEstimated });
  await node(MT_NEIGHBOR_NUM, {
    longName: NAMES.mtNeighbor, publicKey: MT_KEY_B64_NEIGHBOR,
    latitude: COORDS['MT-neighbor'].lat, longitude: COORDS['MT-neighbor'].lon,
  });
  await node(MT_LOCAL_NUM, {
    longName: NAMES.mtLocal,
    latitude: COORDS['MT-local'].lat, longitude: COORDS['MT-local'].lon,
  });
  await db.settings.setSourceSetting(sid, 'localNodeNum', String(MT_LOCAL_NUM));

  await db.channels.upsertChannel({ id: 0, name: 'Primary', psk: 'AQ==', role: 1, uplinkEnabled: true, downlinkEnabled: true, positionPrecision: 32 }, sid);

  const msg = (n: number, fields: Record<string, unknown>): Promise<unknown> =>
    db.messages.insertMessage(
      {
        id: `${sid}_${MT_NUM}_${n}`, fromNodeNum: MT_NUM, toNodeNum: 0xffffffff, fromNodeId: MT_ID, toNodeId: '!ffffffff',
        channel: 0, portnum: 1, timestamp: tm, rxTime: tm, createdAt: tm, rxSnr: 5.5, rxRssi: -85, hopStart: 3, hopLimit: 2,
        ...fields,
      } as never,
      sid,
    );
  await msg(1, { text: TEXTS.mtChannel, packetId: 1001, requestId: 1001 });
  await msg(2, { text: TEXTS.mtDm, toNodeNum: MT_LOCAL_NUM, toNodeId: nodeIdOf(MT_LOCAL_NUM), channel: -1 });
  await msg(3, { text: TEXTS.mtReply, replyId: 1001 });

  const tel = (type: string, value: number, unit?: string, extra: Record<string, unknown> = {}): Promise<unknown> =>
    db.telemetry.insertTelemetry(
      { nodeId: MT_ID, nodeNum: MT_NUM, telemetryType: type, timestamp: tm, value, unit, createdAt: tm, packetTimestamp: tm, ...extra } as never,
      sid,
    );
  await tel('temperature', 21.5, 'C');
  await tel('batteryLevel', 87, '%');
  await tel('latitude', COORDS['MT-telemetry'].lat, 'deg', { precisionBits: 32 });
  await tel('longitude', COORDS['MT-telemetry'].lon, 'deg', { precisionBits: 32 });
  await tel('altitude', GEOM.altMT, 'm', { precisionBits: 32 });

  await db.traceroutes.insertTraceroute(
    {
      fromNodeNum: MT_LOCAL_NUM, toNodeNum: MT_NUM, fromNodeId: nodeIdOf(MT_LOCAL_NUM), toNodeId: MT_ID,
      route: JSON.stringify([MT_NEIGHBOR_NUM]), routeBack: JSON.stringify([MT_NEIGHBOR_NUM]),
      snrTowards: JSON.stringify([24, 18]), snrBack: JSON.stringify([20, 14]),
      routePositions: JSON.stringify({
        [MT_NEIGHBOR_NUM]: { lat: COORDS['MT-traceroute'].lat, lng: COORDS['MT-traceroute'].lon, alt: GEOM.altMT },
      }),
      channel: 0, packetId: 2002, timestamp: tm, createdAt: tm,
    } as never,
    sid,
  );
  await db.traceroutes.insertRouteSegment(
    {
      fromNodeNum: MT_LOCAL_NUM, toNodeNum: MT_NUM, fromNodeId: nodeIdOf(MT_LOCAL_NUM), toNodeId: MT_ID,
      distanceKm: GEOM.distanceKm, isRecordHolder: true, timestamp: tm, createdAt: tm,
    } as never,
    sid,
  );
  await db.neighbors.insertNeighborInfo(
    { nodeNum: MT_NUM, neighborNodeNum: MT_NEIGHBOR_NUM, snr: 7.5, lastRxTime: t, timestamp: tm, createdAt: tm },
    sid,
  );
  await db.neighbors.insertNeighborInfo(
    { nodeNum: MT_LOCAL_NUM, neighborNodeNum: MT_NUM, snr: 8.5, lastRxTime: t, timestamp: tm, createdAt: tm },
    sid,
  );

  await db.packetLog.insertPacketLog(
    {
      packet_id: 3003, timestamp: tm, from_node: MT_NUM, from_node_id: MT_ID, from_node_longName: NAMES.mtLong,
      to_node: 0xffffffff, to_node_id: '!ffffffff', channel: 0, portnum: 1, portnum_name: 'TEXT_MESSAGE_APP',
      encrypted: false, snr: 5.5, rssi: -85, hop_limit: 2, hop_start: 3, payload_size: RAW.MT.length,
      payload_preview: TEXTS.mtPreview,
      metadata: JSON.stringify({ decoded: TEXTS.mtChannel, raw: RAW.MT.toString('hex'), rawBytes: Array.from(RAW.MT) }),
      direction: 'rx',
    } as never,
    sid,
  );

  await db.nodeNameHistory.record({
    sourceId: sid, protocol: 'meshtastic', nodeKey: String(MT_NUM),
    oldLongName: NAMES.mtLong, newLongName: NAMES.mtLocal, oldShortName: 'SNTL', newShortName: 'SNT2', changedAt: tm,
  } as never);

  await db.waypoints.upsertAsync({
    sourceId: sid, waypointId: 4004, ownerNodeNum: MT_NUM, latitude: COORDS['MT-waypoint'].lat, longitude: COORDS['MT-waypoint'].lon,
    name: TEXTS.mtWaypointName, description: TEXTS.mtWaypoint, channel: 0, expireAt: Math.floor(Date.now() / 1000) + 86_400,
  });
  await db.mapMarkers.create(sid, {
    // Operator-authored (UI only, no mesh origin): shown as is, so not a sentinel.
    label: 'Audit marker', description: 'audit marker note', latitude: COORDS['MT-marker'].lat, longitude: COORDS['MT-marker'].lon,
    altitude: GEOM.altMT, icon: 'pin', color: 'accent',
  }, null);

  await db.estimatedPositions.upsertEstimate({
    nodeNum: MT_ESTIMATED_NUM, nodeId: nodeIdOf(MT_ESTIMATED_NUM),
    latitude: COORDS['MT-estimate'].lat, longitude: COORDS['MT-estimate'].lon,
    uncertaintyKm: GEOM.distanceKm, observationCount: 3, updatedAt: tm,
  });

  await db.coverageReceptions.recordReception({
    sourceId: sid, protocol: 'meshtastic', receiverKind: 'node', receiverId: MT_ID, receiverNodeNum: MT_NUM,
    receiverLatitude: COORDS['MT-coverage'].lat, receiverLongitude: COORDS['MT-coverage'].lon,
    senderId: nodeIdOf(MT_LOCAL_NUM), senderNodeNum: MT_LOCAL_NUM, packetKey: 'audit-pk-1', packetId: 5005, pathKey: 'audit-path-1',
    latitude: COORDS['MT-coverage'].lat, longitude: COORDS['MT-coverage'].lon, altitude: GEOM.altMT,
    snr: 6, rssi: -90, hopStart: 3, hopLimit: 3, hopsAway: 0, channel: 0, rxTime: t, receivedAt: tm,
  });
  await db.coverageSurveys.createSurvey({
    name: NAMES.mtLong, senderId: nodeIdOf(MT_LOCAL_NUM), startAt: tm - 3_600_000, endAt: tm, receivers: null, notes: 'audit survey note',
  });
  await db.directRfContacts.applyDelta({
    sourceId: sid, protocol: 'meshtastic', nodeKey: MT_ID, nodeNum: MT_NUM, dayBucket: Math.floor(tm / 86_400_000),
    firstHeardAt: tm, lastHeardAt: tm, count: 3, bestSnr: 7, bestRssi: -80, snrSum: 18, snrCount: 3, rssiSum: -240, rssiCount: 3,
  } as never);

  await db.embedProfiles.createAsync({
    id: EMBED_PROFILE_ID, name: NAMES.embedProfile, enabled: true, channels: [0], tileset: 'osm', defaultLat: 0, defaultLng: 0,
    defaultZoom: 10, showTooltips: true, showPopups: true, showLegend: true, showPaths: true, showNeighborInfo: true,
    showTraceroutes: true, showMqttNodes: true, pollIntervalSeconds: 30, allowedOrigins: [], sourceId: sid,
  } as never);
}

export async function seedMeshCore(db: Db, sid: string = SOURCES.mc): Promise<void> {
  const tm = tsMs(2);
  await db.meshcore.upsertNode(
    {
      publicKey: MC_KEYS.contact, name: NAMES.mcAdv, advType: 1,
      latitude: COORDS['MC-node'].lat, longitude: COORDS['MC-node'].lon, altitude: GEOM.altMC,
      positionSource: 'contact', lastAdvertHadPosition: true,
      positionOverrideEnabled: true, latitudeOverride: COORDS['MC-contact'].lat, longitudeOverride: COORDS['MC-contact'].lon,
      positionOverrideIsPrivate: false, lastHeard: tm, firstHeard: tm, rssi: -90, snr: 4.5, isFavorite: true,
    } as never,
    sid,
  );
  await db.meshcore.upsertNode(
    { publicKey: MC_KEYS.neighbor, name: NAMES.mcNeighbor, advType: 2, lastHeard: tm, firstHeard: tm } as never,
    sid,
  );
  await db.meshcore.upsertNode(
    {
      publicKey: MC_KEYS.local, name: NAMES.mcLocal, advType: 1, isLocalNode: true,
      latitude: COORDS['MC-local'].lat, longitude: COORDS['MC-local'].lon, lastHeard: tm, firstHeard: tm,
    } as never,
    sid,
  );
  const msg = (id: string, fields: Record<string, unknown>): Promise<unknown> =>
    db.meshcore.insertMessage(
      { id, fromPublicKey: MC_KEYS.contact, fromName: NAMES.mcAdv, toPublicKey: null, text: '', timestamp: tm, rssi: -90, snr: 4.5, messageType: 'channel', createdAt: tm, ...fields } as never,
      sid,
    );
  await msg('audit-mc-dm', { toPublicKey: MC_KEYS.local, text: TEXTS.mcDm, messageType: 'direct' });
  await msg('audit-mc-ch', { toPublicKey: 'channel-0', text: TEXTS.mcChannel, senderNameOverride: NAMES.mcSender });
  // A channel message whose stored text carries the sender name in front, with no senderName column.
  await msg('audit-mc-prefixed', { fromName: null, fromPublicKey: 'channel-0', toPublicKey: null, text: `${NAMES.mcSender}: ${TEXTS.mcPrefixed}` });

  await db.meshcore.insertPacket({
    sourceId: sid, timestamp: tm, payloadType: 4, payloadTypeName: 'ADVERT', routeType: 1, routeTypeName: 'FLOOD',
    pathLenRaw: 0, hopCount: 0, snr: 4.5, rssi: -90, payloadSize: RAW.MC.length, rawHex: RAW.MC.toString('hex'),
    senderPubKey: MC_KEYS.contact, advertName: NAMES.mcAdv, observerId: MC_KEYS.local, srcHash: MC_KEYS.contact.slice(0, 2), createdAt: tm,
  });
  await db.meshcore.insertPositionHistory({
    sourceId: sid, publicKey: MC_KEYS.contact, latitude: COORDS['MC-history'].lat, longitude: COORDS['MC-history'].lon,
    altitude: GEOM.altMC, timestamp: tm, createdAt: tm,
  });
  await db.meshcore.insertNeighborsBatch(sid, MC_KEYS.contact, [
    { neighborPublicKey: MC_KEYS.neighbor, snr: 6.5, lastHeardSecs: 42 },
  ]);
}

export async function seedReticulum(db: Db): Promise<void> {
  const sid = SOURCES.rns;
  const tm = tsMs(3);
  await db.reticulum.upsertDestination(sid, {
    destinationHash: RNS_HASHES.dest, identityHash: RNS_HASHES.dest, appName: 'lxmf', aspects: 'delivery',
    displayName: NAMES.rns, hops: 2, rssi: -88, snr: 4, quality: 80, announceAt: tm,
  });
  await db.reticulum.upsertDestination(sid, {
    destinationHash: RNS_HASHES.peer, identityHash: RNS_HASHES.peer, appName: 'lxmf', aspects: 'delivery', displayName: NAMES.rnsPeer, announceAt: tm,
  });
  await db.reticulum.upsertInterface(sid, {
    interfaceName: 'audit0', interfaceType: 'RNodeInterface', status: 'up', online: true, txBytes: 10, rxBytes: 20, lastSeenAt: tm,
  });
  await db.reticulum.upsertMessage(sid, {
    id: 'audit-rns-1', fromHash: RNS_HASHES.peer, toHash: RNS_HASHES.dest, title: TEXTS.rnsTitle, content: TEXTS.rnsContent,
    timestamp: tm, receivedAt: tm, state: 'delivered', method: 'direct', rssi: -88, snr: 4, quality: 80,
  } as never);
}

export async function seedMqtt(db: Db): Promise<void> {
  const tm = tsMs(4);
  await db.mqttPacketLog.insertPacket({
    sourceId: SOURCES.mqtt, packetId: MQTT_PACKET_ID, fromNode: MT_NUM, fromNodeId: MT_ID, toNode: 0xffffffff, toNodeId: '!ffffffff',
    channel: 8, channelId: 'LongFast', gatewayId: MT_ID, gatewayNodeNum: MT_NUM, timestamp: tm, rxTime: tsSec(4), rxSnr: 5, rxRssi: -85,
    hopLimit: 2, hopStart: 3, portnum: 1, portnumName: 'TEXT_MESSAGE_APP', encrypted: 0, decryptedBy: 'server',
    ingestOutcome: 'ingested' as never, payloadSize: RAW.MQTT.length, payloadPreview: `${TEXTS.mqttPreview} ${RAW.MQTT.toString('hex')}`, okToMqttViolation: 0,
    topic: `msh/US/2/e/LongFast/${MT_ID}`, createdAt: tm,
  });
}

export async function seedAll(db: Db): Promise<void> {
  await seedSources(db);
  await seedMeshtastic(db);
  await seedMeshCore(db);
  await seedMeshCore(db, SOURCES.mci);
  await seedReticulum(db);
  await seedMqtt(db);
}

// ════════════════════════════════════════════════════════════════════════════
// Fake managers
// ════════════════════════════════════════════════════════════════════════════

/** Every call to a manager method the fake does not define: a device or radio action. Nothing reaches a radio. */
export const recordedManagerCalls: string[] = [];

type Reads = Record<string, unknown>;

/** A manager that serves the reads in `reads` and records, then ignores, every other method. */
function recordingManager(sourceId: string, reads: Reads): unknown {
  return new Proxy(reads, {
    get(target, prop) {
      if (typeof prop !== 'string' || prop in target) return target[prop as string];
      if (prop === 'then' || prop === 'toJSON') return undefined;
      return (): undefined => {
        recordedManagerCalls.push(`${sourceId}.${prop}`);
        return undefined;
      };
    },
  });
}

const baseReads = (sourceId: string, sourceType: string): Reads => ({
  sourceId,
  sourceType,
  start: async () => undefined,
  stop: async () => undefined,
  getStatus: () => ({ sourceId, sourceName: sourceId, sourceType, connected: true }),
  getConnectionStatus: async () => ({ connected: true, nodeResponsive: true, configuring: false, userDisconnected: false }),
  getLocalNodeInfo: () => null,
});

export async function buildFakeManagers(db: Db): Promise<Record<keyof typeof SOURCES, unknown>> {
  const { MeshCoreManager } = await import('../meshcoreManager.js');
  const toMessage = (row: unknown): unknown =>
    (MeshCoreManager as unknown as { dbRowToMessage: (r: unknown) => unknown }).dbRowToMessage(row);
  const { loadVisibleNodesAcrossSources } = await import('../services/nodeDbMaintenanceService.js');

  const mt = recordingManager(SOURCES.mt, {
    ...baseReads(SOURCES.mt, 'meshtastic_tcp'),
    getLocalNodeInfo: () => ({
      nodeNum: MT_LOCAL_NUM, nodeId: nodeIdOf(MT_LOCAL_NUM), longName: NAMES.mtLocal, shortName: 'LOC', hwModel: 43,
      latitude: COORDS['MT-local'].lat, longitude: COORDS['MT-local'].lon, altitude: GEOM.altMT,
    }),
    getAllNodesAsync: (id?: string) => loadVisibleNodesAcrossSources(id ? [id] : ALL_SOURCES, (row) => row),
    getDeviceConfig: async () => ({
      localNodeInfo: {
        nodeNum: MT_LOCAL_NUM, nodeId: nodeIdOf(MT_LOCAL_NUM), longName: NAMES.mtLocal, shortName: 'LOC',
        latitude: COORDS['MT-local'].lat, longitude: COORDS['MT-local'].lon,
      },
      deviceConfig: {},
    }),
    getRecentMessages: async (limit = 50, sourceId?: string) => {
      const rows = await db.messages.getMessages(limit, 0, sourceId, []);
      return rows.map((m) => ({
        id: m.id, from: m.fromNodeId, to: m.toNodeId, fromNodeId: m.fromNodeId, toNodeId: m.toNodeId, text: m.text,
        channel: m.channel, portnum: m.portnum ?? undefined, timestamp: new Date(m.timestamp), rxTime: m.rxTime,
        hopStart: m.hopStart, hopLimit: m.hopLimit, replyId: m.replyId, emoji: m.emoji, rxSnr: m.rxSnr, rxRssi: m.rxRssi,
        requestId: m.requestId, createdAt: m.createdAt,
      }));
    },
    getDeviceNodeNums: () => [MT_NUM, MT_NEIGHBOR_NUM, MT_LOCAL_NUM],
    getAutoPingSessions: () => [],
    supportsFavorites: () => true,
    isLocalNodeBridged: () => false,
  });

  const mcContact = {
    publicKey: MC_KEYS.contact, name: NAMES.mcAdv, advType: 1, latitude: COORDS['MC-node'].lat, longitude: COORDS['MC-node'].lon,
    altitude: GEOM.altMC, positionSource: 'contact', lastAdvertHadPosition: true, lastHeard: tsMs(2),
  };
  const mc = recordingManager(SOURCES.mc, {
    ...baseReads(SOURCES.mc, 'meshcore'),
    isReceiveOnly: () => false,
    getConnectionStatus: () => ({ connected: true, deviceType: 1, config: null }),
    getLocalNode: () => ({
      publicKey: MC_LOCAL_KEY, name: NAMES.mcLocal, latitude: COORDS['MC-local'].lat, longitude: COORDS['MC-local'].lon,
    }),
    getContactsForView: async () => [mcContact],
    getAllNodes: async () => [mcContact],
    getRecentMessages: () => [
      { id: 'dm', fromPublicKey: MC_KEYS.contact, toPublicKey: MC_LOCAL_KEY, text: TEXTS.mcDm, timestamp: tsMs(2) },
      { id: 'ch0', fromPublicKey: MC_KEYS.contact, senderName: NAMES.mcSender, toPublicKey: 'channel-0', text: TEXTS.mcChannel, timestamp: tsMs(2) },
      { id: 'pre', fromPublicKey: 'channel-0', toPublicKey: null, text: `${NAMES.mcSender}: ${TEXTS.mcPrefixed}`, timestamp: tsMs(2) },
    ],
    getChannelMessages: async (idx: number, limit: number, offset: number, keyAccess?: unknown) =>
      (await db.meshcore.getChannelMessages(idx, limit, SOURCES.mc, offset, keyAccess as never)).reverse().map(toMessage),
    getConversationMessages: async (publicKey: string, limit: number, offset: number, keyAccess?: unknown) =>
      (await db.meshcore.getConversationMessages(publicKey, limit, SOURCES.mc, offset, keyAccess as never)).reverse().map(toMessage),
    getRoomMessages: async (publicKey: string, limit: number, offset: number, keyAccess?: unknown) =>
      (await db.meshcore.getRoomMessages(publicKey, limit, SOURCES.mc, offset, keyAccess as never)).reverse().map(toMessage),
    getRoomServers: () => [{ publicKey: MC_KEYS.neighbor, advName: NAMES.mcNeighbor, name: NAMES.mcNeighbor, advType: 3 }],
    getAutoAddConfig: async () => ({ ok: false, error: 'not available in the audit' }),
    getAutoPathfindingStatus: () => ({ enabled: false, lastRunAt: 0 }),
    canTransmit: () => false,
    getContacts: () => [mcContact],
    getDmPeers: async () => [{ publicKey: MC_KEYS.contact, lastMessageAt: tsMs(2) }],
    getAutoPingSessions: () => [],
    isRoomLoggedIn: () => false,
    isAutoFavoriteRunning: () => false,
    isDistanceDeleteRunning: () => false,
    getRespondToDiscovery: async () => true,
    getDefaultScope: async () => null,
    getDefaultPathHashSize: async () => 2,
  });

  const mci = recordingManager(SOURCES.mci, {
    ...baseReads(SOURCES.mci, 'meshcore_mqtt'),
    isConnected: () => true,
    getObserverStatuses: () => new Map(),
    getFeedEndpoint: () => ({ region: 'US', brokerUrl: 'mqtt://broker.example.invalid:1883' }),
    getAllNodes: async () => [mcContact],
    getRecentMessagesAsync: async () => [
      { id: 'ch0', fromPublicKey: MC_KEYS.contact, senderName: NAMES.mcSender, toPublicKey: 'channel-0', text: TEXTS.mcChannel, timestamp: tsMs(2) },
    ],
  });
  const rns = recordingManager(SOURCES.rns, {
    ...baseReads(SOURCES.rns, 'reticulum'),
    isConnected: () => true,
    getRnsVersion: () => '1.0.0',
    getBridgeVersion: () => '1.0.0',
    getOwnAddresses: () => [RNS_HASHES.dest],
    getAnnounceState: async () => ({ lastAnnounceAt: tsMs(3), cooldownRemainingSeconds: 0, nextPeriodicAnnounceAt: null }),
    getIdentity: async () => ({ destinationHash: RNS_HASHES.dest, displayName: NAMES.rns }),
    getRadioConfig: async () => ({ frequency: 868_000_000, bandwidth: 125_000, spreadingFactor: 8, codingRate: 5, txPower: 14 }),
    getDeviceInfo: async () => ({ displayName: NAMES.rns, destinationHash: RNS_HASHES.dest }),
    getRemoteStatus: async () => ({ type: 'remote_status', destinationHash: RNS_HASHES.peer, ok: true, status: null, path: null, error: null }),
  });
  const mqtt = recordingManager(SOURCES.mqtt, { ...baseReads(SOURCES.mqtt, 'mqtt_bridge') });
  return { mt, mc, mci, rns, mqtt };
}

// ════════════════════════════════════════════════════════════════════════════
// Route parameters
// ════════════════════════════════════════════════════════════════════════════

export const PARAM_DEFAULTS: Readonly<Record<string, string>> = {
  nodeId: MT_ID,
  nodeId1: MT_ID,
  nodeId2: nodeIdOf(MT_LOCAL_NUM),
  nodeNum: String(MT_NUM),
  fromNodeNum: String(MT_LOCAL_NUM),
  toNodeNum: String(MT_NUM),
  nodeKey: MT_ID,
  publicKey: MC_KEYS.contact,
  profileId: EMBED_PROFILE_ID,
  channel: '0',
  idx: '0',
  sourceId: SOURCES.mt,
  hash: RNS_HASHES.dest,
  peerHash: RNS_HASHES.peer,
  threadHash: RNS_HASHES.peer,
  messageId: `${SOURCES.mt}_${MT_NUM}_1`,
  requestId: 'audit-request',
  type: 'temperature',
};

/** `:id` by longest matching route prefix. */
export const ID_PREFIX_RULES: ReadonlyArray<readonly [string, string]> = [
  ['/api/sources/:id/meshcore', SOURCES.mc],
  ['/api/sources/:id/reticulum', SOURCES.rns],
  ['/api/sources/:id/mqtt', SOURCES.mqtt],
  ['/api/sources/:id', SOURCES.mt],
];

export interface ResolvedRoute {
  urls: string[];
  unresolved: string[];
}

/** Fill `:params` from the defaults. A param with no default is returned in `unresolved`. */
export function resolveRoutePath(path: string, ctx: { anonymousId: number }): ResolvedRoute {
  const unresolved: string[] = [];
  const out = path.replace(/:([A-Za-z0-9_]+)\??/g, (_m, name: string) => {
    if (name === 'id') {
      const rule = [...ID_PREFIX_RULES].sort((a, b) => b[0].length - a[0].length).find(([prefix]) => path.startsWith(prefix));
      if (rule) return rule[1];
      if (path.startsWith('/api/users/')) return String(ctx.anonymousId);
      if (path.startsWith('/api/embed-profiles/')) return EMBED_PROFILE_ID;
      unresolved.push(':id');
      return ':id';
    }
    if (name === 'userId') return String(ctx.anonymousId);
    const v = PARAM_DEFAULTS[name];
    if (v === undefined) {
      unresolved.push(`:${name}`);
      return `:${name}`;
    }
    return v;
  });
  return { urls: [out], unresolved };
}

/** Which store a route belongs to by its path (used for the per-protocol floors). */
export function routeProtocol(path: string): 'embed' | 'meshcore' | 'reticulum' | 'mqtt' | 'meshtastic' {
  if (path.startsWith('/api/embed/')) return 'embed';
  if (path.includes('/meshcore')) return 'meshcore';
  if (path.includes('/reticulum')) return 'reticulum';
  if (path.includes('/mqtt')) return 'mqtt';
  return 'meshtastic';
}

/** Query variants for a route. Per-source routes carry their source in the path; the rest are tried against each source. */
export function queryVariants(path: string): string[] {
  if (path.includes('/sources/:id') || path.startsWith('/api/embed/')) return [''];
  return ['', ...Object.values(SOURCES).map((s) => `?sourceId=${s}`)];
}
