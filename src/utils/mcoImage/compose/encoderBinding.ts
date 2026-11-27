/**
 * Binds the real v3 encoder (`v3/encoder/encode.ts`) for the worker. Kept in its own file so the
 * pure logic (`encodeCandidate`, `createEncodeHandler`) stays free of the encoder import in tests.
 */
import { encodeV3 as realEncodeV3 } from '../v3/encoder/encode.js';
import type { EncodeV3Fn } from './types.js';

export const encodeV3: EncodeV3Fn = realEncodeV3;
