/**
 * Worker logic as plain functions, so Node tests can drive it without a Worker.
 * `mcoEncode.worker.ts` only forwards messages here.
 */
import { encodeCandidate, McoComposeSelfCheckError } from './encodeCandidate.js';
import { encodeV3 as realEncodeV3 } from './encoderBinding.js';
import type { EncodeRequest, EncodeResponse, EncodeV3Fn, RgbaImage } from './types.js';

function secureRandom(): number {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0] / 2 ** 32;
}

/** A handler with its own source state. The encoder and rng are injected for tests. */
export function createEncodeHandler(deps: {
  encodeV3: EncodeV3Fn;
  rng?: () => number;
}): (msg: EncodeRequest) => EncodeResponse {
  let source: RgbaImage | null = null;
  const rng = deps.rng ?? secureRandom;
  return (msg) => {
    if (msg.type === 'setSource') {
      source = msg.source;
      return { type: 'sourceSet' };
    }
    const base = { gen: msg.gen, jobId: msg.jobId, candidate: msg.candidate, level: msg.level } as const;
    if (!source) return { type: 'error', ...base, message: 'No source image set' };
    try {
      const result = encodeCandidate(source, msg.candidate, msg.level, rng, { encodeV3: deps.encodeV3 });
      return { type: 'result', ...base, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Encode failed';
      if (err instanceof McoComposeSelfCheckError) console.warn(`[mcoImage] dropped a result: ${message}`);
      return { type: 'error', ...base, message };
    }
  };
}

const defaultHandler = createEncodeHandler({ encodeV3: realEncodeV3 });

/** Worker entry: the default handler wired to the real encoder and a crypto rng. */
export function handleEncodeMessage(msg: EncodeRequest): EncodeResponse {
  return defaultHandler(msg);
}
