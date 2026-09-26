/**
 * "Show aged-out" map filter helpers (#5364/#5365 Phase 2).
 *
 * The server's aircraft age-out sweep ignores a likely aircraft that has not
 * been heard for N hours: `isIgnored = true` plus `aircraftAgedOutAt`. Every
 * map drops ignored nodes, so an aged-out aircraft vanishes. The Map Features
 * "Show aged-out" checkbox brings those nodes (and only those — manual and geo
 * ignores stay hidden) back as dimmed, badged markers.
 *
 * Pure helpers so both Map Features panels (NodesTab via useSourceView, and
 * DashboardMap) apply the exact same predicate.
 */

/** Per-viewer localStorage key for the checkbox. */
export const SHOW_AGED_OUT_AIRCRAFT_STORAGE_KEY = 'showAgedOutAircraft';

/** Marker opacity for an aged-out aircraft drawn by "Show aged-out". */
export const AGED_OUT_AIRCRAFT_OPACITY = 0.45;

export interface AgedOutAircraftFields {
  isIgnored?: boolean | null;
  aircraftAgedOutAt?: number | null;
}

/** True when the node is ignored BECAUSE the age-out sweep ignored it. */
export function isAgedOutAircraft(node: AgedOutAircraftFields | null | undefined): boolean {
  return node?.isIgnored === true && node.aircraftAgedOutAt != null;
}

/** Read the persisted checkbox state. Defaults to off; storage errors read as off. */
export function readShowAgedOutAircraft(): boolean {
  try {
    return localStorage.getItem(SHOW_AGED_OUT_AIRCRAFT_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

/** Persist the checkbox state. Best effort: private windows may throw. */
export function writeShowAgedOutAircraft(value: boolean): void {
  try {
    localStorage.setItem(SHOW_AGED_OUT_AIRCRAFT_STORAGE_KEY, value ? 'true' : 'false');
  } catch {
    // per-viewer convenience only
  }
}
