/**
 * Binary format of the offline geocoder's embedded data (#6336).
 *
 * The generator (`scripts/geo/build-offline-geocoder.ts`) encodes; the server
 * only decodes. Both live here so the format has one definition.
 *
 * Coordinates are integers: degrees times {@link COORD_SCALE}. Integer input
 * makes the point-in-polygon test give the same answer on every platform.
 *
 * Admin-1 blob:
 *   "MMA1", varint metaLen, meta JSON (UTF-8), then per feature:
 *   varint ringCount, then per ring: varint vertexCount and the vertices as
 *   zigzag varint deltas (lon, lat) from the previous vertex in the stream.
 *   Rings are open: the closing vertex is not repeated.
 *
 * Cities blob:
 *   "MMC1", varint metaLen, meta JSON (names), varint count, then five columns
 *   of `count` varints: feature index delta, lat delta (zigzag), lon delta
 *   (zigzag), population, geonameid delta (zigzag). Cities are sorted by
 *   feature index, so each feature's cities form one run.
 */

/** Degrees to integer units: 1e-5 degrees is about 1.1 m. */
export const COORD_SCALE = 1e5;

const ADMIN1_MAGIC = 'MMA1';
const CITIES_MAGIC = 'MMC1';

/** One subdivision (or a country with no ISO 3166-2 subdivision). */
export interface Admin1Feature {
  /** ISO 3166-1 alpha-2. */
  cc: string;
  /** Top-level ISO 3166-2 code, e.g. `US-WA`. Absent for country-only areas. */
  code?: string;
  /** Natural Earth name, e.g. `Washington`. Absent for country-only areas. */
  name?: string;
}

export interface Admin1Data {
  /** Data version string; the cities blob must carry the same one. */
  version: string;
  features: Admin1Feature[];
  /** Ring index range per feature: rings of feature f are featRing[f]..featRing[f+1]. */
  featRing: Uint32Array;
  /** Vertex index range per ring. */
  ringStart: Uint32Array;
  /** Interleaved lon, lat in integer units. */
  coords: Int32Array;
  /** Per feature: minLon, minLat, maxLon, maxLat. */
  bbox: Int32Array;
}

export interface Admin1EncodeInput {
  version: string;
  /** Rings hold integer [lon, lat] pairs, open (no repeated closing vertex). */
  features: Array<Admin1Feature & { rings: Array<Array<[number, number]>> }>;
}

export interface CityRecord {
  /** GeoNames geonameid. */
  id: number;
  name: string;
  /** Integer units. */
  lat: number;
  lon: number;
  population: number;
  /** Index into the admin-1 features. */
  feature: number;
}

export interface CitiesData {
  version: string;
  names: string[];
  /** City index range per feature. Length is featureCount + 1. */
  featCity: Uint32Array;
  lat: Int32Array;
  lon: Int32Array;
  population: Uint32Array;
  id: Uint32Array;
}

