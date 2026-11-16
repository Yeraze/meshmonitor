/**
 * Public-instance mode redactor (epic #5156, Phase 1).
 *
 * Pure `redactPublicPayload(body, cfg)`: clones a JSON-bound payload and
 * removes or coarsens identifying fields for anonymous viewers. What counts as
 * a sensitive field lives in {@link PUBLIC_INSTANCE_FIELD_CATALOGUE} as data,
 * so later phases fix leaks by editing the catalogue, not the walker.
 *
 * Rules:
 *  - The input is never mutated. Routes return cached in-memory objects, so the
 *    walker works on a `JSON.parse(JSON.stringify(...))` clone. That clone also
 *    normalises `toJSON`, Date, BigInt (via jsonBigIntReplacer) and Buffer.
 *  - Redacted values become `null` and the key stays; only message text uses a
 *    placeholder. Raw-payload keys are removed.
 *  - Throws on failure (cycle, throwing toJSON). The caller must fail closed.
 *  - When `cfg.enabled` is false the body is returned as is (same reference).
 */
import {
  MESHCORE_ID_PREFIX_HEX,
  PUBLIC_INSTANCE_HIDDEN_TEXT,
  PUBLIC_INSTANCE_PRECISION_BITS,
  type RedactionConfig,
} from '../../utils/publicInstanceMode.js';
import { snapToPrecisionCell } from '../../utils/precisionOffset.js';

export interface FieldClassSpec {
  /** Keys matched by exact name. */
  readonly exact: readonly string[];
  /** Keys matched by pattern. */
  readonly patterns: readonly RegExp[];
  /** Ambiguous keys that match only when one of the listed sibling keys exists. */
  readonly gated?: Readonly<Record<string, readonly string[]>>;
  /** Keys that match only when their value is a string. */
  readonly whenString?: readonly string[];
  /** Keys that match only when their value is an array of numbers. */
  readonly whenNumberArray?: readonly string[];
  /** Keys that never match, even if an exact or pattern rule would. */
  readonly exclude?: readonly RegExp[];
  /**
   * Keys whose value is a plain object keyed by id (node id, channel) with one
   * number per key. The class applies to those numbers (one level). A key in
   * `gated` matches only when a listed sibling key exists.
   */
  readonly valueMaps?: readonly string[];
  /** Like `valueMaps`, but each key matches only when one of its listed siblings exists. */
  readonly gatedValueMaps?: Readonly<Record<string, readonly string[]>>;
}

/** Which objects carry a sender name in front of their text. */
export interface NamePrefixSpec {
  /** Keys holding the text. */
  readonly keys: readonly string[];
  /** Leading `Name: ` to strip. */
  readonly pattern: RegExp;
  /** The object must have one of these `messageType` values, or an id field starting with `idPrefix`. */
  readonly messageTypes: readonly string[];
  readonly idFields: readonly string[];
  readonly idPrefix: string;
  /** If any of these is a non-empty string the text carries no prefix (the name has its own field). */
  readonly nameFields: readonly string[];
}

