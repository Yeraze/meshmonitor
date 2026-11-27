import type { Candidate, CandidateResult, EncodeV3Fn, McoLevel, RgbaImage } from './types.js';

/**
 * Resize, matte, quantize, encode (v3, no nonce), build IM3 and IM4 texts, self-check by decoding.
 * Throws McoComposeSelfCheckError when a text does not decode to the quantized pixels.
 */
export function encodeCandidate(
  _src: RgbaImage,
  _c: Candidate,
  _level: McoLevel,
  _rng: () => number,
  _deps: { encodeV3: EncodeV3Fn },
): CandidateResult {
  throw new Error('not implemented');
}
