/**
 * Likely-aircraft flight trails (#5364/#5365 Phase 3) — pure helpers shared
 * by both Map Features panels (NodesTab and DashboardMap).
 *
 * The server returns one trail per `(sourceId, nodeNum)` for every node it
 * may draw as an aircraft. The panel decides which of those it shows:
 * exactly the aircraft it currently draws a marker for (D1). That keeps
 * trails in step with Show / Mark / Hide, the age window, the transport
 * toggles and "Show aged-out" without re-implementing any of them here.
 */
import { colorForKey } from '../../utils/trailColor';
import { isAgedOutAircraft, type AgedOutAircraftFields } from './agedOutAircraft';

/** Lookback bounds and default, in hours (D2). Telemetry retention is 7 days. */
// Keep these three in step with the server copies in src/server/utils/aircraftTrails.ts.
export const AIRCRAFT_TRAIL_MIN_HOURS = 1;
export const AIRCRAFT_TRAIL_MAX_HOURS = 168;
export const DEFAULT_AIRCRAFT_TRAIL_HOURS = 6;

/**
 * Unified view: two sources that hear the same aircraft store the same fix
 * a moment apart. Drop a merged point this close to the previous one.
 */
export const AIRCRAFT_TRAIL_DEDUPE_MS = 5_000;

/** Clamp an hours value to 1..168, rounding to a whole hour. Non-numbers read as the default. */
export function clampAircraftTrailHours(hours: number): number {
  if (!Number.isFinite(hours)) return DEFAULT_AIRCRAFT_TRAIL_HOURS;
  return Math.min(Math.max(Math.round(hours), AIRCRAFT_TRAIL_MIN_HOURS), AIRCRAFT_TRAIL_MAX_HOURS);
}

/** One fix as `GET /api/aircraft/trails` returns it. */
export interface AircraftTrailPoint {
  lat: number;
  lon: number;
  alt: number | null;
  /** ms epoch */
  ts: number;
}

/** One trail as `GET /api/aircraft/trails` returns it (points ascending by time). */
export interface AircraftTrail {
  sourceId: string;
  nodeNum: number;
  points: AircraftTrailPoint[];
}

/** What `AircraftTrailsLayer` draws. */
export interface AircraftTrailDescriptor {
  key: string;
  label: string;
  color: string;
  positions: [number, number][];
  /** ms epoch per position, same order. */
  times: number[];
}

export type AircraftTrailViewMode =
  | { kind: 'source'; sourceId: string }
  | { kind: 'unified' };

/** The node fields `collectVisibleAircraft` reads. */
export interface TrailEligibleNode extends AgedOutAircraftFields {
  nodeNum?: number | string | null;
  likelyAircraft?: boolean | null;
  isMeshCore?: boolean | null;
}

/**
 * The aircraft set a panel draws, keyed by nodeNum, valued by label.
 *
 * `drawnNodes` MUST be the list the panel renders markers from, after every
 * map filter (age, transport, Hide, "Show aged-out"). Taking the drawn list
 * rather than re-deriving the rules makes a trail exist exactly when its
 * marker does: `likelyAircraft && drawn`, plus aged-out aircraft, which are
 * only in the drawn list while "Show aged-out" is on. A favourite aircraft
 * survives Hide as a marker, so it keeps its trail too.
 */
export function collectVisibleAircraft<T extends TrailEligibleNode>(
  drawnNodes: readonly T[],
  labelFor: (node: T) => string,
): Map<number, string> {
  const out = new Map<number, string>();
  for (const node of drawnNodes) {
    if (node.isMeshCore) continue;
    if (node.likelyAircraft !== true && !isAgedOutAircraft(node)) continue;
    const nodeNum = Number(node.nodeNum);
    if (!Number.isFinite(nodeNum) || nodeNum <= 0) continue;
    if (!out.has(nodeNum)) out.set(nodeNum, labelFor(node));
  }
  return out;
}

