/**
 * "First Heard" stamping (#5390).
 *
 * `firstHeard` is the earliest reception a source recorded for a node. The
 * repositories stamp it once and never overwrite it. Each table keeps it in
 * the same unit as its own `lastHeard`:
 *
 *   - Meshtastic `nodes.firstHeard`       — Unix SECONDS
 *   - MeshCore `meshcore_nodes.firstHeard` — epoch MILLISECONDS
 *
 * A row can exist without ever being heard (a message that only references a
 * node, a contact-URL import, a MeshCore contact never heard on air), which is
 * why `createdAt` is not used: `firstHeard` follows `lastHeard`, the column
 * every reception path already writes.
 */
import { isPlausibleMeshCoreTimeMs } from './meshcoreTimestamp.js';

export type HeardUnit = 's' | 'ms';

function toFinite(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Whether a `lastHeard`-style value (in `unit`) is plausible as a real
 * reception time: after 2020-01-01 and no more than a day past `nowMs`.
 * Rejects the seconds-since-boot values of unsynced clocks and drifted RTCs.
 */
export function isPlausibleHeardTime(v: unknown, unit: HeardUnit, nowMs: number = Date.now()): boolean {
  const n = toFinite(v);
  if (n === null) return false;
  return isPlausibleMeshCoreTimeMs(unit === 's' ? n * 1000 : n, nowMs);
}

/**
 * The `firstHeard` value a write should store, or `undefined` to leave the
 * column alone.
 *
 * - An already-stamped row is never changed.
 * - Otherwise take the earliest plausible of the row's stored `lastHeard`
 *   (evidence from before this column existed, or a restored backup) and the
 *   incoming `lastHeard`.
 * - With neither plausible, leave it unset: a later reception stamps it.
 */
export function resolveFirstHeard(
  existingFirstHeard: unknown,
  existingLastHeard: unknown,
  incomingLastHeard: unknown,
  unit: HeardUnit,
  nowMs: number = Date.now(),
): number | undefined {
  if (toFinite(existingFirstHeard) !== null) return undefined;
  const candidates = [existingLastHeard, incomingLastHeard]
    .filter((v) => isPlausibleHeardTime(v, unit, nowMs))
    .map((v) => Math.floor(Number(v)));
  if (candidates.length === 0) return undefined;
  return Math.min(...candidates);
}
