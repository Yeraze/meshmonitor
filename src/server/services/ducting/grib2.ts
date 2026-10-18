/**
 * Minimal GRIB2 reader for the tropospheric-ducting spike (#5734).
 *
 * It reads only what the NOMADS grib filter returns for a regional GFS cut:
 * a regular lat/lon grid (grid template 3.0), an analysis or forecast at one
 * level (product template 4.0), and simple packing (data template 5.0). The
 * filter repacks every subset it cuts as 5.0, which is what makes a decoder
 * this small enough to own. Anything else is refused by name, so a format
 * change upstream fails loudly instead of decoding garbage.
 *
 * Spec: WMO Manual on Codes, FM 92 GRIB edition 2. Octet numbers in the
 * comments are 1-based, as the spec writes them.
 */

export interface Grib2Grid {
  /** Points along a parallel (columns). */
  ni: number;
  /** Points along a meridian (rows). */
  nj: number;
  /** First grid point, degrees. Longitude is normalized to -180..180. */
  lat1: number;
  lon1: number;
  /** Increments, degrees, always positive. */
  dLat: number;
  dLon: number;
  /** True when rows run north to south (scanning-mode bit 0x40 clear). */
  northToSouth: boolean;
}

export interface Grib2Message {
  /** Model reference (cycle) time. */
  referenceTime: Date;
  /** Forecast offset from the reference time, hours. */
  forecastHours: number;
  /** Discipline from section 0 (0 = meteorological). */
  discipline: number;
  category: number;
  parameter: number;
  /** Code table 4.5: 1 = ground, 100 = isobaric, 103 = height above ground. */
  surfaceType: number;
  /** Level value in the surface's unit (Pa for isobaric, m for 103). */
  surfaceValue: number;
  grid: Grib2Grid;
  /** Row-major, north row first, west to east within a row. */
  values: Float32Array;
}

export class Grib2FormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Grib2FormatError';
  }
}

/** Sign-magnitude integers, as GRIB2 stores signed values. */
function signed16(v: number): number {
  return v & 0x8000 ? -(v & 0x7fff) : v;
}
function signed32(v: number): number {
  return v & 0x80000000 ? -(v & 0x7fffffff) : v;
}

function scaledLevel(scale: number, value: number): number {
  if (value === 0xffffffff) return NaN;
  const s = scale & 0x80 ? -(scale & 0x7f) : scale;
  return value / Math.pow(10, s);
}

const toLon180 = (lon: number): number => (lon > 180 ? lon - 360 : lon);

interface Sections {
  referenceTime?: Date;
  grid?: Grib2Grid;
  npts?: number;
  product?: Pick<Grib2Message, 'category' | 'parameter' | 'surfaceType' | 'surfaceValue' | 'forecastHours'>;
  packing?: { r: number; e: number; d: number; nbits: number; count: number };
  bitmap?: Uint8Array | null;
  data?: Buffer;
}

function readGrid(buf: Buffer, p: number): { grid: Grib2Grid; npts: number } {
  const npts = buf.readUInt32BE(p + 6); // octets 7-10
  const template = buf.readUInt16BE(p + 12); // octets 13-14
  if (template !== 0) throw new Grib2FormatError(`grid template 3.${template} is not supported (need 3.0)`);
  const ni = buf.readUInt32BE(p + 30); // 31-34
  const nj = buf.readUInt32BE(p + 34); // 35-38
  const basicAngle = buf.readUInt32BE(p + 38); // 39-42
  const subdivisions = buf.readUInt32BE(p + 42); // 43-46
  const unit =
    basicAngle === 0 || basicAngle === 0xffffffff || subdivisions === 0xffffffff
      ? 1e-6
      : basicAngle / subdivisions;
  const lat1 = signed32(buf.readUInt32BE(p + 46)) * unit; // 47-50
  const lon1 = buf.readUInt32BE(p + 50) * unit; // 51-54
  const dLon = buf.readUInt32BE(p + 63) * unit; // 64-67
  const dLat = buf.readUInt32BE(p + 67) * unit; // 68-71
  const scan = buf[p + 71]; // 72
  // Only bit 0x40 (+j, south to north) may vary. Negative-i and
  // column-major scans are not used by GFS.
  if ((scan & ~0x40) !== 0) throw new Grib2FormatError(`scanning mode 0x${scan.toString(16)} is not supported`);
  if (ni * nj !== npts) throw new Grib2FormatError(`grid is ${ni}x${nj} but declares ${npts} points`);
  return { grid: { ni, nj, lat1, lon1: toLon180(lon1), dLat, dLon, northToSouth: (scan & 0x40) === 0 }, npts };
}

function readProduct(buf: Buffer, p: number): NonNullable<Sections['product']> {
  const template = buf.readUInt16BE(p + 7); // octets 8-9
  if (template !== 0) throw new Grib2FormatError(`product template 4.${template} is not supported (need 4.0)`);
  const timeUnit = buf[p + 17]; // 18
  const time = buf.readUInt32BE(p + 18); // 19-22
  // Code table 4.4: 0 = minute, 1 = hour, 2 = day.
  const hoursPerUnit = timeUnit === 0 ? 1 / 60 : timeUnit === 1 ? 1 : timeUnit === 2 ? 24 : NaN;
  if (Number.isNaN(hoursPerUnit)) throw new Grib2FormatError(`forecast time unit ${timeUnit} is not supported`);
  return {
    category: buf[p + 9], // 10
    parameter: buf[p + 10], // 11
    forecastHours: time * hoursPerUnit,
    surfaceType: buf[p + 22], // 23
    surfaceValue: scaledLevel(buf[p + 23], buf.readUInt32BE(p + 24)), // 24, 25-28
  };
}

