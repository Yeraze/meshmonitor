/**
 * Client-side waypoint-anchor helpers (#4722).
 *
 * `isCompleteAnchor` is the editor's mirror of the engine's
 * `normalizeGeofenceAnchor`. If the two disagree, the builder happily saves a
 * fence the engine then refuses to resolve — a rule that looks configured and
 * silently never fires. These pin the agreement.
 */
import { describe, it, expect } from 'vitest';
import { isWaypointAnchor, isCompleteAnchor } from './geofenceAnchor';

describe('isWaypointAnchor', () => {
  it('distinguishes an anchor from the drawn-region shapes', () => {
    expect(isWaypointAnchor({ type: 'waypoint', sourceId: 's', waypointId: 1, radiusKm: 1 })).toBe(true);
    expect(isWaypointAnchor({ type: 'circle', center: { lat: 0, lng: 0 }, radiusKm: 1 })).toBe(false);
    expect(isWaypointAnchor({ type: 'polygon', vertices: [] })).toBe(false);
    expect(isWaypointAnchor(undefined)).toBe(false);
    expect(isWaypointAnchor(null)).toBe(false);
  });
});

describe('isCompleteAnchor — mirrors the engine parser', () => {
  const full = { type: 'waypoint' as const, sourceId: 'src-a', waypointId: 42, radiusKm: 0.5 };

  it('accepts a fully specified anchor', () => {
    expect(isCompleteAnchor(full)).toBe(true);
  });

  it('accepts waypoint id 0 — a real id, not "unset"', () => {
    // The obvious falsy-check bug: `if (!waypointId)` would reject this.
    expect(isCompleteAnchor({ ...full, waypointId: 0 })).toBe(true);
  });

  it('rejects a missing or blank source', () => {
    expect(isCompleteAnchor({ ...full, sourceId: '' })).toBe(false);
    expect(isCompleteAnchor({ ...full, sourceId: '   ' })).toBe(false);
    expect(isCompleteAnchor({ ...full, sourceId: undefined })).toBe(false);
  });

  it('rejects a missing waypoint', () => {
    expect(isCompleteAnchor({ ...full, waypointId: undefined })).toBe(false);
    expect(isCompleteAnchor({ ...full, waypointId: Number.NaN })).toBe(false);
  });

  it('rejects a non-positive radius, which could never be entered', () => {
    expect(isCompleteAnchor({ ...full, radiusKm: 0 })).toBe(false);
    expect(isCompleteAnchor({ ...full, radiusKm: -1 })).toBe(false);
    expect(isCompleteAnchor({ ...full, radiusKm: undefined })).toBe(false);
  });

  it('rejects nothing at all', () => {
    expect(isCompleteAnchor(undefined)).toBe(false);
  });
});
