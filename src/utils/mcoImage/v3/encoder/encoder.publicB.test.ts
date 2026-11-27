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
import diffFixtures from '../../__fixtures__/v3-diff-fixtures.json';
import { publicApiSuite } from './encoder.testSupport.js';
import type { Fixture } from './encoder.testSupport.js';

// The differential cases run in three files so Vitest can spread them over its workers.
const diff = (diffFixtures.fixtures as Fixture[]).filter((f) => f.name.startsWith('diff-'));
const part = diff.filter((_, index) => index % 3 === 1);
publicApiSuite('differential public-API fixtures, part 2 of 3', part);
