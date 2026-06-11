/**
 * Unit tests for the pure helpers behind Automated Remote Favorites
 * Management (issue #2608). The orchestration (runCycleForTarget) is exercised
 * indirectly via these building blocks plus the repository tests.
 */
import { describe, it, expect } from 'vitest';
import {
  isCycleDue,
  isNeighborDataFresh,
  parseEligibleRoles,
  discoverTracerouteNeighbors,
  selectNewFavorites,
  selectRefavorites,
  ackStatusLabel,
} from './autoFavoriteManagementService.js';
import type { DbTraceroute, DbAutoFavoriteAssignment } from '../../db/types.js';

function tr(partial: Partial<DbTraceroute>): DbTraceroute {
  return {
    fromNodeNum: 0,
    toNodeNum: 0,
    fromNodeId: '',
    toNodeId: '',
    route: null,
    routeBack: null,
    snrTowards: null,
    snrBack: null,
    timestamp: 0,
    createdAt: 0,
    ...partial,
  };
}

describe('isCycleDue', () => {
  const HOUR = 60 * 60 * 1000;
  it('is due when never run', () => {
    expect(isCycleDue(null, 24, 1_000_000)).toBe(true);
    expect(isCycleDue(undefined, 24, 1_000_000)).toBe(true);
  });
  it('is not due before the interval elapses', () => {
    const now = 1_000_000;
    expect(isCycleDue(now - 23 * HOUR, 24, now)).toBe(false);
  });
  it('is due once the interval elapses', () => {
    const now = 1_000_000;
    expect(isCycleDue(now - 24 * HOUR, 24, now)).toBe(true);
    expect(isCycleDue(now - 25 * HOUR, 24, now)).toBe(true);
  });
});

describe('isNeighborDataFresh', () => {
  const HOUR = 60 * 60 * 1000;
  const now = 10_000_000;
  it('is not fresh when no record on file', () => {
    expect(isNeighborDataFresh(null, 24, now)).toBe(false);
    expect(isNeighborDataFresh(undefined, 24, now)).toBe(false);
  });
  it('is fresh when the newest record is within maxAgeHours', () => {
    expect(isNeighborDataFresh(now - 23 * HOUR, 24, now)).toBe(true);
  });
  it('is not fresh once the record exceeds maxAgeHours', () => {
    expect(isNeighborDataFresh(now - 24 * HOUR, 24, now)).toBe(false);
    expect(isNeighborDataFresh(now - 48 * HOUR, 24, now)).toBe(false);
  });
  it('maxAgeHours <= 0 disables reuse (never fresh)', () => {
    expect(isNeighborDataFresh(now, 0, now)).toBe(false);
    expect(isNeighborDataFresh(now - HOUR, -5, now)).toBe(false);
  });
});

describe('parseEligibleRoles', () => {
  it('defaults to router/router-late/client-base when empty or invalid', () => {
    expect(parseEligibleRoles(null)).toEqual(new Set([2, 11, 12]));
    expect(parseEligibleRoles('')).toEqual(new Set([2, 11, 12]));
    expect(parseEligibleRoles('not json')).toEqual(new Set([2, 11, 12]));
    expect(parseEligibleRoles('{"a":1}')).toEqual(new Set([2, 11, 12]));
  });
  it('parses an explicit role array', () => {
    expect(parseEligibleRoles('[2,4]')).toEqual(new Set([2, 4]));
    expect(parseEligibleRoles('[]')).toEqual(new Set([]));
  });
});

describe('discoverTracerouteNeighbors', () => {
  it('finds nodes adjacent to the target in the forward path', () => {
    // path: 10 -> [20, 30] -> 40 ; target 30 neighbors are 20 and 40
    const result = discoverTracerouteNeighbors(
      [tr({ fromNodeNum: 10, toNodeNum: 40, route: JSON.stringify([20, 30]) })],
      30,
    );
    expect(new Set(result)).toEqual(new Set([20, 40]));
  });

  it('uses the endpoints as neighbors when target is a single intermediate hop', () => {
    // path: 10 -> [30] -> 40 ; target 30 neighbors are 10 and 40
    const result = discoverTracerouteNeighbors(
      [tr({ fromNodeNum: 10, toNodeNum: 40, route: JSON.stringify([30]) })],
      30,
    );
    expect(new Set(result)).toEqual(new Set([10, 40]));
  });

  it('also scans the return path', () => {
    // back path: 40 -> [50] -> 10 ; target 50 neighbors are 40 and 10
    const result = discoverTracerouteNeighbors(
      [tr({ fromNodeNum: 10, toNodeNum: 40, route: JSON.stringify([]), routeBack: JSON.stringify([50]) })],
      50,
    );
    expect(new Set(result)).toEqual(new Set([40, 10]));
  });

  it('excludes the target itself and the broadcast placeholder', () => {
    const result = discoverTracerouteNeighbors(
      [tr({ fromNodeNum: 10, toNodeNum: 0xffffffff, route: JSON.stringify([30]) })],
      30,
    );
    // neighbor 10 is valid; 0xffffffff (broadcast) is dropped
    expect(result).toEqual([10]);
  });

  it('returns empty when the target never appears', () => {
    const result = discoverTracerouteNeighbors(
      [tr({ fromNodeNum: 1, toNodeNum: 2, route: JSON.stringify([3, 4]) })],
      99,
    );
    expect(result).toEqual([]);
  });

  it('dedupes across multiple traceroutes preserving first-seen order', () => {
    const result = discoverTracerouteNeighbors(
      [
        tr({ fromNodeNum: 10, toNodeNum: 40, route: JSON.stringify([30]) }), // -> 10, 40
        tr({ fromNodeNum: 50, toNodeNum: 40, route: JSON.stringify([30]) }), // -> 50, 40 (40 dup)
      ],
      30,
    );
    expect(result).toEqual([10, 40, 50]);
  });
});

