/**
 * MeshCore timestamp normalization (#4412 Phase 4).
 *
 * Three different MeshCore time fields, two different units:
 *   meshcore_nodes.lastHeard   epoch MILLISECONDS  (reconciled server-side by
 *                              meshcoreManager: prefer contact.lastSeen, else
 *                              lastAdvert * 1000 — see meshcoreManager.ts:459)
 *   MeshCoreContact.lastSeen   epoch MILLISECONDS
 *   MeshCoreContact.lastAdvert epoch SECONDS       (firmware `last_advert`)
 *
 * Meshtastic `nodes.lastHeard` is SECONDS. Do not mix the two — see
 * src/db/repositories/meshcore.ts:727-737.
 *
 * This module is the ONLY place MeshCore seconds become milliseconds. No
 * `* 1000` at any call site.
 */

/** Any row that can answer "when was this last heard?". All fields optional. */
export interface MeshCoreAgeSource {
  /** epoch ms — meshcore_nodes.lastHeard / MergedRow.lastHeard */
  lastHeard?: number | null;
  /** epoch ms — MeshCoreContact.lastSeen */
  lastSeen?: number | null;
  /** epoch s — MeshCoreContact.lastAdvert */
  lastAdvert?: number | null;
}

/**
 * A `lastAdvert` at or above this magnitude is already milliseconds, not
 * seconds (1e12 s ≈ year 33658 — unreachable as a real seconds value), so the
 * guard can only ever rescue a mislabelled ms value and never corrupts a
 * legitimate seconds one. Precedent: MeshCoreContactDetailPanel.tsx:904-905.
 */
const LAST_ADVERT_MS_THRESHOLD = 1e12;

/**
 * Resolve a row's last-heard instant in epoch MILLISECONDS, or null when the
 * row has never been heard.
 *
 * Precedence — lastHeard, then lastSeen, then lastAdvert — deliberately
 * matches meshcoreManager.ts:459-462 with `lastHeard` (the already-reconciled
 * DB value) prepended, so a MergedRow and a raw contact resolve identically.
 *
 * `0` is treated as "unknown" (falsy), matching useProcessedNodes' `!node.lastHeard`.
 */
export function meshcoreLastHeardMs(row: MeshCoreAgeSource): number | null {
  if (row.lastHeard != null && row.lastHeard !== 0) {
    return row.lastHeard;
  }
  if (row.lastSeen != null && row.lastSeen !== 0) {
    return row.lastSeen;
  }
  if (row.lastAdvert != null && row.lastAdvert !== 0) {
    return row.lastAdvert < LAST_ADVERT_MS_THRESHOLD
      ? row.lastAdvert * 1000
      : row.lastAdvert;
  }
  return null;
}

/** `nowMs - maxAgeHours * 3600_000`. `nowMs` injectable for fake-timer tests. */
export function meshcoreAgeCutoffMs(maxAgeHours: number, nowMs: number = Date.now()): number {
  return nowMs - maxAgeHours * 3600 * 1000;
}

/**
 * True when the row was heard at or after `cutoffMs`. A row with no
 * resolvable timestamp is FALSE — parity with useProcessedNodes.ts:195
 * (`if (!node.lastHeard) return false`). Callers apply their own favorite /
 * local-node exemptions BEFORE calling this, not inside it.
 */
export function isWithinMeshcoreAge(row: MeshCoreAgeSource, cutoffMs: number): boolean {
  const heardMs = meshcoreLastHeardMs(row);
  return heardMs != null && heardMs >= cutoffMs;
}
