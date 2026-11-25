/**
 * Server H3 wrapper for Walkabout (#5891 P2, spec §2.3). Skeleton; WP1 fills the bodies.
 * The only server module that imports `h3-js`.
 */
import type { WalkaboutH3Res } from '../../types/walkabout.js';

/** Res-9 cell, then its parent: the only binning rule (decision 2). */
export function walkaboutCellOf(_lat: number, _lon: number, _res: WalkaboutH3Res): string {
  throw new Error('not implemented');
}

/** isValidCell + getResolution in 7..9. */
export function parseWalkaboutCell(_raw: unknown): { cell: string; res: WalkaboutH3Res } | null {
  throw new Error('not implemented');
}

/** Bounding box of every res-9 child of `cell` (children stick out past the
 *  parent's outline). null when the box spans more than 180 degrees of
 *  longitude (antimeridian): skip the prefilter. */
export function walkaboutCellBBox(
  _cell: string,
): { south: number; north: number; west: number; east: number } | null {
  throw new Error('not implemented');
}
