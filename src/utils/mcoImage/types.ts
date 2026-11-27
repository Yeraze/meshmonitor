export type McoImageFormat = 'im3'; // Phase 2 widens to 'im3' | 'im4'

export interface DecodedMcoImage {
  readonly format: McoImageFormat;
  readonly width: number; // 1..256
  readonly height: number; // 1..256
  /** RGBA8888, row-major, length width*height*4. Transparent colour has alpha 0. */
  readonly rgba: Uint8ClampedArray;
}

export interface McoImageCandidate {
  readonly format: McoImageFormat;
  /** The whole trimmed message, prefix included. */
  readonly payload: string;
}