/**
 * Turn server trails into layer descriptors for one panel.
 *
 * - Only nodes in `visibleAircraft` get a trail.
 * - `source` mode keeps that source's trails only.
 * - `unified` mode merges a node's trails across sources into one, sorted by
 *   time, dropping a point within {@link AIRCRAFT_TRAIL_DEDUPE_MS} of the
 *   previous kept point.
 * - Colour hashes the nodeNum, so an aircraft keeps its colour across panels.
 * - A trail needs two points to draw a line; shorter ones are dropped.
 */
export function buildAircraftTrailDescriptors(
  trails: readonly AircraftTrail[],
  visibleAircraft: ReadonlyMap<number, string>,
  mode: AircraftTrailViewMode,
): AircraftTrailDescriptor[] {
  const byNode = new Map<number, AircraftTrailPoint[]>();
  for (const trail of trails) {
    const nodeNum = Number(trail.nodeNum);
    if (!visibleAircraft.has(nodeNum)) continue;
    if (mode.kind === 'source' && trail.sourceId !== mode.sourceId) continue;
    const acc = byNode.get(nodeNum);
    if (acc) acc.push(...trail.points);
    else byNode.set(nodeNum, [...trail.points]);
  }

  const out: AircraftTrailDescriptor[] = [];
  for (const [nodeNum, points] of byNode) {
    points.sort((a, b) => a.ts - b.ts);
    const kept: AircraftTrailPoint[] = [];
    for (const p of points) {
      const prev = kept[kept.length - 1];
      if (mode.kind === 'unified' && prev && p.ts - prev.ts < AIRCRAFT_TRAIL_DEDUPE_MS) continue;
      kept.push(p);
    }
    if (kept.length < 2) continue;
    out.push({
      key: `aircraft-trail-${nodeNum}`,
      label: visibleAircraft.get(nodeNum) ?? String(nodeNum),
      color: colorForKey(String(nodeNum)),
      positions: kept.map((p) => [p.lat, p.lon] as [number, number]),
      times: kept.map((p) => p.ts),
    });
  }
  return out;
}

/**
 * Index of the position closest to `[lat, lng]`, by an equirectangular
 * distance (plenty for picking the nearest fix under the cursor). -1 when
 * `positions` is empty.
 */
export function nearestPointIndex(positions: readonly [number, number][], lat: number, lng: number): number {
  let best = -1;
  let bestD = Infinity;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  for (let i = 0; i < positions.length; i++) {
    const dLat = positions[i][0] - lat;
    const dLng = (positions[i][1] - lng) * cosLat;
    const d = dLat * dLat + dLng * dLng;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Evenly pick at most `max` indices across `length` items, always keeping the
 * last one (the aircraft's newest fix). Used to place direction arrows.
 */
export function arrowIndices(length: number, max: number): number[] {
  if (length <= 0 || max <= 0) return [];
  if (length <= max) return Array.from({ length }, (_, i) => i);
  const step = (length - 1) / (max - 1 || 1);
  const out = new Set<number>();
  for (let i = 0; i < max; i++) out.add(Math.round(i * step));
  out.add(length - 1);
  return Array.from(out).sort((a, b) => a - b);
}

/** Node fields `aircraftNodeLabel` reads — covers both the flat (Dashboard) and nested (NodesTab) shapes. */
export interface AircraftLabelNode {
  nodeNum?: number | string | null;
  nodeId?: string | null;
  longName?: string | null;
  shortName?: string | null;
  user?: { id?: string | null; longName?: string | null; shortName?: string | null } | null;
}

/** Trail tooltip name: long name, else short name, else node id, else `!hex` nodeNum. */
export function aircraftNodeLabel(node: AircraftLabelNode): string {
  const name =
    node.longName ?? node.user?.longName ?? node.shortName ?? node.user?.shortName ?? node.nodeId ?? node.user?.id;
  if (name) return name;
  const num = Number(node.nodeNum);
  return Number.isFinite(num) ? `!${(num >>> 0).toString(16).padStart(8, '0')}` : '?';
}
