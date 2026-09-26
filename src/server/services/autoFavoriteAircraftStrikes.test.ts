/**
 * Pure two-strike sweep-removal helpers (#5364/#5365 Phase 1 WP3, spec §4.11,
 * decision D19). See favoritesService.test.ts for the integration-level
 * (a)-(k) sweep scenarios that exercise these through `autoFavoriteSweep`.
 */
import { describe, it, expect } from 'vitest';
import {
  parseAircraftStrikes,
  applyAircraftStrike,
  AIRCRAFT_STRIKE_MIN_GAP_MS,
  AIRCRAFT_STRIKES_TO_REMOVE,
} from './autoFavoriteAircraftStrikes.js';

describe('parseAircraftStrikes', () => {
  it('null/undefined/empty string → {}', () => {
    expect(parseAircraftStrikes(null)).toEqual({});
    expect(parseAircraftStrikes(undefined)).toEqual({});
    expect(parseAircraftStrikes('')).toEqual({});
  });

  it('"[]" (array, not object) → {}', () => {
    expect(parseAircraftStrikes('[]')).toEqual({});
  });

  it('garbage / non-JSON → {}', () => {
    expect(parseAircraftStrikes('not json{{{')).toEqual({});
    expect(parseAircraftStrikes('null')).toEqual({});
    expect(parseAircraftStrikes('"a string"')).toEqual({});
    expect(parseAircraftStrikes('42')).toEqual({});
  });

  it('drops entries that are not a valid AircraftStrike shape', () => {
    const raw = JSON.stringify({
      '111': { count: 1, lastAt: 1000 },
      '222': { count: 'not-a-number', lastAt: 1000 },
      '333': { lastAt: 1000 }, // missing count
      '444': null,
      '555': 'nope',
    });
    expect(parseAircraftStrikes(raw)).toEqual({ '111': { count: 1, lastAt: 1000 } });
  });

  it('round-trips a valid object', () => {
    const strikes = { '111': { count: 1, lastAt: 1000 }, '222': { count: 2, lastAt: 5000 } };
    expect(parseAircraftStrikes(JSON.stringify(strikes))).toEqual(strikes);
  });
});

describe('applyAircraftStrike', () => {
  it('not flagged with no prior entry → next null, no removal', () => {
    expect(applyAircraftStrike(undefined, false, 1000)).toEqual({ next: null, remove: false });
  });

  it('not flagged clears an existing entry (streak broken)', () => {
    expect(applyAircraftStrike({ count: 1, lastAt: 1000 }, false, 2000)).toEqual({ next: null, remove: false });
  });

  it('flagged with no entry → count 1, no removal', () => {
    expect(applyAircraftStrike(undefined, true, 1000)).toEqual({ next: { count: 1, lastAt: 1000 }, remove: false });
  });

  it('flagged again exactly at the minimum gap → count 2, removal', () => {
    const prev = { count: 1, lastAt: 1000 };
    const now = 1000 + AIRCRAFT_STRIKE_MIN_GAP_MS;
    expect(applyAircraftStrike(prev, true, now)).toEqual({ next: { count: 2, lastAt: now }, remove: true });
  });

  it('flagged again 1 ms short of the minimum gap → unchanged, no removal', () => {
    const prev = { count: 1, lastAt: 1000 };
    const now = 1000 + AIRCRAFT_STRIKE_MIN_GAP_MS - 1;
    expect(applyAircraftStrike(prev, true, now)).toEqual({ next: prev, remove: false });
  });

  it('a 3-day gap still counts as the second strike (no upper bound)', () => {
    const prev = { count: 1, lastAt: 1000 };
    const now = 1000 + 3 * 24 * 60 * 60_000;
    const { next, remove } = applyAircraftStrike(prev, true, now);
    expect(next).toEqual({ count: 2, lastAt: now });
    expect(remove).toBe(true);
  });

  it('AIRCRAFT_STRIKES_TO_REMOVE is 2', () => {
    expect(AIRCRAFT_STRIKES_TO_REMOVE).toBe(2);
  });
});
