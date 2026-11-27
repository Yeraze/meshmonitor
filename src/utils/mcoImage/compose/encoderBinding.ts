/**
 * Binds the real v3 encoder (WP1, `v3/encoder/encode.ts`) for the worker.
 * TEMPORARY stub until WP1 lands; replaced by a re-export.
 */
import type { EncodeV3Fn } from './types.js';

export const encodeV3: EncodeV3Fn = () => {
  throw new Error('v3 encoder not available yet');
};
