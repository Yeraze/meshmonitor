/**
 * Ordering for a MeshCore message's heard-repeaters list (#6000).
 *
 * Fewest hops first (the repeaters that heard the sender directly lead),
 * then strongest SNR. An entry with no hop count (rows written before
 * migration 218) sorts after every entry that has one; a missing SNR sorts
 * after a present one. Ties keep their input order.
 */
export interface HeardByOrderEntry {
  hops?: number | null;
  snr?: number | null;
}

/** Compare two optional numbers, missing values last; `dir` 1 = ascending, -1 = descending. */
function compareNullLast(a: number | null | undefined, b: number | null | undefined, dir: 1 | -1): number {
  const aOk = typeof a === 'number';
  const bOk = typeof b === 'number';
  if (aOk && bOk) return ((a as number) - (b as number)) * dir;
  if (aOk) return -1;
  if (bOk) return 1;
  return 0;
}

export function sortHeardBy<T extends HeardByOrderEntry>(entries: readonly T[]): T[] {
  return [...entries].sort((x, y) => compareNullLast(x.hops, y.hops, 1) || compareNullLast(x.snr, y.snr, -1));
}