/** Growable byte buffer. Used only by the generator and tests. */
export class ByteWriter {
  private buf = new Uint8Array(1 << 16);
  private len = 0;

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }

  /** Unsigned varint. Arithmetic, not bitwise, so values above 2^31 work. */
  varint(n: number): void {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`varint out of range: ${n}`);
    this.ensure(10);
    let v = n;
    while (v >= 0x80) {
      this.buf[this.len++] = (v % 0x80) | 0x80;
      v = Math.floor(v / 0x80);
    }
    this.buf[this.len++] = v;
  }

  /** Signed varint (zigzag). */
  zigzag(n: number): void {
    this.varint(n >= 0 ? n * 2 : -n * 2 - 1);
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

export class ByteReader {
  pos = 0;
  constructor(private readonly buf: Uint8Array) {}

  bytes(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new Error('geo data truncated');
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  varint(): number {
    let result = 0;
    let mul = 1;
    for (;;) {
      if (this.pos >= this.buf.length) throw new Error('geo data truncated');
      const b = this.buf[this.pos++];
      result += (b & 0x7f) * mul;
      if (b < 0x80) return result;
      mul *= 0x80;
      if (mul > 2 ** 49) throw new Error('geo data varint too long');
    }
  }

  zigzag(): number {
    const v = this.varint();
    return v % 2 === 0 ? v / 2 : -(v + 1) / 2;
  }
}

const utf8 = new TextEncoder();
const utf8Decode = new TextDecoder('utf-8', { fatal: true });

function writeHeader(w: ByteWriter, magic: string, meta: unknown): void {
  w.bytes(utf8.encode(magic));
  const json = utf8.encode(JSON.stringify(meta));
  w.varint(json.length);
  w.bytes(json);
}

function readHeader<T>(r: ByteReader, magic: string): T {
  const got = utf8Decode.decode(r.bytes(4));
  if (got !== magic) throw new Error(`geo data: expected ${magic}, got ${JSON.stringify(got)}`);
  const len = r.varint();
  return JSON.parse(utf8Decode.decode(r.bytes(len))) as T;
}

type Admin1Meta = { version: string; features: Array<[string, string | null, string | null]> };

export function encodeAdmin1(input: Admin1EncodeInput): Uint8Array {
  const w = new ByteWriter();
  const meta: Admin1Meta = {
    version: input.version,
    features: input.features.map((f) => [f.cc, f.code ?? null, f.name ?? null]),
  };
  writeHeader(w, ADMIN1_MAGIC, meta);
  let px = 0;
  let py = 0;
  for (const f of input.features) {
    w.varint(f.rings.length);
    for (const ring of f.rings) {
      w.varint(ring.length);
      for (const [x, y] of ring) {
        if (!Number.isInteger(x) || !Number.isInteger(y)) throw new Error('admin1 coords must be integers');
        w.zigzag(x - px);
        w.zigzag(y - py);
        px = x;
        py = y;
      }
    }
  }
  return w.finish();
}

export function decodeAdmin1(bytes: Uint8Array): Admin1Data {
  const r = new ByteReader(bytes);
  const meta = readHeader<Admin1Meta>(r, ADMIN1_MAGIC);
  const n = meta.features.length;
  const features: Admin1Feature[] = meta.features.map(([cc, code, name]) => ({
    cc,
    ...(code ? { code } : {}),
    ...(name ? { name } : {}),
  }));

  // Pass 1 reads counts so the typed arrays are allocated once.
  const start = r.pos;
  let rings = 0;
  let verts = 0;
  for (let f = 0; f < n; f++) {
    const rc = r.varint();
    rings += rc;
    for (let i = 0; i < rc; i++) {
      const vc = r.varint();
      verts += vc;
      for (let k = 0; k < vc * 2; k++) r.varint();
    }
  }
  if (r.pos !== bytes.length) throw new Error('geo data: trailing bytes after admin1');

  const featRing = new Uint32Array(n + 1);
  const ringStart = new Uint32Array(rings + 1);
  const coords = new Int32Array(verts * 2);
  const bbox = new Int32Array(n * 4);
  r.pos = start;
  let ring = 0;
  let v = 0;
  let px = 0;
  let py = 0;
  for (let f = 0; f < n; f++) {
    featRing[f] = ring;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const rc = r.varint();
    for (let i = 0; i < rc; i++) {
      ringStart[ring++] = v;
      const vc = r.varint();
      for (let k = 0; k < vc; k++) {
        px += r.zigzag();
        py += r.zigzag();
        coords[v * 2] = px;
        coords[v * 2 + 1] = py;
        v++;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
    }
    // A feature with no vertices gets an empty box that nothing falls inside.
    bbox[f * 4] = rc ? minX : 1;
    bbox[f * 4 + 1] = rc ? minY : 1;
    bbox[f * 4 + 2] = rc ? maxX : 0;
    bbox[f * 4 + 3] = rc ? maxY : 0;
  }
  featRing[n] = ring;
  ringStart[rings] = v;
  return { version: meta.version, features, featRing, ringStart, coords, bbox };
}

type CitiesMeta = { version: string; featureCount: number; names: string[] };

/** `cities` must be sorted by feature, then geonameid. */
export function encodeCities(version: string, featureCount: number, cities: CityRecord[]): Uint8Array {
  for (let i = 1; i < cities.length; i++) {
    const a = cities[i - 1];
    const b = cities[i];
    if (a.feature > b.feature || (a.feature === b.feature && a.id >= b.id)) {
      throw new Error('cities must be sorted by feature, then id');
    }
  }
  const w = new ByteWriter();
  const meta: CitiesMeta = { version, featureCount, names: cities.map((c) => c.name) };
  writeHeader(w, CITIES_MAGIC, meta);
  w.varint(cities.length);
  let prev = 0;
  for (const c of cities) {
    w.varint(c.feature - prev);
    prev = c.feature;
  }
  prev = 0;
  for (const c of cities) {
    w.zigzag(c.lat - prev);
    prev = c.lat;
  }
  prev = 0;
  for (const c of cities) {
    w.zigzag(c.lon - prev);
    prev = c.lon;
  }
  for (const c of cities) w.varint(c.population);
  prev = 0;
  for (const c of cities) {
    w.zigzag(c.id - prev);
    prev = c.id;
  }
  return w.finish();
}

export function decodeCities(bytes: Uint8Array): CitiesData {
  const r = new ByteReader(bytes);
  const meta = readHeader<CitiesMeta>(r, CITIES_MAGIC);
  const count = r.varint();
  if (count !== meta.names.length) throw new Error('geo data: city count mismatch');
  const featCity = new Uint32Array(meta.featureCount + 1);
  const lat = new Int32Array(count);
  const lon = new Int32Array(count);
  const population = new Uint32Array(count);
  const id = new Uint32Array(count);

  let feature = 0;
  for (let i = 0; i < count; i++) {
    const next = feature + r.varint();
    if (next >= meta.featureCount) throw new Error('geo data: city feature out of range');
    // Every feature up to and including `next` starts at or before city i.
    for (let f = feature + 1; f <= next; f++) featCity[f] = i;
    feature = next;
  }
  for (let f = feature + 1; f <= meta.featureCount; f++) featCity[f] = count;
  // Features before the first city's feature start at 0 already.

  let acc = 0;
  for (let i = 0; i < count; i++) lat[i] = acc += r.zigzag();
  acc = 0;
  for (let i = 0; i < count; i++) lon[i] = acc += r.zigzag();
  for (let i = 0; i < count; i++) population[i] = r.varint();
  acc = 0;
  for (let i = 0; i < count; i++) id[i] = acc += r.zigzag();
  if (r.pos !== bytes.length) throw new Error('geo data: trailing bytes after cities');
  return { version: meta.version, names: meta.names, featCity, lat, lon, population, id };
}
