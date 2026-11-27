import type { McoImageV4Document } from './model.js';

/** Gate A stub. WP3 replaces this file with the real painter. */
export type McoPaintContext = CanvasRenderingContext2D;

export interface McoPaintOptions {
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly fontFamily: string;
  readonly createLayerSource?: (rgba: Uint8ClampedArray, w: number, h: number) => CanvasImageSource | null;
}

export function paintMcoImageV4(
  _ctx: McoPaintContext,
  _doc: McoImageV4Document,
  _opts: McoPaintOptions,
): void {
  // WP3
}
