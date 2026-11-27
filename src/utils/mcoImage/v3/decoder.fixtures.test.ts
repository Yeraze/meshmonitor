/**
 * Differential tests of the TypeScript port against the upstream JS codec output.
 *
 * Fixtures: v3-js-decoder-fixtures.json and v3-js-encoder-fixtures.json are copied verbatim from
 *   https://github.com/HDDen/meshcore-open (branch rename-mco-advanced)
 *   commit c38c1650fe8394835e333b5b4a1ac84ead2d5e5a, docs/mcoimg-js/tests/
 * (docs/mcoimg-js/mcoimg-v3-codec.global.js sha256
 *  7b80f006817b8fafd388a1afecfcbbe7d75cd22e7f6e18b85ddfc788cca47d3a).
 * MIT License, Copyright (c) 2025 zjs81.
 *
 * v3-diff-fixtures.json was generated once with that upstream encoder (see its `generator` field).
 */
import { describe, expect, it } from 'vitest';
import decoderFixtures from '../__fixtures__/v3-js-decoder-fixtures.json';
import encoderFixtures from '../__fixtures__/v3-js-encoder-fixtures.json';
import diffFixtures from '../__fixtures__/v3-diff-fixtures.json';
import { decodeV3AppPayload, decodeV3Body, decodeV3BodyWithoutNonce, decodeV3Text } from './decoder.js';
import { PaletteProfile } from './constants.js';

interface Fixture {
  name: string;
  bodyBase64: string;
  appPayloadBase64: string;
  text: string;
  width: number;
  height: number;
  paletteProfile: string;
  pixels: number[];
  transparentColor?: number | null;
}

const b64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));

const groups: Array<[string, Fixture[]]> = [
  ['upstream decoder', decoderFixtures.fixtures as Fixture[]],
  ['upstream encoder', encoderFixtures.fixtures as Fixture[]],
  ['differential', diffFixtures.fixtures as Fixture[]],
];

for (const [label, fixtures] of groups) {
  describe(`${label} fixtures`, () => {
    it('is non-empty', () => {
      expect(fixtures.length).toBeGreaterThan(0);
    });
    for (const f of fixtures) {
      it(f.name, () => {
        const profile = PaletteProfile[f.paletteProfile as keyof typeof PaletteProfile];
        expect(profile).toBeDefined();
        const expected = {
          width: f.width,
          height: f.height,
          paletteProfile: profile,
          pixels: f.pixels,
          transparentColor: f.transparentColor ?? null,
        };
        const body = b64(f.bodyBase64);
        expect(decodeV3Text(f.text)).toEqual(expected);
        expect(decodeV3AppPayload(b64(f.appPayloadBase64))).toEqual(expected);
        expect(decodeV3Body(body)).toEqual(expected);
        expect(decodeV3BodyWithoutNonce(body.subarray(1))).toEqual(expected);
      });
    }
  });
}
