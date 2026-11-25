/**
 * Server H3 wrapper for Walkabout (#5891 P2, spec §2.3).
 * The only server module that imports `h3-js`.
 */
import { cellToBoundary, cellToChildren, cellToParent, getResolution, isValidCell, latLngToCell } from 'h3-js';
import { WALKABOUT_H3_BASE_RES } from '../../utils/walkabout.js';
import type { WalkaboutH3Res } from '../../types/walkabout.js';

/** Pad so a point on a curved edge still passes a plain lat/lon prefilter. */
const BBOX_PAD_DEG = 1e-5;

/** Res-9 cell, then its parent: the only binning rule (decision 2). A coarser
 *  cell is never `latLngToCell(p, res)`: that disagrees for ~7% of points. */
export function walkaboutCellOf(lat: number, lon: number, res: WalkaboutH3Res): string {
  const base = latLngToCell(lat, lon, WALKABOUT_H3_BASE_RES);
  return res === WALKABOUT_H3_BASE_RES ? base : cellToParent(base, res);
}

/** isValidCell + getResolution in 7..9. */
export function parseWalkaboutCell(raw: unknown): { cell: string; res: WalkaboutH3Res } | null {
  if (typeof raw !== 'string' || !/^[0-9a-f]{15}$/i.test(raw)) return null;
  const cell = raw.toLowerCase();
  let res: number;
  try {
    if (!isValidCell(cell)) return null;
    res = getResolution(cell);
  } catch {
    return null;
  }
  if (res < 7 || res > 9) return null;
  return { cell, res: res as WalkaboutH3Res };
}

/** Bounding box of every res-9 child of `cell` (children stick out past the
 *  parent's outline). null when the box spans more than 180 degrees of
 *  longitude (antimeridian): skip the prefilter. */
export function walkaboutCellBBox(
  cell: string,
): { south: number; north: number; west: number; east: number } | null {
  let south = Infinity;
  let north = -Infinity;
  let west = Infinity;
  let east = -Infinity;
  for (const child of cellToChildren(cell, WALKABOUT_H3_BASE_RES)) {
    for (const [lat, lng] of cellToBoundary(child)) {
      if (lat < south) south = lat;
      if (lat > north) north = lat;
      if (lng < west) west = lng;
      if (lng > east) east = lng;
    }
  }
  if (!Number.isFinite(south) || east - west > 180) return null;
  return {
    south: south - BBOX_PAD_DEG,
    north: north + BBOX_PAD_DEG,
    west: west - BBOX_PAD_DEG,
    east: east + BBOX_PAD_DEG,
  };
}