export const PUBLIC_INSTANCE_FIELD_CATALOGUE = {
  /** Class A: latitude keys. A suffix of `I` or `_i` means a 1e-7 integer. */
  latitude: {
    exact: ['bboxNorth', 'bboxSouth'],
    patterns: [
      /^(lat|latitude)(I|_i|Deg|Override)?$/i,
      /[a-z0-9](Lat|Latitude)(I|Deg|Override)?$/,
      /_(lat|latitude)(_i)?$/,
    ],
  },
  /** Class A: longitude keys. `Long` is excluded on purpose (Reticulum airtimeLong). */
  longitude: {
    exact: ['bboxEast', 'bboxWest'],
    patterns: [
      /^(lon|lng|longitude)(I|_i|Deg|Override)?$/i,
      /[a-z0-9](Lon|Lng|Longitude)(I|Deg|Override)?$/,
      /_(lon|lng|longitude)(_i)?$/,
    ],
  },
  /** Class A: precision keys. Their value applies to the object and its descendants. */
  precision: {
    exact: ['positionPrecisionBits', 'precisionBits', 'precision_bits', 'position_precision_bits'],
    patterns: [],
  },
  /** Class A: arrays whose numeric leaves are coordinates. */
  coordinateArrays: {
    exact: ['pos', 'coordinates', 'latLng', 'latlng', 'positions', 'center', 'bounds'],
    patterns: [],
    whenNumberArray: ['from', 'to'],
  },
  /** Class B (hideLongNames). */
  longNames: {
    exact: [
      'longName', 'long_name', 'advName', 'adv_name', 'advertName',
      'senderName', 'senderNameOverride', 'fromName', 'toName',
      'nodeName', 'neighborName', 'targetName', 'receiverName',
      'fromNodeName', 'toNodeName', 'localName', 'node_name',
    ],
    patterns: [/LongName$/, /_longName$/],
    gated: {
      name: ['publicKey', 'pk', 'nodeNum', 'nodeId', 'advType', 'pos'],
      displayName: ['destinationHash', 'identityHash'],
    },
  },
  /** Class C (hidePublicKeys). Values: 64-hex keeps a prefix, anything else is nulled. */
  publicKeys: {
    // keySecurityIssueDetails carries an 8-char key fragment ("node broadcast key AbCd1234..."); the boolean flags stay.
    exact: ['pk', 'keySecurityIssueDetails'],
    patterns: [/(publicKey|PublicKey|pubKey|PubKey|pubkey|public_key)$/],
  },
  /** Class D (roundTimestamps). */
  timestamps: {
    // seqCursor is the newest message timestamp (clients use it to dedupe).
    exact: ['timestamp', 'time', 'rxTime', 'lastHeard', 'firstHeard', 'lastSeen', 'firstSeen', 'seqCursor'],
    patterns: [/(At|_at|Time|_time|Timestamp|_timestamp|Heard|Seen|Ts)$/],
    // /messages/first-unread: { channels: { "0": ms }, directMessages: { "!id": ms } }. Both keys are too
    // generic to classify alone, so each matches only beside the other.
    gatedValueMaps: { channels: ['directMessages'], directMessages: ['channels'] },
  },
  /** Class E (hideMessageText). */
  messageText: {
    exact: ['text', 'messageText', 'lastMessageText', 'translatedText', 'decodedText', 'reactionRawText', 'replyText'],
    patterns: [],
    gated: {
      // Waypoints arrive from mesh users (WAYPOINT_APP): user content. Operator map markers
      // (label/description, no waypointId) are operator content and stay visible.
      name: ['waypointId'],
      description: ['waypointId'],
      message: ['fromNodeNum', 'fromNodeId', 'fromPublicKey', 'senderPublicKey', 'channel', 'rxTime', 'packetId'],
      body: ['fromNodeNum', 'fromNodeId', 'fromPublicKey', 'senderPublicKey', 'channel', 'rxTime', 'packetId'],
      content: ['fromHash', 'toHash', 'threadHash'],
      title: ['fromHash', 'toHash', 'threadHash'],
    },
  },
  /**
   * Class G: derived geometry, always applied. Distances, bearings and
   * altitudes combined with coarse positions can allow trilateration.
   * Distance in km (also the assumption when a key names no unit): nearest 1.5.
   * Real keys found: distance, distanceKm, rangeKm, reachKm. Ambiguous:
   * bare `distance` (assumed km), `*Distance` settings such as
   * broadcastSmartMinimumDistance (unit unknown, rounded as km).
   */
  distanceKm: {
    exact: ['distance', 'distanceKm', 'distance_km', 'rangeKm', 'range_km', 'maxDistanceKm', 'reachKm', 'reach_km', 'uncertaintyKm', 'uncertainty_km'],
    patterns: [/[a-z0-9]Distance(Km)?$/, /_distance(_km)?$/, /[a-z0-9]UncertaintyKm$/],
    // estimatedUncertainty: { "!nodeId": km } on /telemetry/available/nodes.
    valueMaps: ['estimatedUncertainty'],
    exclude: [/^hop/i],
  },
  /** Class G: distance in metres, nearest 1500. */
  distanceMeters: {
    exact: ['distanceM', 'distanceMeters', 'distance_m', 'distance_meters'],
    patterns: [/[a-z0-9]Distance(M|Meters)$/, /_distance_(m|meters)$/],
    exclude: [/^hop/i],
  },
  /** Class G: bearings and headings in degrees, nearest 10, kept in [0,360). */
  bearing: {
    exact: ['bearing', 'bearingDeg', 'heading', 'azimuth'],
    patterns: [/[a-z0-9](Bearing|BearingDeg|Heading|Azimuth)$/],
  },
  /** Class G: altitudes in metres, nearest 100. */
  altitude: {
    exact: ['altitude', 'alt', 'altitudeM', 'altitude_m', 'altitude_hae', 'altitudeHae', 'altitudeOverride'],
    patterns: [/[a-z0-9]Altitude(M|Hae|Override)?$/, /_altitude(_m|_hae)?$/],
  },
  /** Class F: raw payloads, always removed. */
  rawPayloads: {
    exact: [
      'rawHex', 'raw_hex', 'raw', 'hex', 'bytes',
      'payload', 'rawPayload', 'raw_payload', 'payloadHex', 'payloadBase64',
      'payloadPreview', 'payload_preview', 'encryptedPayload',
      'envelope', 'routePositions', 'deviceInfoJson', 'fields',
    ],
    patterns: [],
    whenString: ['metadata'],
  },
} as const satisfies Record<string, FieldClassSpec>;

