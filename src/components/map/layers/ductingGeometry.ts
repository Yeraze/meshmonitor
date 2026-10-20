/**
 * Pure geometry and styling for the ducting overlay (#5734), shared by the
 * layer and its legend so the two always agree.
 *
 * Classes follow ITU-R P.453, as the server reports them:
 *  - normal / sub-refractive: no fill (sub-refraction shortens range; it is
 *    left unfilled so the map only marks where range is enhanced).
 *  - super-refractive (gradient <= -79 N/km): one light tint.
 *  - ducting (gradient <= -157 N/km): a stronger tone whose opacity grows with
 *    the duct's strength, ΔM (M-unit drop across the trapping layer).
 */
import type { LatLngBoundsExpression } from 'leaflet';
import type { DuctingClass, DuctingGrid } from '../../../hooks/useDuctingForecast';

export type DuctingTone = 'super' | 'duct';

export interface DuctingCellStyle {
  tone: DuctingTone;
  fillOpacity: number;
}

/** Super-refractive cells: light, so nodes stay readable. */
export const SUPER_REFRACTIVE_OPACITY = 0.22;
/** Ducting cells run from MIN (ΔM 0) to MAX (ΔM >= saturation). */
export const DUCTING_MIN_OPACITY = 0.3;
export const DUCTING_MAX_OPACITY = 0.6;
/** ΔM at which a duct reads as "strong" and the shade stops darkening. */
export const DUCT_STRENGTH_SATURATION_M = 20;

/** The scrubber commits a step only after resting this long (ms). */
export const DUCTING_SCRUB_DEBOUNCE_MS = 300;

/** How to fill one cell, or null to leave it clear. */
export function ductingCellStyle(cls: DuctingClass | null, ductStrengthM: number | null): DuctingCellStyle | null {
  if (cls === 'super-refractive') return { tone: 'super', fillOpacity: SUPER_REFRACTIVE_OPACITY };
  if (cls === 'ducting') {
    const strength = Math.max(0, Math.min(1, (ductStrengthM ?? 0) / DUCT_STRENGTH_SATURATION_M));
    const opacity = DUCTING_MIN_OPACITY + strength * (DUCTING_MAX_OPACITY - DUCTING_MIN_OPACITY);
    return { tone: 'duct', fillOpacity: Math.round(opacity * 1000) / 1000 };
  }
  return null;
}

/** The bounds of cell `k` (row-major, north row first) around its grid point. */
export function ductingCellBounds(grid: DuctingGrid, k: number): LatLngBoundsExpression {
  const row = Math.floor(k / grid.ni);
  const col = k % grid.ni;
  const lat = grid.lat1 - row * grid.dLat;
  const lon = grid.lon1 + col * grid.dLon;
  return [
    [lat - grid.dLat / 2, lon - grid.dLon / 2],
    [lat + grid.dLat / 2, lon + grid.dLon / 2],
  ];
}

/** "2026-10-20T12:00:00.000Z" -> "2026-10-20 12Z": the GFS run name. */
export function formatGfsCycle(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}Z`;
}

/** A valid time in the viewer's local time, e.g. "Tue 14:00". */
export function formatValidTimeLocal(iso: string, locale?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(d);
}
