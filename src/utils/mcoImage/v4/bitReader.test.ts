import { describe, expect, it } from 'vitest';
import { V4BitReader, V4ByteReader } from './bitReader.js';
import { V4BitWriter } from './bitWriter.js';
import { McoImageV4InvalidPayloadError } from './errors.js';

function writeRaw(bits: Array<[number, number]>): Uint8Array {
  const w = new V4BitWriter();
  for (const [value, n] of bits) w.writeBits(value, n);
  return w.toBytes();
}

describe('V4BitReader', () => {
  it('reads LSB-first and keeps 32-bit values unsigned', () => {
    const r = new V4BitReader(Uint8Array.of(0xff, 0xff, 0xff, 0xff));
    expect(r.readBits(32)).toBe(0xffffffff);
    expect(r.remainingBits).toBe(0);
    expect(() => r.readBits(1)).toThrow(McoImageV4InvalidPayloadError);
  });

  it('round-trips compact uints across every form boundary', () => {
    for (const v of [0, 3, 4, 19, 20, 275, 276, 277, 70000, 2 ** 31, 2 ** 31 + 5, 2 ** 35 - 1]) {
      const w = new V4BitWriter();
      w.writeCompactUint(v);
      const r = new V4BitReader(w.toBytes());
      expect(r.readCompactUint(), String(v)).toBe(v);
    }
  });

  it('rejects the 111 form for values <= 275', () => {
    for (const v of [0, 1, 275]) {
      const w = new V4BitWriter();
      w.writeBits(7, 3);
      w.writeBitVarUint(v);
      expect(() => new V4BitReader(w.toBytes()).readCompactUint()).toThrow('Non-canonical v4 compact uint');
    }
  });

  it('rejects varuint with a trailing zero group and a 6th byte', () => {
    const lead = new V4BitWriter();
    lead.writeBits(0x81, 8);
    lead.writeBits(0x00, 8);
    expect(() => new V4BitReader(lead.toBytes()).readCanonicalBitVarUint()).toThrow('Non-canonical v4 bit varuint');
    const long = Uint8Array.of(0x81, 0x81, 0x81, 0x81, 0x81, 0x01);
    expect(() => new V4BitReader(long).readCanonicalBitVarUint()).toThrow('V4 bit varuint is too long');
  });

  it('finishByte accepts zero padding only', () => {
    const ok = new V4BitReader(writeRaw([[1, 3]]));
    ok.readBits(3);
    expect(() => ok.finishByte()).not.toThrow();
    const bad = new V4BitReader(Uint8Array.of(0b10001));
    bad.readBits(3);
    expect(() => bad.finishByte()).toThrow('Non-zero MCOimg v4 padding');
  });

  it('byteOffset rounds up and finish checks the rest', () => {
    const r = new V4BitReader(Uint8Array.of(0x03, 0x00));
    r.readBits(2);
    expect(r.byteOffset).toBe(1);
    expect(() => r.finish()).not.toThrow();
    const r2 = new V4BitReader(Uint8Array.of(0x00, 0x01));
    r2.readBits(2);
    expect(() => r2.finish()).toThrow('Non-zero MCOimg v4 padding');
  });

  it('readBytes works at odd bit offsets and checks the length', () => {
    const w = new V4BitWriter();
    w.writeBits(5, 3);
    w.writeBytes(Uint8Array.of(0xab, 0xcd));
    const r = new V4BitReader(w.toBytes());
    expect(r.readBits(3)).toBe(5);
    expect(Array.from(r.readBytes(2))).toEqual([0xab, 0xcd]);
    expect(() => new V4BitReader(Uint8Array.of(1)).readBytes(2)).toThrow('Unexpected end of v4 bits');
  });
});

describe('V4ByteReader', () => {
  it('reads varuint7, uint32 LE (unsigned) and rejects overruns', () => {
    const r = new V4ByteReader(Uint8Array.of(0xac, 0x02, 0xff, 0xff, 0xff, 0xff));
    expect(r.readCanonicalVarUint7()).toBe(300);
    expect(r.readUint32Le()).toBe(0xffffffff);
    expect(() => r.readByte()).toThrow('Unexpected end of v4 bytes');
    expect(() => new V4ByteReader(Uint8Array.of(0x80, 0x00)).readCanonicalVarUint7()).toThrow(
      'Non-canonical v4 byte varuint',
    );
    expect(() => new V4ByteReader(Uint8Array.of(0x80, 0x80, 0x80, 0x80, 0x80)).readCanonicalVarUint7()).toThrow(
      'V4 byte varuint is too long',
    );
  });
});
