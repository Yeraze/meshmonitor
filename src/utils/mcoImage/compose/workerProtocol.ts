import type { EncodeRequest, EncodeResponse, EncodeV3Fn } from './types.js';

/** Builds a handler with its own source state. Pure: no globals besides the injected encoder and rng. */
export function createEncodeHandler(
  _deps: { encodeV3: EncodeV3Fn; rng?: () => number },
): (msg: EncodeRequest) => EncodeResponse {
  throw new Error('not implemented');
}

/** Worker entry: the default handler wired to the real encoder and `Math.random`-free rng. */
export function handleEncodeMessage(_msg: EncodeRequest): EncodeResponse {
  throw new Error('not implemented');
}
