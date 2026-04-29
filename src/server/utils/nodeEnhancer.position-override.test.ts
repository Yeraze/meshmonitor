import { describe, it, expect } from 'vitest';
import { getEffectiveDbNodePosition } from './nodeEnhancer.js';

/**
 * Tests for getEffectiveDbNodePosition — the canonical helper that resolves
 * a node row's effective position. Used by every read-side surface so the
 * user-set override (issue #2847) reaches the map, embed, topology, position
 * config UI, geofences, distance-based auto-delete, traceroute snapshots,
 * NodeInfo broadcasts, and virtual node clients.
 */
describe('getEffectiveDbNodePosition', () => {
  it('returns override coords when override is enabled and both lat/lon are set', () => {
    const node = {
      latitude: 40.0,
      longitude: -75.0,
      altitude: 100,
      positionOverrideEnabled: true,
      latitudeOverride: 41.0,
      longitudeOverride: -76.0,
      altitudeOverride: 200,
    };

    const result = getEffectiveDbNodePosition(node);
    expect(result.latitude).toBe(41.0);
    expect(result.longitude).toBe(-76.0);
    expect(result.altitude).toBe(200);
    expect(result.isOverride).toBe(true);
  });

  it('falls back to device altitude when override altitude is null', () => {
    const node = {
      latitude: 40.0,
      longitude: -75.0,
      altitude: 100,
      positionOverrideEnabled: true,
      latitudeOverride: 41.0,
      longitudeOverride: -76.0,
      altitudeOverride: null,
    };

    const result = getEffectiveDbNodePosition(node);
    expect(result.latitude).toBe(41.0);
    expect(result.longitude).toBe(-76.0);
    // Override doesn't include altitude → keep device-reported altitude so
    // map circles / NodeInfo broadcasts retain elevation context.
    expect(result.altitude).toBe(100);
    expect(result.isOverride).toBe(true);
  });

  it('returns device coords when override is disabled', () => {
    const node = {
      latitude: 40.0,
      longitude: -75.0,
      altitude: 100,
      positionOverrideEnabled: false,
      latitudeOverride: 41.0,
      longitudeOverride: -76.0,
      altitudeOverride: 200,
    };

    const result = getEffectiveDbNodePosition(node);
    expect(result.latitude).toBe(40.0);
    expect(result.longitude).toBe(-75.0);
    expect(result.altitude).toBe(100);
    expect(result.isOverride).toBe(false);
  });

  it('treats SQLite truthy 1 as override-enabled', () => {
    // SQLite stores booleans as 0/1 ints; the helper must accept the int form
    // as truthy so behaviour is consistent across all three database backends.
    const node = {
      latitude: 40.0,
      longitude: -75.0,
      positionOverrideEnabled: 1 as unknown as boolean,
      latitudeOverride: 41.0,
      longitudeOverride: -76.0,
    };

    const result = getEffectiveDbNodePosition(node);
    expect(result.latitude).toBe(41.0);
    expect(result.isOverride).toBe(true);
  });

  it('falls back to device coords when override is enabled but lat is missing', () => {
    // Defensive: an enabled flag without coords would be a stale/half-set
    // override; never silently surface undefined as an override hit.
    const node = {
      latitude: 40.0,
      longitude: -75.0,
      positionOverrideEnabled: true,
      latitudeOverride: null,
      longitudeOverride: -76.0,
    };

    const result = getEffectiveDbNodePosition(node);
    expect(result.latitude).toBe(40.0);
    expect(result.longitude).toBe(-75.0);
    expect(result.isOverride).toBe(false);
  });

  it('falls back to device coords when override is enabled but lon is missing', () => {
    const node = {
      latitude: 40.0,
      longitude: -75.0,
      positionOverrideEnabled: true,
      latitudeOverride: 41.0,
      longitudeOverride: null,
    };

    const result = getEffectiveDbNodePosition(node);
    expect(result.latitude).toBe(40.0);
    expect(result.longitude).toBe(-75.0);
    expect(result.isOverride).toBe(false);
  });

  it('returns undefineds for null node', () => {
    const result = getEffectiveDbNodePosition(null);
    expect(result.latitude).toBeUndefined();
    expect(result.longitude).toBeUndefined();
    expect(result.altitude).toBeUndefined();
    expect(result.isOverride).toBe(false);
  });

  it('returns undefineds for undefined node', () => {
    const result = getEffectiveDbNodePosition(undefined);
    expect(result.latitude).toBeUndefined();
    expect(result.longitude).toBeUndefined();
    expect(result.altitude).toBeUndefined();
    expect(result.isOverride).toBe(false);
  });

  it('returns null device coords when node has no position at all', () => {
    const node = {
      latitude: null,
      longitude: null,
      altitude: null,
      positionOverrideEnabled: false,
    };

    const result = getEffectiveDbNodePosition(node);
    expect(result.latitude).toBeNull();
    expect(result.longitude).toBeNull();
    expect(result.altitude).toBeNull();
    expect(result.isOverride).toBe(false);
  });

  it('handles a node with only an override (no device GPS yet)', () => {
    // New node where the user set an override before any GPS packet arrived.
    const node = {
      latitude: null,
      longitude: null,
      altitude: null,
      positionOverrideEnabled: true,
      latitudeOverride: 50.0,
      longitudeOverride: 8.0,
      altitudeOverride: 300,
    };

    const result = getEffectiveDbNodePosition(node);
    expect(result.latitude).toBe(50.0);
    expect(result.longitude).toBe(8.0);
    expect(result.altitude).toBe(300);
    expect(result.isOverride).toBe(true);
  });

  it('treats override coord 0 as a valid value (not null/undefined)', () => {
    // 0 is a real coordinate (e.g., Greenwich meridian). The helper must use
    // null-checks, not falsy checks, so equator/prime-meridian overrides work.
    const node = {
      latitude: 40.0,
      longitude: -75.0,
      positionOverrideEnabled: true,
      latitudeOverride: 0,
      longitudeOverride: 0,
    };

    const result = getEffectiveDbNodePosition(node);
    expect(result.latitude).toBe(0);
    expect(result.longitude).toBe(0);
    expect(result.isOverride).toBe(true);
  });
});
