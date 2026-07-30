/**
 * Unit tests for the pure fan-out functions shared by migration 132 and WP7
 * (#4416, PER_SOURCE_NODE_DISPLAY_PHASE6_SPEC.md §3.5).
 */
import { describe, it, expect } from 'vitest';
import { computeEffectiveGrants, computeFanOutInserts, pairKey, type RawGrantRow } from './settingsGrantFanout.js';

const NOW = 1_700_000_000_000;

function row(overrides: Partial<RawGrantRow> & { userId: number }): RawGrantRow {
  return {
    sourceId: null,
    canViewOnMap: false,
    canRead: false,
    canWrite: false,
    canDelete: false,
    grantedAt: 1000,
    grantedBy: 1,
    ...overrides,
  };
}

describe('computeEffectiveGrants', () => {
  it('returns [] for empty input', () => {
    expect(computeEffectiveGrants([], NOW)).toEqual([]);
  });

  it('OR-unions a single NULL-scoped row (the common case)', () => {
    const rows = [row({ userId: 1, sourceId: null, canRead: true, canWrite: true })];
    const out = computeEffectiveGrants(rows, NOW);
    expect(out).toEqual([
      { userId: 1, canViewOnMap: false, canRead: true, canWrite: true, canDelete: false, grantedAt: 1000, grantedBy: 1 },
    ]);
  });

  it('OR-unions across mixed-scope rows for the same user (the u6/u5 shape)', () => {
    // u6 shape: only a per-source-A write row, no global row at all.
    const rows = [row({ userId: 6, sourceId: 'A', canWrite: true, canRead: false })];
    const out = computeEffectiveGrants(rows, NOW);
    expect(out).toEqual([
      { userId: 6, canViewOnMap: false, canRead: false, canWrite: true, canDelete: false, grantedAt: 1000, grantedBy: 1 },
    ]);
  });

  it('OR-unions a NULL read row with a per-source-A write row (u5 shape) into read+write', () => {
    const rows = [
      row({ userId: 5, sourceId: null, canRead: true, canWrite: false, grantedAt: 111, grantedBy: 9 }),
      row({ userId: 5, sourceId: 'A', canRead: false, canWrite: true, grantedAt: 222, grantedBy: 8 }),
    ];
    const out = computeEffectiveGrants(rows, NOW);
    expect(out).toHaveLength(1);
    expect(out[0].canRead).toBe(true);
    expect(out[0].canWrite).toBe(true);
    // Donor is the NULL-scoped row even though it wasn't first by insertion
    // order relevance here — it appears first in this fixture, confirming
    // the "prefer NULL" rule doesn't depend on order when NULL comes first.
    expect(out[0].grantedAt).toBe(111);
    expect(out[0].grantedBy).toBe(9);
  });

  it('prefers the NULL-scoped row as donor even when it appears AFTER a per-source row', () => {
    const rows = [
      row({ userId: 5, sourceId: 'A', canWrite: true, grantedAt: 222, grantedBy: 8 }),
      row({ userId: 5, sourceId: null, canRead: true, grantedAt: 111, grantedBy: 9 }),
    ];
    const out = computeEffectiveGrants(rows, NOW);
    expect(out[0].grantedAt).toBe(111);
    expect(out[0].grantedBy).toBe(9);
  });

  it('falls back to the first per-source row as donor when no NULL row exists', () => {
    const rows = [
      row({ userId: 6, sourceId: 'A', canWrite: true, grantedAt: 333, grantedBy: 7 }),
      row({ userId: 6, sourceId: 'B', canRead: true, grantedAt: 444, grantedBy: 6 }),
    ];
    const out = computeEffectiveGrants(rows, NOW);
    expect(out[0].grantedAt).toBe(333);
    expect(out[0].grantedBy).toBe(7);
  });

  it('drops a user whose union is all-false (u3 shape)', () => {
    const rows = [row({ userId: 3, sourceId: null, canViewOnMap: false, canRead: false, canWrite: false, canDelete: false })];
    expect(computeEffectiveGrants(rows, NOW)).toEqual([]);
  });

  it('treats a missing canDelete (SQLite shape) as false without throwing', () => {
    const rowWithoutDelete: RawGrantRow = {
      userId: 1, sourceId: null, canViewOnMap: false, canRead: true, canWrite: false,
      grantedAt: 1000, grantedBy: 1,
    };
    const out = computeEffectiveGrants([rowWithoutDelete], NOW);
    expect(out[0].canDelete).toBe(false);
  });

  it('uses `now` and null grantedBy when a row somehow has null grantedAt/grantedBy', () => {
    const rows = [row({ userId: 2, sourceId: null, canRead: true, grantedAt: null, grantedBy: null })];
    const out = computeEffectiveGrants(rows, NOW);
    expect(out[0].grantedAt).toBe(NOW);
    expect(out[0].grantedBy).toBeNull();
  });

  it('handles multiple independent users in one pass', () => {
    const rows = [
      row({ userId: 1, sourceId: null, canRead: true }),
      row({ userId: 2, sourceId: null, canWrite: true }),
      row({ userId: 3, sourceId: null, canRead: false, canWrite: false }), // all-false, dropped
    ];
    const out = computeEffectiveGrants(rows, NOW);
    const byUser = new Map(out.map((g) => [g.userId, g]));
    expect(byUser.has(1)).toBe(true);
    expect(byUser.has(2)).toBe(true);
    expect(byUser.has(3)).toBe(false);
  });
});