/**
 * Class B, value rule. A MeshCore channel message whose sender has no name
 * field carries `Name: body` as its text (the wire format; `mc1ChannelBody`
 * splits it the same way). With hideLongNames on and hideMessageText off the
 * name must not stay in the text.
 */
export const EMBEDDED_SENDER_NAME: NamePrefixSpec = {
  keys: ['text'],
  pattern: /^[^:\n]{1,32}: /,
  messageTypes: ['channel'],
  idFields: ['fromPublicKey', 'toPublicKey', 'fromNodeId'],
  idPrefix: 'channel-',
  nameFields: ['fromName', 'senderName', 'senderNameOverride'],
};

const CAT = PUBLIC_INSTANCE_FIELD_CATALOGUE;

/** Plain-object view of the catalogue's gated map (avoids literal-key typing). */
const gatedSiblings = (spec: FieldClassSpec, key: string): readonly string[] | undefined => spec.gated?.[key];

type GeomKind = 'km' | 'm' | 'bearing' | 'altitude';

interface KeyFlags {
  drop: boolean;
  dropIfString: boolean;
  axis: 'lat' | 'lon' | null;
  intUnits: boolean;
  geom: GeomKind | null;
  precision: boolean;
  pk: boolean;
  name: boolean;
  nameGate?: readonly string[];
  ts: boolean;
  text: boolean;
  textGate?: readonly string[];
  coordArray: boolean;
  coordArrayIfNumbers: boolean;
  kmMap: boolean;
  tsMapGate?: readonly string[];
  namePrefixKey: boolean;
}

const matches = (spec: FieldClassSpec, key: string): boolean =>
  !spec.exclude?.some((p) => p.test(key)) && (spec.exact.includes(key) || spec.patterns.some((p) => p.test(key)));

const KEY_CACHE_MAX = 5000;
const keyCache = new Map<string, KeyFlags>();

function classifyKey(key: string): KeyFlags {
  const hit = keyCache.get(key);
  if (hit) return hit;
  const axis = matches(CAT.latitude, key) ? 'lat' : matches(CAT.longitude, key) ? 'lon' : null;
  const flags: KeyFlags = {
    drop: CAT.rawPayloads.exact.includes(key as never),
    dropIfString: (CAT.rawPayloads.whenString as readonly string[]).includes(key),
    axis,
    intUnits: axis !== null && /(I|_i)$/.test(key),
    geom: matches(CAT.distanceMeters, key)
      ? 'm'
      : matches(CAT.distanceKm, key)
        ? 'km'
        : matches(CAT.bearing, key)
          ? 'bearing'
          : matches(CAT.altitude, key)
            ? 'altitude'
            : null,
    precision: matches(CAT.precision, key),
    pk: matches(CAT.publicKeys, key),
    name: matches(CAT.longNames, key),
    nameGate: gatedSiblings(CAT.longNames, key),
    ts: matches(CAT.timestamps, key),
    text: matches(CAT.messageText, key),
    textGate: gatedSiblings(CAT.messageText, key),
    coordArray: CAT.coordinateArrays.exact.includes(key as never),
    coordArrayIfNumbers: (CAT.coordinateArrays.whenNumberArray as readonly string[]).includes(key),
    kmMap: (CAT.distanceKm.valueMaps as readonly string[]).includes(key),
    tsMapGate: CAT.timestamps.gatedValueMaps[key as keyof typeof CAT.timestamps.gatedValueMaps],
    namePrefixKey: EMBEDDED_SENDER_NAME.keys.includes(key),
  };
  if (keyCache.size >= KEY_CACHE_MAX) keyCache.clear();
  keyCache.set(key, flags);
  return flags;
}

