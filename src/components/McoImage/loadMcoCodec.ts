export type McoCodec = typeof import('../../utils/mcoImage/decode.js');

let loaded: McoCodec | null = null;
let pending: Promise<McoCodec> | null = null;

/** The codec if already loaded (lets cached renders decode synchronously, no flicker). */
export function getLoadedMcoCodec(): McoCodec | null {
  return loaded;
}

/** Cached import(); a failed load resets so the next mount retries. */
export function loadMcoCodec(): Promise<McoCodec> {
  if (!pending) {
    pending = import('../../utils/mcoImage/decode.js').then(
      (mod) => {
        loaded = mod;
        return mod;
      },
      (err: unknown) => {
        pending = null;
        throw err;
      },
    );
  }
  return pending;
}
