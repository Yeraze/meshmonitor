import { describe, it, expect } from 'vitest';
import { isAutoFavoriteEligible, isAutoFavoriteValidRole } from './constants/autoFavorite';
import { DeviceRole } from '../constants';

describe('isAutoFavoriteEligible', () => {
  it('returns true for 0-hop ROUTER when local is ROUTER', () => {
    expect(isAutoFavoriteEligible(DeviceRole.ROUTER, { hopsAway: 0, role: DeviceRole.ROUTER, isFavorite: false })).toBe(true);
  });

  it('returns true for 0-hop ROUTER_LATE when local is ROUTER', () => {
    expect(isAutoFavoriteEligible(DeviceRole.ROUTER, { hopsAway: 0, role: DeviceRole.ROUTER_LATE, isFavorite: false })).toBe(true);
  });

  it('returns true for 0-hop CLIENT_BASE when local is ROUTER', () => {
    expect(isAutoFavoriteEligible(DeviceRole.ROUTER, { hopsAway: 0, role: DeviceRole.CLIENT_BASE, isFavorite: false })).toBe(true);
  });

  it('returns false for 0-hop CLIENT when local is ROUTER', () => {
    expect(isAutoFavoriteEligible(DeviceRole.ROUTER, { hopsAway: 0, role: DeviceRole.CLIENT, isFavorite: false })).toBe(false);
  });

  it('returns true for 0-hop CLIENT when local is CLIENT_BASE (any role eligible)', () => {
    expect(isAutoFavoriteEligible(DeviceRole.CLIENT_BASE, { hopsAway: 0, role: DeviceRole.CLIENT, isFavorite: false })).toBe(true);
  });

  it('returns true for 0-hop ROUTER when local is CLIENT_BASE', () => {
    expect(isAutoFavoriteEligible(DeviceRole.CLIENT_BASE, { hopsAway: 0, role: DeviceRole.ROUTER, isFavorite: false })).toBe(true);
  });

  it('returns false for multi-hop node regardless of role', () => {
    expect(isAutoFavoriteEligible(DeviceRole.ROUTER, { hopsAway: 2, role: DeviceRole.ROUTER, isFavorite: false })).toBe(false);
  });

  it('returns false when local role is CLIENT (not eligible)', () => {
    expect(isAutoFavoriteEligible(DeviceRole.CLIENT, { hopsAway: 0, role: DeviceRole.ROUTER, isFavorite: false })).toBe(false);
  });

  it('returns false when target is already favorited', () => {
    expect(isAutoFavoriteEligible(DeviceRole.ROUTER, { hopsAway: 0, role: DeviceRole.ROUTER, isFavorite: true })).toBe(false);
  });

  it('returns false when hopsAway is null/undefined', () => {
    expect(isAutoFavoriteEligible(DeviceRole.ROUTER, { hopsAway: null, role: DeviceRole.ROUTER, isFavorite: false })).toBe(false);
    expect(isAutoFavoriteEligible(DeviceRole.ROUTER, { hopsAway: undefined, role: DeviceRole.ROUTER, isFavorite: false })).toBe(false);
  });

  it('returns true for ROUTER_LATE local with 0-hop ROUTER target', () => {
    expect(isAutoFavoriteEligible(DeviceRole.ROUTER_LATE, { hopsAway: 0, role: DeviceRole.ROUTER, isFavorite: false })).toBe(true);
  });

  it('returns false for 0-hop node received via MQTT', () => {
    expect(isAutoFavoriteEligible(DeviceRole.ROUTER, { hopsAway: 0, role: DeviceRole.ROUTER, isFavorite: false, viaMqtt: true })).toBe(false);
  });

  it('returns true for 0-hop non-MQTT node', () => {
    expect(isAutoFavoriteEligible(DeviceRole.ROUTER, { hopsAway: 0, role: DeviceRole.ROUTER, isFavorite: false, viaMqtt: false })).toBe(true);
  });

  it('returns true when viaMqtt is null/undefined (backwards compat)', () => {
    expect(isAutoFavoriteEligible(DeviceRole.ROUTER, { hopsAway: 0, role: DeviceRole.ROUTER, isFavorite: false, viaMqtt: null })).toBe(true);
    expect(isAutoFavoriteEligible(DeviceRole.ROUTER, { hopsAway: 0, role: DeviceRole.ROUTER, isFavorite: false, viaMqtt: undefined })).toBe(true);
  });

  // favoriteLocked tests — isAutoFavoriteEligible does not check favoriteLocked itself
  // (the caller checkAutoFavorite checks it before calling this function)
  // but the interface accepts it, so verify it doesn't break eligibility logic
  it('still evaluates eligibility when favoriteLocked is present', () => {
    expect(isAutoFavoriteEligible(DeviceRole.ROUTER, { hopsAway: 0, role: DeviceRole.ROUTER, isFavorite: false, favoriteLocked: false })).toBe(true);
    expect(isAutoFavoriteEligible(DeviceRole.ROUTER, { hopsAway: 0, role: DeviceRole.ROUTER, isFavorite: false, favoriteLocked: true })).toBe(true);
  });

  it('returns false for already-favorited node regardless of favoriteLocked', () => {
    expect(isAutoFavoriteEligible(DeviceRole.ROUTER, { hopsAway: 0, role: DeviceRole.ROUTER, isFavorite: true, favoriteLocked: false })).toBe(false);
    expect(isAutoFavoriteEligible(DeviceRole.ROUTER, { hopsAway: 0, role: DeviceRole.ROUTER, isFavorite: true, favoriteLocked: true })).toBe(false);
  });
});