const HEX64_RUN = /(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/g;
const HEX64 = /^[0-9a-fA-F]{64}$/;
const HEX_PREFIX = new RegExp(`^[0-9a-fA-F]{${MESHCORE_ID_PREFIX_HEX}}$`);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T/;
const HOUR_MS = 3_600_000;
const HOUR_S = 3_600;

const truncateHexRuns = (s: string): string => s.replace(HEX64_RUN, (m) => m.slice(0, MESHCORE_ID_PREFIX_HEX));

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function roundTimestampNumber(v: number): number {
  if (!Number.isFinite(v)) return v;
  if (v >= 1e11) return Math.floor(v / HOUR_MS) * HOUR_MS;
  if (v >= 1e9) return Math.floor(v / HOUR_S) * HOUR_S;
  return v;
}

function roundTimestamp(v: unknown): unknown {
  if (isNumeric(v)) return mapNumeric(v, roundTimestampNumber);
  if (typeof v === 'string' && ISO_DATE.test(v)) {
    const ms = Date.parse(v);
    if (Number.isNaN(ms)) return v;
    return new Date(Math.floor(ms / HOUR_MS) * HOUR_MS).toISOString();
  }
  return v;
}

const NUMERIC_STRING = /^-?\d+(\.\d+)?$/;

/** A finite number, or a numeric string (PG/MySQL BIGINT and BigInt JSON arrive as strings). */
const isNumeric = (v: unknown): v is number | string =>
  typeof v === 'number' || (typeof v === 'string' && NUMERIC_STRING.test(v));

/**
 * Apply a numeric redaction to a number or a numeric string. A string comes back
 * as a string; a zero or non-finite string is returned unchanged.
 */
function mapNumeric(v: number | string, fn: (n: number) => number): number | string {
  if (typeof v === 'number') return fn(v);
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return v;
  return String(fn(n));
}

const roundTo = (v: number, step: number): number => Math.round(v / step) * step || 0;

/** Coarsen a derived-geometry number. Non-finite and exact 0 pass unchanged. */
function roundGeometry(v: number, kind: GeomKind): number {
  if (!Number.isFinite(v) || v === 0) return v;
  switch (kind) {
    case 'km': return roundTo(v, 1.5);
    case 'm': return roundTo(v, 1500);
    case 'altitude': return roundTo(v, 100);
    case 'bearing': {
      return ((roundTo(v, 10) % 360) + 360) % 360;
    }
  }
}

function redactPublicKeyValue(v: unknown): unknown {
  if (typeof v !== 'string') return null;
  if (HEX64.test(v)) return v.slice(0, MESHCORE_ID_PREFIX_HEX);
  // An already-truncated prefix is not a base64 key; keeping it makes redaction idempotent.
  if (HEX_PREFIX.test(v)) return v;
  return null;
}

interface Ctx {
  /** Inherited precision bits. `undefined` = none seen; `null` = seen but null. */
  bits: number | null | undefined;
  /** True while inside an array whose numeric leaves are coordinates. */
  coord: boolean;
}

const isBufferShape = (o: Record<string, unknown>): boolean => o.type === 'Buffer' && Array.isArray(o.data);

/** Coordinates are snapped unless the context already declares 1..13 bits. */
const snapActive = (bits: number | null | undefined): boolean =>
  !(typeof bits === 'number' && bits >= 1 && bits < PUBLIC_INSTANCE_PRECISION_BITS);

function snapNumber(v: number, ctx: Ctx, intUnits: boolean): number {
  if (!Number.isFinite(v) || v === 0) return v;
  // Always snap (fail closed): a coarse declared precision can sit beside an exact
  // override. Snapping is idempotent for positions already on the declared grid.
  const bits = snapActive(ctx.bits) ? PUBLIC_INSTANCE_PRECISION_BITS : (ctx.bits as number);
  return snapToPrecisionCell(v, bits, intUnits);
}

function walk(value: unknown, ctx: Ctx, cfg: RedactionConfig): unknown {
  if (ctx.coord && isNumeric(value)) return mapNumeric(value, (n) => snapNumber(n, ctx, false));
  if (typeof value === 'string') return cfg.hidePublicKeys ? truncateHexRuns(value) : value;
  if (Array.isArray(value)) return value.map((item) => walk(item, ctx, cfg));
  if (isRecord(value)) return walkObject(value, ctx, cfg);
  return value;
}

const PRECISION_KEYS = CAT.precision.exact;

/** Apply `fn` to each number in a plain object keyed by id (one level); walk anything else. */
function mapValues(
  map: Record<string, unknown>,
  fn: (n: number) => number,
  ctx: Ctx,
  cfg: RedactionConfig,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(map)) {
    out[cfg.hidePublicKeys ? truncateHexRuns(k) : k] = isNumeric(v) ? mapNumeric(v, fn) : walk(v, ctx, cfg);
  }
  return out;
}

