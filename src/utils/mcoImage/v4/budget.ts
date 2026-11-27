import type { McoV4Limits } from './constants.js';
import { McoImageV4TooLargeError } from './errors.js';

export interface V4Charge {
  figures?: number;
  points?: number;
  textCodePoints?: number;
  rasterLayers?: number;
  rasterPixels?: number;
}

/**
 * Running totals against McoV4Limits. The reference codec has no caps: a repeat copies a
 * whole group, a group can hold a repeat of itself, and a REPEAT_COLOR_RUN with no colour
 * change emits up to ~2^35 copies for a few bits. So callers charge BEFORE building copies.
 * Counts add up across the whole document, copies included.
 */
export class V4DecodeBudget {
  private figures = 0;
  private points = 0;
  private textCodePoints = 0;
  private rasterLayers = 0;
  private rasterPixels = 0;
  private depth = 0;

  constructor(private readonly limits: McoV4Limits) {}

  /** Throws McoImageV4TooLargeError naming the limit. */
  charge(w: V4Charge): void {
    const { limits } = this;
    // Add with the new amounts first so a huge count fails before any state is trusted.
    if (w.figures !== undefined) {
      if (this.figures + w.figures > limits.maxFigures) {
        throw new McoImageV4TooLargeError(`MCOimg v4 image has too many figures (limit ${limits.maxFigures})`);
      }
    }
    if (w.points !== undefined) {
      if (this.points + w.points > limits.maxPathPoints) {
        throw new McoImageV4TooLargeError(`MCOimg v4 image has too many path points (limit ${limits.maxPathPoints})`);
      }
    }
    if (w.textCodePoints !== undefined) {
      if (this.textCodePoints + w.textCodePoints > limits.maxTextCodePoints) {
        throw new McoImageV4TooLargeError(
          `MCOimg v4 image has too much text (limit ${limits.maxTextCodePoints} code points)`,
        );
      }
    }
    if (w.rasterLayers !== undefined) {
      if (this.rasterLayers + w.rasterLayers > limits.maxRasterLayers) {
        throw new McoImageV4TooLargeError(`MCOimg v4 image has too many raster layers (limit ${limits.maxRasterLayers})`);
      }
    }
    if (w.rasterPixels !== undefined) {
      if (this.rasterPixels + w.rasterPixels > limits.maxRasterPixels) {
        throw new McoImageV4TooLargeError(`MCOimg v4 raster layers are too large (limit ${limits.maxRasterPixels} pixels)`);
      }
    }
    this.figures += w.figures ?? 0;
    this.points += w.points ?? 0;
    this.textCodePoints += w.textCodePoints ?? 0;
    this.rasterLayers += w.rasterLayers ?? 0;
    this.rasterPixels += w.rasterPixels ?? 0;
  }

  enterGroup(): void {
    if (this.depth + 1 > this.limits.maxGroupDepth) {
      throw new McoImageV4TooLargeError(`MCOimg v4 groups are nested too deep (limit ${this.limits.maxGroupDepth})`);
    }
    this.depth++;
  }

  leaveGroup(): void {
    this.depth--;
  }
}
