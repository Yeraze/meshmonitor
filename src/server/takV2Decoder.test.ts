/**
 * ATAK V2 wire decoder tests (#4317).
 *
 * The primary suite decodes every golden wire fixture shipped in the
 * takpacket-sdk submodule (takpacket-sdk/testdata/golden/*.bin — real
 * `[flags][magicless zstd]` payloads produced by the upstream SDK) and
 * compares the result against the matching reference protobuf bytes
 * (testdata/protobuf/*.pb). This pins our decoder to the cross-binding wire
 * contract, not just to our own implementation.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { loadProtobufDefinitions, getProtobufRoot } from './protobufLoader';
import { decodeTakV2Payload, takV2Variant, takV2DictName, TAK_V2_UNCOMPRESSED, resetTakV2DecoderForTests } from './takV2Decoder';

const goldenDir = join(process.cwd(), 'takpacket-sdk', 'testdata', 'golden');
const protobufFixtureDir = join(process.cwd(), 'takpacket-sdk', 'testdata', 'protobuf');
const hasFixtures = existsSync(goldenDir) && existsSync(protobufFixtureDir);
const hasProtobufs = existsSync(join(process.cwd(), 'protobufs', 'meshtastic', 'atak.proto'));

describe.skipIf(!hasFixtures || !hasProtobufs)('takV2Decoder', () => {
  let TAKPacketV2: any;
  let root: any;

  beforeAll(async () => {
    await loadProtobufDefinitions();
    root = getProtobufRoot();
    TAKPacketV2 = root.lookupType('meshtastic.TAKPacketV2');
    resetTakV2DecoderForTests();
  });

  describe('golden wire fixtures (upstream TAKPacket-SDK)', () => {
    const fixtures = hasFixtures
      ? readdirSync(goldenDir).filter(f => f.endsWith('.bin')).map(f => basename(f, '.bin'))
      : [];

    it('has the full upstream fixture set', () => {
      expect(fixtures.length).toBeGreaterThanOrEqual(40);
    });

    it.each(fixtures)('decodes %s to the reference protobuf', (name) => {
      const wire = readFileSync(join(goldenDir, `${name}.bin`));
      const referenceBytes = readFileSync(join(protobufFixtureDir, `${name}.pb`));

      const decoded = decodeTakV2Payload(wire, root);
      expect(decoded, `fixture ${name} failed to decode`).not.toBeNull();
      expect(decoded).not.toBeInstanceOf(Uint8Array);

      const reference = TAKPacketV2.decode(referenceBytes);
      // Compare in toObject space — protobufjs Message instances carry only
      // wire-present own fields, so deep-equality on the plain objects pins
      // byte-level fidelity of the decompression.
      expect(TAKPacketV2.toObject(decoded, { defaults: true }))
        .toEqual(TAKPacketV2.toObject(reference, { defaults: true }));
    });

    it('covers both dictionaries in the fixture set', () => {
      const dictIds = new Set(
        fixtures.map(name => readFileSync(join(goldenDir, `${name}.bin`))[0])
          .filter(flags => flags !== TAK_V2_UNCOMPRESSED)
          .map(flags => flags & 0x3f)
      );
      expect(dictIds.has(0)).toBe(true); // non-aircraft
      expect(dictIds.has(1)).toBe(true); // aircraft
    });
  });

  describe('uncompressed (0xFF) path', () => {
    it('decodes a [0xFF][raw protobuf] payload without any dictionary', () => {
      const referenceBytes = readFileSync(join(protobufFixtureDir, 'pli_basic.pb'));
      const wire = Buffer.concat([Buffer.from([TAK_V2_UNCOMPRESSED]), referenceBytes]);

      const decoded = decodeTakV2Payload(wire, root);
      expect(decoded).not.toBeNull();
      expect(TAKPacketV2.toObject(decoded, { defaults: true }))
        .toEqual(TAKPacketV2.toObject(TAKPacketV2.decode(referenceBytes), { defaults: true }));
    });
  });

  describe('failure modes (all degrade to null → raw-payload fallback)', () => {
    it('returns null for an unknown dictionary ID', () => {
      const wire = Buffer.from([0x10, 0x01, 0x02, 0x03]); // dict 16 is reserved
      expect(decodeTakV2Payload(wire, root)).toBeNull();
    });

    it('returns null for a too-short payload', () => {
      expect(decodeTakV2Payload(Buffer.from([0x00]), root)).toBeNull();
      expect(decodeTakV2Payload(Buffer.alloc(0), root)).toBeNull();
    });

    it('returns null for a corrupt zstd body', () => {
      const wire = Buffer.from([0x00, 0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]);
      expect(decodeTakV2Payload(wire, root)).toBeNull();
    });

    it('ignores reserved flag bits 6-7 when extracting the dict ID', () => {
      const golden = readFileSync(join(goldenDir, 'pli_basic.bin'));
      expect(golden[0] & 0x3f).toBe(0); // precondition: dict 0 fixture
      const withReservedBits = Buffer.from(golden);
      withReservedBits[0] = golden[0] | 0xc0; // set both reserved bits
      expect(decodeTakV2Payload(withReservedBits, root)).not.toBeNull();
    });

    it('rejects decompressed output larger than the 4096-byte bomb guard', async () => {
      // Compress an 8 KB buffer with the real dict-0 compressor (mirroring the
      // SDK's encode parameters) — a valid frame whose plaintext exceeds the cap.
      const { Compressor } = await import('zstd-napi');
      const c = new Compressor();
      c.setParameters({ compressionLevel: 19, contentSizeFlag: false, checksumFlag: false, dictIDFlag: false, windowLog: 21 });
      c.loadDictionary(readFileSync(join(process.cwd(), 'takpacket-sdk', 'dictionaries', 'dict_non_aircraft.zstd')));
      const framed = c.compress(Buffer.alloc(8192, 0x41));
      const wire = Buffer.concat([Buffer.from([0x00]), framed.subarray(4)]); // strip magic, prepend flags
      expect(decodeTakV2Payload(wire, root)).toBeNull();
    });
  });

  describe('takV2Variant', () => {
    it('returns undefined for the implicit PLI (no payload_variant)', () => {
      const decoded = decodeTakV2Payload(readFileSync(join(goldenDir, 'pli_basic.bin')), root);
      expect(takV2Variant(decoded)).toBeUndefined();
    });

    it('identifies the chat variant', () => {
      const decoded = decodeTakV2Payload(readFileSync(join(goldenDir, 'geochat_simple.bin')), root);
      expect(takV2Variant(decoded)).toBe('chat');
    });

    it('identifies rich-CoT variants', () => {
      const cases: Array<[string, string]> = [
        ['drawing_circle', 'shape'],
        ['marker_spot', 'marker'],
        ['emergency_911', 'emergency'],
        ['casevac', 'casevac'],
        ['aircraft_adsb', 'aircraft'],
      ];
      for (const [fixture, expected] of cases) {
        const decoded = decodeTakV2Payload(readFileSync(join(goldenDir, `${fixture}.bin`)), root);
        expect(takV2Variant(decoded), fixture).toBe(expected);
      }
    });
  });

  describe('takV2DictName', () => {
    it('names the known dictionaries', () => {
      expect(takV2DictName(0)).toBe('non-aircraft');
      expect(takV2DictName(1)).toBe('aircraft');
      expect(takV2DictName(16)).toBe('unknown dict 16');
    });
  });
});