function readPacking(buf: Buffer, p: number): NonNullable<Sections['packing']> {
  const count = buf.readUInt32BE(p + 5); // octets 6-9
  const template = buf.readUInt16BE(p + 9); // 10-11
  if (template !== 0) throw new Grib2FormatError(`data template 5.${template} is not supported (need 5.0)`);
  return {
    count,
    r: buf.readFloatBE(p + 11), // 12-15
    e: signed16(buf.readUInt16BE(p + 15)), // 16-17
    d: signed16(buf.readUInt16BE(p + 17)), // 18-19
    nbits: buf[p + 19], // 20
  };
}

function unpack(s: Required<Pick<Sections, 'packing' | 'npts'>> & Sections): Float32Array {
  const { r, e, d, nbits, count } = s.packing;
  const out = new Float32Array(s.npts).fill(NaN);
  const bin = Math.pow(2, e);
  const dec = Math.pow(10, -d);
  const data = s.data ?? Buffer.alloc(0);
  if (nbits > 32) throw new Grib2FormatError(`${nbits} bits per value is not supported`);
  if (data.length * 8 < count * nbits) throw new Grib2FormatError('data section is shorter than its packing declares');
  let bit = 0;
  let packed = 0;
  for (let i = 0; i < s.npts; i++) {
    if (s.bitmap && !(s.bitmap[i >> 3] & (0x80 >> (i & 7)))) continue;
    if (packed >= count) throw new Grib2FormatError('bitmap marks more points than the data section holds');
    let x = 0;
    for (let b = 0; b < nbits; b++, bit++) {
      x = x * 2 + ((data[bit >> 3] >> (7 - (bit & 7))) & 1);
    }
    out[i] = (r + x * bin) * dec;
    packed++;
  }
  return out;
}

/** Reorder a south-first grid so every decoded message reads north row first. */
function flipToNorthFirst(grid: Grib2Grid, values: Float32Array): { grid: Grib2Grid; values: Float32Array } {
  const out = new Float32Array(values.length);
  for (let j = 0; j < grid.nj; j++) {
    out.set(values.subarray(j * grid.ni, (j + 1) * grid.ni), (grid.nj - 1 - j) * grid.ni);
  }
  return { grid: { ...grid, lat1: grid.lat1 + (grid.nj - 1) * grid.dLat, northToSouth: true }, values: out };
}

/** Decode every GRIB2 message in `buf`. */
export function decodeGrib2(buf: Buffer): Grib2Message[] {
  const messages: Grib2Message[] = [];
  let off = 0;
  while (off + 16 <= buf.length) {
    if (buf.toString('latin1', off, off + 4) !== 'GRIB') {
      throw new Grib2FormatError(`expected "GRIB" at byte ${off}`);
    }
    const edition = buf[off + 7];
    if (edition !== 2) throw new Grib2FormatError(`GRIB edition ${edition} is not supported`);
    const discipline = buf[off + 6];
    const total = Number(buf.readBigUInt64BE(off + 8));
    const end = off + total;
    if (total < 20 || end > buf.length) throw new Grib2FormatError('message runs past the end of the file');
    if (buf.toString('latin1', end - 4, end) !== '7777') throw new Grib2FormatError('message has no end marker');

    const s: Sections = {};
    let p = off + 16;
    while (p < end - 4) {
      const len = buf.readUInt32BE(p);
      const num = buf[p + 4];
      if (len < 5 || p + len > end - 4) throw new Grib2FormatError(`section ${num} has a bad length`);
      switch (num) {
        case 1:
          s.referenceTime = new Date(
            Date.UTC(buf.readUInt16BE(p + 12), buf[p + 14] - 1, buf[p + 15], buf[p + 16], buf[p + 17], buf[p + 18]),
          );
          break;
        case 3:
          Object.assign(s, readGrid(buf, p));
          break;
        case 4:
          s.product = readProduct(buf, p);
          break;
        case 5:
          s.packing = readPacking(buf, p);
          break;
        case 6: {
          const indicator = buf[p + 5];
          if (indicator === 255) s.bitmap = null;
          else if (indicator === 0) s.bitmap = buf.subarray(p + 6, p + len);
          else throw new Grib2FormatError(`bitmap indicator ${indicator} is not supported`);
          break;
        }
        case 7:
          s.data = buf.subarray(p + 5, p + len);
          break;
        default:
          // Section 2 (local use) is skipped.
          break;
      }
      p += len;
    }
    if (!s.referenceTime || !s.grid || s.npts === undefined || !s.product || !s.packing) {
      throw new Grib2FormatError('message is missing a required section');
    }
    const values = unpack({ ...s, packing: s.packing, npts: s.npts });
    messages.push({
      referenceTime: s.referenceTime,
      discipline,
      ...s.product,
      ...(s.grid.northToSouth ? { grid: s.grid, values } : flipToNorthFirst(s.grid, values)),
    });
    off = end;
  }
  return messages;
}