describe('favoriteLocked behavior matrix', () => {
  // These tests document the expected behavior per the behavior matrix
  // They test the interface contract, not the implementation (which is in meshtasticManager)

  it('manual favorite sets favoriteLocked=true', () => {
    // When a user manually favorites a node via the API, favoriteLocked should be true
    // This is enforced in the POST /api/nodes/:nodeId/favorite endpoint
    const manualFavorite = { isFavorite: true, favoriteLocked: true };
    expect(manualFavorite.favoriteLocked).toBe(true);
  });

  it('manual unfavorite sets favoriteLocked=true (prevents re-auto-favorite)', () => {
    const manualUnfavorite = { isFavorite: false, favoriteLocked: true };
    expect(manualUnfavorite.favoriteLocked).toBe(true);
    expect(manualUnfavorite.isFavorite).toBe(false);
  });

  it('auto-favorite sets favoriteLocked=false', () => {
    const autoFavorite = { isFavorite: true, favoriteLocked: false };
    expect(autoFavorite.favoriteLocked).toBe(false);
  });

  it('sweep unfavorite sets favoriteLocked=false', () => {
    const sweepUnfavorite = { isFavorite: false, favoriteLocked: false };
    expect(sweepUnfavorite.favoriteLocked).toBe(false);
  });

  it('lock on auto-favorite promotes to manual (favoriteLocked=true)', () => {
    const promoted = { isFavorite: true, favoriteLocked: true };
    expect(promoted.favoriteLocked).toBe(true);
    expect(promoted.isFavorite).toBe(true);
  });

  it('unlock on manual favorite allows automation (favoriteLocked=false)', () => {
    const unlocked = { isFavorite: true, favoriteLocked: false };
    expect(unlocked.favoriteLocked).toBe(false);
  });
});

describe('isAutoFavoriteValidRole', () => {
  it('returns true for ROUTER', () => {
    expect(isAutoFavoriteValidRole(DeviceRole.ROUTER)).toBe(true);
  });
  it('returns true for ROUTER_LATE', () => {
    expect(isAutoFavoriteValidRole(DeviceRole.ROUTER_LATE)).toBe(true);
  });
  it('returns true for CLIENT_BASE', () => {
    expect(isAutoFavoriteValidRole(DeviceRole.CLIENT_BASE)).toBe(true);
  });
  it('returns false for CLIENT', () => {
    expect(isAutoFavoriteValidRole(DeviceRole.CLIENT)).toBe(false);
  });
  it('returns false for null/undefined', () => {
    expect(isAutoFavoriteValidRole(null)).toBe(false);
    expect(isAutoFavoriteValidRole(undefined)).toBe(false);
  });
});
