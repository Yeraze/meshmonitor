import type { McoImageV4Document } from './v4/model.js';

export type McoImageFormat = 'im3' | 'im4';

export interface DecodedMcoImageV3 {
  readonly format: 'im3';
  readonly width: number; // 1..256
  readonly height: number; // 1..256
  /** RGBA8888, row-major, length width*height*4. Transparent colour has alpha 0. */
  readonly rgba: Uint8ClampedArray;
}

export interface DecodedMcoImageV4 {
  readonly format: 'im4';
  readonly width: number; // canvas cells, 1..256
  readonly height: number;
  readonly document: McoImageV4Document;
  /** Text figures in paint order, for screen readers. */
  readonly captions: readonly string[];
}

export type DecodedMcoImage = DecodedMcoImageV3 | DecodedMcoImageV4;

export interface McoImageCandidate {
  readonly format: McoImageFormat;
  /** The whole trimmed message, prefix included. */
  readonly payload: string;
}
