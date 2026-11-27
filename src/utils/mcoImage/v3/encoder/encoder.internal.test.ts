/**
 * Differential tests of the TypeScript v3 encoder against the upstream JS encoder.
 *
 * Fixtures (all produced by the upstream encoder, never by this port):
 *   v3-js-encoder-fixtures.json   copied from HDDen/meshcore-open commit c38c1650 docs/mcoimg-js/tests/
 *   v3-diff-fixtures.json         public-API cases plus `regions-*` and `boundsBlock-*` internal-entry cases
 *   v3-encoder-photo-fixtures.json  quantised photo and line-art images (see its `_source`)
 * Upstream: MIT License, Copyright (c) 2025 zjs81.
 *
 * Every case is byte-exact: the same body bytes and the same text.
 */
import { describe, expect, it } from 'vitest';
import diffFixtures from '../../__fixtures__/v3-diff-fixtures.json';
import { McoImageV3BlockAlgorithm } from '../constants.js';
import type { McoImageV3BlockAlgorithmId, ScanModeId } from '../constants.js';
import { rowLengthForScan } from '../blockBodies.js';
import { b64, backgroundOf, timeoutFor, toImage } from './encoder.testSupport.js';
import type { Fixture } from './encoder.testSupport.js';
import { boundsForBackground, extractBoundsPixels, toScanOrder } from './common.js';
import { tryBuildBlockBodyEncoding, tryBuildRegionsCandidateEncoder, tryWrapBoundsCandidate } from './encode.js';
import type { Bounds, EncodeOptions } from './types.js';

const diff = diffFixtures.fixtures as Fixture[];

// Layouts used by upstream's gen_regions.js.
const REGION_LAYOUTS: Record<string, Bounds[]> = {
  '24x20': [{ x: 1, y: 1, width: 8, height: 6 }, { x: 12, y: 2, width: 9, height: 7 }, { x: 3, y: 11, width: 10, height: 6 }],
  '20x20': [
    { x: 0, y: 0, width: 6, height: 6 },
    { x: 8, y: 0, width: 7, height: 8 },
    { x: 2, y: 10, width: 6, height: 8 },
    { x: 12, y: 11, width: 7, height: 6 },
  ],
};

describe('internal entry: tryBuildRegionsCandidateEncoder (regions-* fixtures)', () => {
  const fixtures = diff.filter((f) => f.name.startsWith('regions-'));
  it('is non-empty', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });
  for (const f of fixtures) {
    const [, , optionNames, level] = f.name.split('-');
    const high = level === 'high';
    it(
      f.name,
      () => {
        const options: EncodeOptions = {};
        if (optionNames !== 'plain') {
          for (const key of optionNames.split('_')) (options as Record<string, boolean>)[key] = true;
        }
        const image = toImage(f);
        const regions = REGION_LAYOUTS[`${f.width}x${f.height}`].map((r) => ({ ...r }));
        const candidate = tryBuildRegionsCandidateEncoder(image, backgroundOf(image.paletteProfile), 0, regions, options, high);
        expect(candidate).not.toBeNull();
        const expected = b64(f.bodyBase64);
        expect(Array.from(candidate!.payload)).toEqual(Array.from(expected.subarray(1)));
      },
      timeoutFor(level),
    );
  }
});

describe('internal entry: tryWrapBoundsCandidate (boundsBlock-* fixtures)', () => {
  const fixtures = diff.filter((f) => f.name.startsWith('boundsBlock-'));
  it('is non-empty', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });
  for (const f of fixtures) {
    const [, , algorithmName, scanName] = f.name.split('-');
    it(f.name, () => {
      const algorithm = McoImageV3BlockAlgorithm[algorithmName as keyof typeof McoImageV3BlockAlgorithm] as McoImageV3BlockAlgorithmId;
      const scan = Number(scanName.replace('scan', '')) as ScanModeId;
      expect(algorithm).toBeDefined();
      const image = toImage(f);
      const bg = backgroundOf(image.paletteProfile);
      const bounds = boundsForBackground(image, bg)!;
      const linear = toScanOrder(extractBoundsPixels(image, bounds), bounds.width, bounds.height, scan);
      const body = tryBuildBlockBodyEncoding(image, linear, algorithm, {
        backgroundColor: bg,
        rowLength: rowLengthForScan(scan, bounds.width, bounds.height),
        backgroundInherited: true,
        greedyLzOnly: true,
        useHighCompressionExtras: false,
      });
      expect(body).not.toBeNull();
      const candidate = tryWrapBoundsCandidate(image, bounds, linear, body!, algorithm, scan, {
        backgroundColor: bg,
        compactGeometry: false,
        backgroundRank: 0,
      });
      expect(candidate).not.toBeNull();
      expect(Array.from(candidate!.payload)).toEqual(Array.from(b64(f.bodyBase64).subarray(1)));
    });
  }
});