/** True for a MeshCore channel message whose text starts with the sender's name. */
function hasEmbeddedSenderName(obj: Record<string, unknown>): boolean {
  const spec = EMBEDDED_SENDER_NAME;
  const channelShaped =
    (typeof obj.messageType === 'string' && spec.messageTypes.includes(obj.messageType)) ||
    spec.idFields.some((f) => typeof obj[f] === 'string' && (obj[f] as string).startsWith(spec.idPrefix));
  if (!channelShaped) return false;
  return !spec.nameFields.some((f) => typeof obj[f] === 'string' && (obj[f] as string).length > 0);
}

function walkObject(obj: Record<string, unknown>, parent: Ctx, cfg: RedactionConfig): unknown {
  if (isBufferShape(obj)) return null;

  const keys = Object.keys(obj);
  let bits = parent.bits;
  for (const pk of PRECISION_KEYS) {
    if (pk in obj) {
      const v = obj[pk];
      bits = isNumeric(v) ? Number(v) : null;
      break;
    }
  }
  const ctx: Ctx = { bits, coord: false };
  const hasSibling = (names: readonly string[]): boolean => names.some((n) => n in obj);
  const telemetryPos = typeof obj.telemetryType === 'string' && /lat|lon/i.test(obj.telemetryType);

  const telemetryAlt = typeof obj.telemetryType === 'string' && /altitude/i.test(obj.telemetryType);

  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const v = obj[key];
    const f = classifyKey(key);
    if (f.drop || (f.dropIfString && typeof v === 'string')) continue;
    const outKey = cfg.hidePublicKeys ? truncateHexRuns(key) : key;

    if (f.axis && isNumeric(v)) {
      out[outKey] = mapNumeric(v, (n) => snapNumber(n, ctx, f.intUnits));
    } else if (telemetryPos && key === 'value' && isNumeric(v)) {
      out[outKey] = mapNumeric(v, (n) => snapNumber(n, ctx, false));
    } else if (f.geom && isNumeric(v)) {
      const kind = f.geom;
      out[outKey] = mapNumeric(v, (n) => roundGeometry(n, kind));
    } else if (telemetryAlt && key === 'value' && isNumeric(v)) {
      out[outKey] = mapNumeric(v, (n) => roundGeometry(n, 'altitude'));
    } else if (f.precision) {
      // A string stays a string ('13' stays '13'; '32' becomes '14').
      out[outKey] = isNumeric(v) && snapActive(ctx.bits)
        ? (typeof v === 'string' ? String(PUBLIC_INSTANCE_PRECISION_BITS) : PUBLIC_INSTANCE_PRECISION_BITS)
        : v;
    } else if (cfg.hidePublicKeys && f.pk) {
      out[outKey] = redactPublicKeyValue(v);
    } else if (cfg.hideLongNames && (f.name || (f.nameGate && hasSibling(f.nameGate)))) {
      out[outKey] = null;
    } else if (cfg.roundTimestamps && f.ts && (typeof v === 'number' || typeof v === 'string')) {
      out[outKey] = roundTimestamp(v);
    } else if (
      cfg.hideMessageText &&
      typeof v === 'string' &&
      (f.text || (f.textGate && hasSibling(f.textGate)))
    ) {
      out[outKey] = PUBLIC_INSTANCE_HIDDEN_TEXT;
    } else if (f.kmMap && isRecord(v)) {
      out[outKey] = mapValues(v, (n) => roundGeometry(n, 'km'), ctx, cfg);
    } else if (cfg.roundTimestamps && f.tsMapGate && hasSibling(f.tsMapGate) && isRecord(v)) {
      out[outKey] = mapValues(v, roundTimestampNumber, ctx, cfg);
    } else if (
      cfg.hideLongNames && f.namePrefixKey && typeof v === 'string' && hasEmbeddedSenderName(obj)
    ) {
      out[outKey] = v.replace(EMBEDDED_SENDER_NAME.pattern, '');
    } else {
      const coord = f.coordArray || (f.coordArrayIfNumbers && Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'number'));
      out[outKey] = walk(v, coord ? { bits: ctx.bits, coord: true } : ctx, cfg);
    }
  }
  return out;
}

/**
 * Return a redacted deep copy of `body`. Pure; never mutates `body`.
 * Throws if the body cannot be serialised (the caller must fail closed).
 */
export function redactPublicPayload(body: unknown, cfg: RedactionConfig): unknown {
  if (!cfg.enabled) return body;
  const json = JSON.stringify(body);
  if (json === undefined) return body;
  const clone: unknown = JSON.parse(json);
  return walk(clone, { bits: undefined, coord: false }, cfg);
}
