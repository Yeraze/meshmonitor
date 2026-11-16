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
    ],
    patterns: [/LongName$/],
    gated: {
      name: ['publicKey', 'pk', 'nodeNum', 'nodeId', 'advType', 'pos'],
      displayName: ['destinationHash', 'identityHash'],
    },
  },
  /** Class C (hidePublicKeys). Values: 64-hex keeps a prefix, anything else is nulled. */
  publicKeys: {
    exact: ['pk'],
    patterns: [/(publicKey|PublicKey|pubKey|PubKey|pubkey|public_key)$/],
  },
  /** Class D (roundTimestamps). */
  timestamps: {
    exact: ['timestamp', 'time', 'rxTime', 'lastHeard', 'firstHeard', 'lastSeen', 'firstSeen'],
    patterns: [/(At|_at|Time|_time|Timestamp|_timestamp|Heard|Seen|Ts)$/],
  },
  /** Class E (hideMessageText). */
  messageText: {
    exact: ['text', 'messageText', 'lastMessageText', 'translatedText', 'decodedText', 'reactionRawText', 'replyText'],
    patterns: [],
    gated: {
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
    exact: ['distance', 'distanceKm', 'distance_km', 'rangeKm', 'range_km', 'maxDistanceKm', 'reachKm', 'reach_km'],
    patterns: [/[a-z0-9]Distance(Km)?$/, /_distance(_km)?$/],
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
      const r = roundTo(v, 10);
      return v >= 0 && r >= 360 ? r - 360 : r;
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
  if (!Number.isFinite(v) || v === 0 || !snapActive(ctx.bits)) return v;
  return snapToPrecisionCell(v, PUBLIC_INSTANCE_PRECISION_BITS, intUnits);
}

function walk(value: unknown, ctx: Ctx, cfg: RedactionConfig): unknown {
  if (ctx.coord && isNumeric(value)) return mapNumeric(value, (n) => snapNumber(n, ctx, false));
  if (typeof value === 'string') return cfg.hidePublicKeys ? truncateHexRuns(value) : value;
  if (Array.isArray(value)) return value.map((item) => walk(item, ctx, cfg));
  if (isRecord(value)) return walkObject(value, ctx, cfg);
  return value;
}

const PRECISION_KEYS = CAT.precision.exact;

function walkObject(obj: Record<string, unknown>, parent: Ctx, cfg: RedactionConfig): unknown {
  if (isBufferShape(obj)) return null;

  const keys = Object.keys(obj);
  let bits = parent.bits;
  for (const pk of PRECISION_KEYS) {
    if (pk in obj) {
      const v = obj[pk];
      bits = typeof v === 'number' ? v : null;
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
      out[outKey] = typeof v === 'number' && snapActive(ctx.bits) ? PUBLIC_INSTANCE_PRECISION_BITS : v;
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
