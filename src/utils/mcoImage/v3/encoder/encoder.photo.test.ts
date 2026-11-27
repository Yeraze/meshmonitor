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
import photoFixtures from '../../__fixtures__/v3-encoder-photo-fixtures.json';
import { publicApiSuite } from './encoder.testSupport.js';
import type { Fixture } from './encoder.testSupport.js';

publicApiSuite('photo and line-art fixtures', photoFixtures.fixtures as Fixture[]);