describe('computeFanOutInserts', () => {
  it('returns [] for empty effective grants', () => {
    expect(computeFanOutInserts([], ['A', 'B'], new Set())).toEqual([]);
  });

  it('returns [] for empty sourceIds', () => {
    const effective = [{ userId: 1, canViewOnMap: false, canRead: true, canWrite: false, canDelete: false, grantedAt: 1, grantedBy: null }];
    expect(computeFanOutInserts(effective, [], new Set())).toEqual([]);
  });

  it('produces the full cartesian product when nothing pre-exists', () => {
    const effective = [
      { userId: 1, canViewOnMap: false, canRead: true, canWrite: true, canDelete: false, grantedAt: 1, grantedBy: null },
      { userId: 2, canViewOnMap: false, canRead: true, canWrite: false, canDelete: false, grantedAt: 1, grantedBy: null },
    ];
    const out = computeFanOutInserts(effective, ['A', 'B', 'C'], new Set());
    expect(out).toHaveLength(6);
    const key = (u: number, s: string) => `${u}:${s}`;
    const keys = new Set(out.map((o) => key(o.userId, o.sourceId)));
    for (const u of [1, 2]) for (const s of ['A', 'B', 'C']) expect(keys.has(key(u, s))).toBe(true);
  });

  it('excludes pairs already present in existingPairs', () => {
    const effective = [
      { userId: 1, canViewOnMap: false, canRead: true, canWrite: true, canDelete: false, grantedAt: 1, grantedBy: null },
    ];
    const existing = new Set([pairKey(1, 'A')]);
    const out = computeFanOutInserts(effective, ['A', 'B'], existing);
    expect(out).toHaveLength(1);
    expect(out[0].sourceId).toBe('B');
  });

  it('excludes all pairs when every one already exists (idempotent re-run shape)', () => {
    const effective = [
      { userId: 1, canViewOnMap: false, canRead: true, canWrite: true, canDelete: false, grantedAt: 1, grantedBy: null },
    ];
    const existing = new Set([pairKey(1, 'A'), pairKey(1, 'B')]);
    expect(computeFanOutInserts(effective, ['A', 'B'], existing)).toEqual([]);
  });

  it('carries the effective flags onto each inserted row', () => {
    const effective = [
      { userId: 1, canViewOnMap: true, canRead: true, canWrite: false, canDelete: true, grantedAt: 555, grantedBy: 9 },
    ];
    const out = computeFanOutInserts(effective, ['A'], new Set());
    expect(out[0]).toEqual({ userId: 1, sourceId: 'A', canViewOnMap: true, canRead: true, canWrite: false, canDelete: true, grantedAt: 555, grantedBy: 9 });
  });
});

describe('pairKey', () => {
  it('is stable and distinguishes user/source combinations', () => {
    expect(pairKey(1, 'A')).toBe('1:A');
    expect(pairKey(1, 'A')).not.toBe(pairKey(1, 'B'));
    expect(pairKey(1, 'A')).not.toBe(pairKey(2, 'A'));
  });
});
