/**
 * "Did the node's latest advert carry a position?" (#5578).
 *
 * A MeshCore node that stops sharing its position keeps advertising, without
 * coordinates. Ingest keeps the last stored fix (#3504), so the map would go
 * on drawing the node at a place it no longer reports. The server records the
 * fact in `meshcore_nodes.lastAdvertHadPosition`; the maps use the one
 * predicate below to hide such nodes when the user asks.
 *
 * Shared by server ingest and both map surfaces (MeshCore map, Dashboard map).
 */
import { isBogusPosition } from './nullIsland.js';

/**
 * localStorage key for the "hide nodes without a current position advert"
 * toggle. One key for both maps, so the choice follows the browser.
 */
export const HIDE_POSITIONLESS_ADVERT_STORAGE_KEY = 'meshmonitor-meshcore-hidePositionlessAdverts';

/**
 * True when an advert's coordinates are a usable position. Absent, non-finite,
 * out-of-range and 0/0 all count as "no position": the firmware reports 0/0
 * for a contact that never advertised one, and a wire advert with the lat/lon
 * flag clear decodes to `undefined`.
 *
 * Does not consult the `discardInvalidPositions` setting: 0/0 is never a
 * position a node chose to share.
 */
export function advertHasPosition(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): boolean {
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return false;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  return !isBogusPosition(latitude, longitude);
}

/** The two node fields the hide predicate reads. */
export interface AdvertPositionFields {
  /** `false` = latest advert had no position; `true` = it had one; null/undefined = unknown. */
  lastAdvertHadPosition?: boolean | null;
  /** `'telemetry'` = the stored fix is a live GNSS reading, not an advert's. */
  positionSource?: string | null;
}

/**
 * Should this node's marker be hidden by the "hide nodes without a current
 * position advert" toggle?
 *
 * - Toggle off: never.
 * - Unknown (`null`/`undefined`): shown. Only a recorded `false` hides.
 * - A telemetry-sourced position is a live fix, so it is never hidden.
 */
export function isHiddenByPositionlessAdvert(
  node: AdvertPositionFields | null | undefined,
  hideEnabled: boolean,
): boolean {
  if (!hideEnabled || !node) return false;
  if (node.positionSource === 'telemetry') return false;
  return node.lastAdvertHadPosition === false;
}

/** Read the persisted toggle. Default off; storage errors read as off. */
export function readHidePositionlessAdverts(): boolean {
  try {
    return localStorage.getItem(HIDE_POSITIONLESS_ADVERT_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

/** Persist the toggle. Storage errors are ignored (private mode, quota). */
export function writeHidePositionlessAdverts(value: boolean): void {
  try {
    localStorage.setItem(HIDE_POSITIONLESS_ADVERT_STORAGE_KEY, String(value));
  } catch {
    // The toggle still works for this page view.
  }
}