describe('selectNewFavorites', () => {
  const eligibleRoles = new Set([2, 11, 12]);
  const roleByNode = new Map<number, number | null | undefined>([
    [20, 2],    // router — eligible
    [21, 12],   // client base — eligible
    [22, 0],    // client — not eligible
    [23, null], // unknown role — skipped
  ]);

  it('picks eligible, unassigned, non-excluded candidates up to max', () => {
    const picked = selectNewFavorites({
      candidates: [22, 20, 21],
      assigned: new Set(),
      excluded: new Set(),
      eligibleRoles,
      roleByNode,
      max: 1,
    });
    expect(picked).toEqual([20]); // 22 skipped (role 0), capped at 1
  });

  it('skips already-assigned and excluded nodes', () => {
    const picked = selectNewFavorites({
      candidates: [20, 21],
      assigned: new Set([20]),
      excluded: new Set([21]),
      eligibleRoles,
      roleByNode,
      max: 5,
    });
    expect(picked).toEqual([]);
  });

  it('skips nodes with unknown role', () => {
    const picked = selectNewFavorites({
      candidates: [23, 21],
      assigned: new Set(),
      excluded: new Set(),
      eligibleRoles,
      roleByNode,
      max: 5,
    });
    expect(picked).toEqual([21]);
  });

  it('returns nothing when max is 0', () => {
    const picked = selectNewFavorites({
      candidates: [20, 21],
      assigned: new Set(),
      excluded: new Set(),
      eligibleRoles,
      roleByNode,
      max: 0,
    });
    expect(picked).toEqual([]);
  });

  it('favorites the local (controlling) node when it is a discovered neighbor', () => {
    // Only the target is excluded; the local node (20, a router) is eligible.
    const picked = selectNewFavorites({
      candidates: [20],
      assigned: new Set(),
      excluded: new Set([999]), // target only — local NOT excluded
      eligibleRoles,
      roleByNode,
      max: 1,
    });
    expect(picked).toEqual([20]);
  });
});

describe('selectRefavorites', () => {
  function assign(fav: number, lastAssignedAt: number, lastAckStatus?: string): DbAutoFavoriteAssignment {
    return { sourceId: 's', targetNodeNum: 1, favoriteNodeNum: fav, firstAssignedAt: 0, lastAssignedAt, lastAckStatus };
  }

  it('returns the oldest assignments first, capped at max', () => {
    const picked = selectRefavorites([assign(10, 300), assign(20, 100), assign(30, 200)], 2);
    expect(picked).toEqual([20, 30]); // sorted by lastAssignedAt asc
  });

  it('prioritizes un-confirmed assignments over confirmed ones', () => {
    // 10 confirmed (oldest), 20 timed out, 30 confirmed. Un-confirmed (20) first.
    const picked = selectRefavorites([
      assign(10, 100, 'confirmed'),
      assign(20, 300, 'timeout'),
      assign(30, 200, 'confirmed'),
    ], 2);
    expect(picked[0]).toBe(20); // un-confirmed first despite newest
    expect(picked).toEqual([20, 10]); // then oldest confirmed
  });

  it('treats a routing-error status as un-confirmed', () => {
    const picked = selectRefavorites([
      assign(10, 100, 'confirmed'),
      assign(20, 200, 'ADMIN_BAD_SESSION_KEY'),
    ], 1);
    expect(picked).toEqual([20]);
  });

  it('returns nothing for max <= 0', () => {
    expect(selectRefavorites([assign(10, 100)], 0)).toEqual([]);
  });

  it('returns all when max exceeds count', () => {
    expect(selectRefavorites([assign(10, 100)], 5)).toEqual([10]);
  });
});

describe('ackStatusLabel', () => {
  it('maps a successful ACK to confirmed', () => {
    expect(ackStatusLabel({ acked: true, errorReason: 0, timedOut: false })).toBe('confirmed');
  });
  it('maps a timeout', () => {
    expect(ackStatusLabel({ acked: false, errorReason: null, timedOut: true })).toBe('timeout');
  });
  it('maps a routing error to its name', () => {
    // 36 = ADMIN_BAD_SESSION_KEY
    expect(ackStatusLabel({ acked: false, errorReason: 36, timedOut: false })).toBe('ADMIN_BAD_SESSION_KEY');
  });
});
