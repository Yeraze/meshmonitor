/**
 * Hop-count derivation for Unified Messages receptions (issue #5366).
 *
 * Separate module (not exported from the page component) so react-refresh
 * only-export-components stays clean and the edge cases are unit-testable.
 */

export interface ReceptionHopFields {
  hopStart: number | null;
  hopLimit: number | null;
  /**
   * Pre-decoded hop count. Set for MeshCore receptions, where the server has
   * already unpacked the wire `path_len` byte (bottom 6 bits); Meshtastic
   * receptions leave it unset and derive from hopStart - hopLimit.
   */
  hopCount?: number | null;
}

type TFn = (key: string, options?: Record<string, unknown>) => string;

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/**
 * Hops this reception travelled, or null when it cannot be known.
 *
 * - MeshCore: the decoded `hopCount` (0 = direct).
 * - Meshtastic (incl. MQTT): `hopStart - hopLimit`. A missing hopStart (old
 *   firmware) is unknown, NOT zero. hopLimit above hopStart is a corrupt pair
 *   and is also unknown rather than clamped to "direct".
 */
export function receptionHopCount(r: ReceptionHopFields): number | null {
  if (isCount(r.hopCount)) return Math.floor(r.hopCount);
  if (!isCount(r.hopStart) || !isCount(r.hopLimit)) return null;
  if (r.hopLimit > r.hopStart) return null;
  return r.hopStart - r.hopLimit;
}

/** Human text for a reception's hop count ("direct", "2 hops", …). */
export function hopDisplay(r: ReceptionHopFields, t: TFn): string {
  const hops = receptionHopCount(r);
  if (hops != null) {
    if (hops === 0) return t('unified.messages.hop_direct');
    return t(hops === 1 ? 'unified.messages.hop_count_one' : 'unified.messages.hop_count_other', { count: hops });
  }
  // Partial Meshtastic data: show what we have rather than a bare dash.
  if (r.hopStart != null && r.hopLimit == null) return t('unified.messages.hop_start_only', { value: r.hopStart });
  if (r.hopLimit != null && r.hopStart == null) return t('unified.messages.hop_limit_only', { value: r.hopLimit });
  return '—';
}
