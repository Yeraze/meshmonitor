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
