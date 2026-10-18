import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodeGrib2, Grib2FormatError } from './grib2.js';

// A real NOMADS grib-filter cut: GFS 2026-10-18 12Z, f003, 27-28N 83-82W.
const FIXTURE = readFileSync(
  fileURLToPath(new URL('./__fixtures__/gfs-2026101812-f003-tampa.grb2', import.meta.url)),
);

/** Byte offset of section `num` in the first message. */
function sectionOffset(buf: Buffer, num: number): number {
  let p = 16;
  while (buf[p + 4] !== num) p += buf.readUInt32BE(p);
  return p;
}

describe('decodeGrib2 (#5734)', () => {
  const messages = decodeGrib2(FIXTURE);

  it('reads every message with its time, level and grid', () => {
    expect(messages).toHaveLength(32);
    for (const m of messages) {
      expect(m.referenceTime.toISOString()).toBe('2026-10-18T12:00:00.000Z');
      expect(m.forecastHours).toBe(3);
      expect(m.grid).toEqual({ ni: 5, nj: 5, lat1: 28, lon1: -83, dLat: 0.25, dLon: 0.25, northToSouth: true });
      expect(m.values).toHaveLength(25);
    }
  });

  it('decodes physically sensible values', () => {
    const find = (cat: number, param: number, surfaceType: number, value: number) =>
      messages.find((m) => m.category === cat && m.parameter === param && m.surfaceType === surfaceType && m.surfaceValue === value)!;
    const t850 = Array.from(find(0, 0, 100, 85000).values);
    const z850 = Array.from(find(3, 5, 100, 85000).values);
    const rh2m = Array.from(find(1, 1, 103, 2).values);
    const psfc = Array.from(find(3, 0, 1, 0).values);
    const within = (vals: number[], lo: number, hi: number) =>
      expect(vals.every((v) => v >= lo && v <= hi), `${vals} within ${lo}..${hi}`).toBe(true);
    within(t850, 270, 300);
    within(z850, 1400, 1700);
    within(rh2m, 0, 100);
    within(psfc, 95000, 105000);
  });

  it('refuses a packing it does not implement rather than misreading it', () => {
    const buf = Buffer.from(FIXTURE);
    buf.writeUInt16BE(3, sectionOffset(buf, 5) + 9); // data template 5.3
    expect(() => decodeGrib2(buf)).toThrow(/data template 5.3/);
  });

  it('reads both row orders north row first', () => {
    // NOMADS cuts scan south to north (0x40) from La1 = 27; the decoder flips it.
    expect(FIXTURE[sectionOffset(FIXTURE, 3) + 71]).toBe(0x40);
    const buf = Buffer.from(FIXTURE);
    buf[sectionOffset(buf, 3) + 71] = 0x00; // same bytes, now read as north to south
    const [asNorthFirst] = decodeGrib2(buf);
    const [plain] = messages;
    expect(asNorthFirst.grid.lat1).toBe(27);
    expect(Array.from(asNorthFirst.values.subarray(0, 5))).toEqual(Array.from(plain.values.subarray(20, 25)));
    expect(Array.from(asNorthFirst.values.subarray(20, 25))).toEqual(Array.from(plain.values.subarray(0, 5)));
  });

  it('refuses a non-GRIB body (the HTML NOMADS sends for missing data)', () => {
    expect(() => decodeGrib2(Buffer.from('<html><body>This data is not yet available.</body></html>'))).toThrow(
      Grib2FormatError,
    );
  });

  it('refuses a truncated file', () => {
    expect(() => decodeGrib2(FIXTURE.subarray(0, 100))).toThrow(/past the end/);
  });

  it('honours a bitmap: masked points read as NaN', () => {
    const buf = Buffer.from(FIXTURE);
    const first = buf.readUInt32BE(12); // first message length (low word)
    const s6 = sectionOffset(buf, 6);
    expect(buf[s6 + 5]).toBe(255);
    // Rebuild message 1 with a bitmap that masks point 0 and packs 24 values.
    const s5 = sectionOffset(buf, 5);
    const nbits = buf[s5 + 19];
    const s7 = sectionOffset(buf, 7);
    const data = buf.subarray(s7 + 5, s7 + buf.readUInt32BE(s7));
    // Drop the first value's bits.
    const bits: number[] = [];
    for (let i = 0; i < data.length * 8; i++) bits.push((data[i >> 3] >> (7 - (i & 7))) & 1);
    const kept = bits.slice(nbits, nbits * 25);
    const packed = Buffer.alloc(Math.ceil(kept.length / 8));
    kept.forEach((b, i) => (packed[i >> 3] |= b << (7 - (i & 7))));
    const bitmap = Buffer.from([0x7f, 0xff, 0xff, 0x80]); // 25 points, first masked
    const sec6 = Buffer.concat([Buffer.alloc(6), bitmap]);
    sec6.writeUInt32BE(sec6.length, 0);
    sec6[4] = 6;
    sec6[5] = 0;
    const sec7 = Buffer.concat([Buffer.alloc(5), packed]);
    sec7.writeUInt32BE(sec7.length, 0);
    sec7[4] = 7;
    const sec5 = Buffer.from(buf.subarray(s5, s5 + buf.readUInt32BE(s5)));
    sec5.writeUInt32BE(24, 5);
    const body = Buffer.concat([buf.subarray(16, s5), sec5, sec6, sec7, Buffer.from('7777')]);
    const head = Buffer.from(buf.subarray(0, 16));
    head.writeBigUInt64BE(BigInt(16 + body.length), 8);
    const [masked] = decodeGrib2(Buffer.concat([head, body]));
    const [plain] = decodeGrib2(buf.subarray(0, first));
    // File point 0 is the south-west corner, which reads back as row 4, column 0.
    expect(Number.isNaN(masked.values[20])).toBe(true);
    const others = (v: Float32Array) => Array.from(v).filter((_, i) => i !== 20);
    expect(others(masked.values)).toEqual(others(plain.values));
  });
});
