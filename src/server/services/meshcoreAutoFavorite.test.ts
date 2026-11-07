/**
 * MeshCore Auto Favorite planner (#6224). The sweep's safety properties live in
 * the pure planner: it favourites active contacts, un-favourites only the nodes
 * it previously owned, and never touches a hand-picked favourite.
 */
import { describe, it, expect } from 'vitest';
import {
  planAutoFavoriteSweep,
  clampIntervalHours,
  clampStaleHours,
  AUTO_FAVORITE_DEFAULT_INTERVAL_HOURS,
  AUTO_FAVORITE_DEFAULT_STALE_HOURS,
  AUTO_FAVORITE_MIN_INTERVAL_HOURS,
  AUTO_FAVORITE_MAX_INTERVAL_HOURS,
  type AutoFavoriteContact,
} from './meshcoreAutoFavorite.js';

const NOW = 1_000_000_000_000;
const HOUR = 3_600_000;
const c = (publicKey: string, hoursAgo: number, isFavorite = false): AutoFavoriteContact => ({
  publicKey,
  lastSeen: NOW - hoursAgo * HOUR,
  isFavorite,
});

describe('planAutoFavoriteSweep', () => {
  it('favourites active, not-yet-favourited contacts', () => {
    const plan = planAutoFavoriteSweep({
      contacts: [c('AA', 1), c('BB', 2, true)],
      tracked: [],
      staleHours: 72,
      now: NOW,
      enabled: true,
    });
    expect(plan.toFavorite).toEqual(['aa']); // BB already favourited
    expect(plan.toUnfavorite).toEqual([]);
    expect(plan.newTracked).toEqual(['aa']);
  });

  it('un-favourites a tracked node that went stale, keeping an active tracked one', () => {
    // aa was favourited by a prior sweep (isFavorite true); bb went stale.
    const plan = planAutoFavoriteSweep({
      contacts: [c('aa', 1, true), c('bb', 100, true)],
      tracked: ['aa', 'bb'],
      staleHours: 72,
      now: NOW,
      enabled: true,
    });
    expect(plan.toUnfavorite).toEqual(['bb']);
    expect(plan.newTracked).toEqual(['aa']);
    expect(plan.toFavorite).toEqual([]); // aa already favourited (tracked + active)
  });

  it('never un-favourites a node it does not own (manual favourite stays)', () => {
    const plan = planAutoFavoriteSweep({
      contacts: [c('manual', 500, true)], // stale but user-favourited, not tracked
      tracked: [],
      staleHours: 72,
      now: NOW,
      enabled: true,
    });
    expect(plan.toUnfavorite).toEqual([]);
    expect(plan.toFavorite).toEqual([]);
    expect(plan.newTracked).toEqual([]);
  });

  it('disabled: un-favourites everything it owns and tracks nothing', () => {
    const plan = planAutoFavoriteSweep({
      contacts: [c('aa', 1)],
      tracked: ['aa', 'bb'],
      staleHours: 72,
      now: NOW,
      enabled: false,
    });
    expect(plan.toUnfavorite.sort()).toEqual(['aa', 'bb']);
    expect(plan.toFavorite).toEqual([]);
    expect(plan.newTracked).toEqual([]);
  });

  it('treats a never-heard (null/zero lastSeen) contact as inactive', () => {
    const plan = planAutoFavoriteSweep({
      contacts: [{ publicKey: 'aa', lastSeen: null }, { publicKey: 'bb', lastSeen: 0 }],
      tracked: [],
      staleHours: 72,
      now: NOW,
      enabled: true,
    });
    expect(plan.toFavorite).toEqual([]);
  });

  it('is case-insensitive when matching tracked keys to contacts', () => {
    const plan = planAutoFavoriteSweep({
      contacts: [c('ABCD', 1)],
      tracked: ['abcd'],
      staleHours: 72,
      now: NOW,
      enabled: true,
    });
    // tracked + active ⇒ kept, not re-favourited, not un-favourited
    expect(plan.toUnfavorite).toEqual([]);
    expect(plan.newTracked).toEqual(['abcd']);
  });
});

describe('clamps', () => {
  it('interval falls back to default on garbage and bounds the range', () => {
    expect(clampIntervalHours('')).toBe(AUTO_FAVORITE_DEFAULT_INTERVAL_HOURS);
    expect(clampIntervalHours('abc')).toBe(AUTO_FAVORITE_DEFAULT_INTERVAL_HOURS);
    expect(clampIntervalHours('0')).toBe(AUTO_FAVORITE_MIN_INTERVAL_HOURS);
    expect(clampIntervalHours('999')).toBe(AUTO_FAVORITE_MAX_INTERVAL_HOURS);
  });

  it('stale falls back to default on garbage', () => {
    expect(clampStaleHours(null)).toBe(AUTO_FAVORITE_DEFAULT_STALE_HOURS);
    expect(clampStaleHours('0')).toBe(1);
  });
});
