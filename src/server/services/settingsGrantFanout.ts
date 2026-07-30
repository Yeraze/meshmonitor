/**
 * Settings-grant fan-out — the pure computation shared by migration 132
 * (#4416, PER_SOURCE_NODE_DISPLAY_PHASE6_SPEC.md §3.5) and WP7's
 * source-creation reconciliation (`sourceRoutes.ts`).
 *
 * Parameterized deliberately: this module takes rows and source ids and
 * knows nothing about *which* resource it is fanning out. The migration
 * passes its own frozen `'settings'` literal; WP7 passes its own literal at
 * the call site in `sourceRoutes.ts`. Neither caller may import a mutable
 * resource list into this module — see the frozen-constant note in
 * `132_fan_out_settings_permissions.ts`.
 *
 * Both exported functions are pure and total: no I/O, no Date.now() (the
 * caller supplies `now`), no throwing. All persistence (reads, the
 * transaction, the delete) lives in the caller so this module stays testable
 * without a database.
 */

export interface RawGrantRow {
  userId: number;
  sourceId: string | null;
  canViewOnMap: boolean;
  canRead: boolean;
  canWrite: boolean;
  /** Absent on SQLite (no can_delete column there); treated as false. */
  canDelete?: boolean;
  grantedAt: number | null;
  grantedBy: number | null;
}

export interface EffectiveGrant {
  userId: number;
  canViewOnMap: boolean;
  canRead: boolean;
  canWrite: boolean;
  canDelete: boolean;
  grantedAt: number;
  grantedBy: number | null;
}

/**
 * OR-union every row per user, regardless of that row's own sourceId scope.
 *
 * This mirrors the pre-flip `checkPermissionAsync` non-sourcey branch
 * exactly (see PHASE6 spec §3.2): the OR across *every* row the user has for
 * this resource, NULL-scoped or per-source, is today's effective answer. A
 * user whose only row is scoped to one source already has effective access
 * everywhere today, so the union must read every row, not just the NULL
 * ones, or the fan-out silently narrows that user (spec's negative control 2).
 *
 * Users whose union is all-false are dropped entirely — they were denied
 * before and remain denied after; writing an all-false row per source would
 * just be inert noise.
 *
 * `grantedAt`/`grantedBy` are taken from a single "donor" row per user:
 * prefer the NULL-scoped row (the common case — it's the row that is about
 * to be deleted, so its provenance is the most meaningful to preserve), else
 * the first per-source row encountered, else `now` / `null`.
 */
export function computeEffectiveGrants(rows: RawGrantRow[], now: number): EffectiveGrant[] {
  interface Acc {
    canViewOnMap: boolean;
    canRead: boolean;
    canWrite: boolean;
    canDelete: boolean;
    donor: RawGrantRow | null;
  }
  const byUser = new Map<number, Acc>();

  for (const row of rows) {
    let acc = byUser.get(row.userId);
    if (!acc) {
      acc = { canViewOnMap: false, canRead: false, canWrite: false, canDelete: false, donor: null };
      byUser.set(row.userId, acc);
    }
    acc.canViewOnMap = acc.canViewOnMap || !!row.canViewOnMap;
    acc.canRead = acc.canRead || !!row.canRead;
    acc.canWrite = acc.canWrite || !!row.canWrite;
    acc.canDelete = acc.canDelete || !!row.canDelete;

    // Donor preference: a NULL-scoped row always wins over a per-source row,
    // and the FIRST NULL-scoped row wins over any later one (stable). If no
    // NULL-scoped row is ever seen, keep the first row of any scope.
    if (!acc.donor) {
      acc.donor = row;
    } else if (acc.donor.sourceId !== null && row.sourceId === null) {
      acc.donor = row;
    }
  }

  const out: EffectiveGrant[] = [];
  for (const [userId, acc] of byUser) {
    if (!acc.canViewOnMap && !acc.canRead && !acc.canWrite && !acc.canDelete) continue;
    out.push({
      userId,
      canViewOnMap: acc.canViewOnMap,
      canRead: acc.canRead,
      canWrite: acc.canWrite,
      canDelete: acc.canDelete,
      grantedAt: acc.donor?.grantedAt ?? now,
      grantedBy: acc.donor?.grantedBy ?? null,
    });
  }
  return out;
}

/**
 * Cartesian product of `effective × sourceIds`, minus any (userId, sourceId)
 * pair already present in `existingPairs`. Pure and total — callers build
 * `existingPairs` from whatever per-source rows already exist so a
 * pre-existing per-source row is widened in place (by the caller) rather
 * than duplicated here.
 *
 * `existingPairs` keys must be `${userId}:${sourceId}` — see `pairKey()`.
 */
export function pairKey(userId: number, sourceId: string): string {
  return `${userId}:${sourceId}`;
}

export function computeFanOutInserts(
  effective: EffectiveGrant[],
  sourceIds: string[],
  existingPairs: ReadonlySet<string>,
): Array<EffectiveGrant & { sourceId: string }> {
  const out: Array<EffectiveGrant & { sourceId: string }> = [];
  for (const grant of effective) {
    for (const sourceId of sourceIds) {
      if (existingPairs.has(pairKey(grant.userId, sourceId))) continue;
      out.push({ ...grant, sourceId });
    }
  }
  return out;
}
