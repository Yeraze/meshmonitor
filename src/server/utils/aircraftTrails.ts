/**
 * Flight-trail shaping for `GET /api/aircraft/trails` (#5364/#5365 Phase 3).
 *
 * Pure helpers: group pivoted position rows into one trail per
 * `(sourceId, nodeNum)`, downsample each trail, and cap the trail count.
 */
import { downsamplePositionHistory } from '../../utils/positionHistoryDownsample.js';

/** Lookback bounds and default, in hours. Telemetry retention is 7 days. */
export const AIRCRAFT_TRAIL_MIN_HOURS = 1;
export const AIRCRAFT_TRAIL_MAX_HOURS = 168;
export const AIRCRAFT_TRAIL_DEFAULT_HOURS = 6;

/** Most points one trail sends to the client. First and last are always kept. */
export const AIRCRAFT_TRAIL_MAX_POINTS = 500;

/** Most trails one response carries, newest last fix first. */
export const AIRCRAFT_TRAIL_MAX_TRAILS = 200;

export interface AircraftTrailPoint {
  lat: number;
  lon: number;
  alt: number | null;
  /** ms epoch */
  ts: number;
}

export interface AircraftTrail {
  sourceId: string;
  nodeNum: number;
  /** Ascending time order. */
  points: AircraftTrailPoint[];
}

export interface TrailPositionRow {
  sourceId: string;
  nodeNum: number;
  latitude: number;
  longitude: number;
  altitude: number | null;
  timestamp: number;
}

/**
 * Parse the `hours` query param: integer, clamped to 1..168, default 6 when
 * missing or not a number.
 */
export function clampTrailHours(raw: unknown): number {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return AIRCRAFT_TRAIL_DEFAULT_HOURS;
  return Math.min(Math.max(n, AIRCRAFT_TRAIL_MIN_HOURS), AIRCRAFT_TRAIL_MAX_HOURS);
}

/**
 * Group rows into trails, sort each trail by time, downsample it to
 * `maxPoints`, and keep the `maxTrails` trails with the newest last fix.
 */
export function buildAircraftTrails(
  rows: TrailPositionRow[],
  maxPoints: number = AIRCRAFT_TRAIL_MAX_POINTS,
  maxTrails: number = AIRCRAFT_TRAIL_MAX_TRAILS,
): AircraftTrail[] {
  const grouped = new Map<string, AircraftTrail>();
  for (const r of rows) {
    const key = `${r.sourceId}:${r.nodeNum}`;
    let trail = grouped.get(key);
    if (!trail) {
      trail = { sourceId: r.sourceId, nodeNum: r.nodeNum, points: [] };
      grouped.set(key, trail);
    }
    trail.points.push({ lat: r.latitude, lon: r.longitude, alt: r.altitude, ts: r.timestamp });
  }

  const trails = Array.from(grouped.values());
  for (const t of trails) {
    t.points.sort((a, b) => a.ts - b.ts);
    t.points = downsamplePositionHistory(t.points, maxPoints);
  }

  const lastTs = (t: AircraftTrail): number => t.points[t.points.length - 1]?.ts ?? 0;
  trails.sort((a, b) => lastTs(b) - lastTs(a));
  return trails.slice(0, maxTrails);
}
