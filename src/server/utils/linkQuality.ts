/**
 * Link Quality scoring (0-10), shared by the live Meshtastic manager and the
 * MeshCore read-side replay. Pure functions, no I/O.
 */

export const LINK_QUALITY = {
  /** Maximum quality score */
  MAX: 10,
  /** Minimum quality score (0 = dead link) */
  MIN: 0,
  /** Base value for initial calculation (LQ = BASE - hops) */
  INITIAL_BASE: 8,
  /** Default quality when hop count is unknown */
  DEFAULT_QUALITY: 5,
  /** Default hop count when unknown */
  DEFAULT_HOPS: 3,
  /** Bonus for stable/improved message delivery */
  STABLE_MESSAGE_BONUS: 1,
  /** Penalty for degraded routing (hops increased by 2+) */
  DEGRADED_PATH_PENALTY: -1,
  /** Penalty for failed traceroute */
  TRACEROUTE_FAIL_PENALTY: -2,
  /** Penalty for PKI/encryption error */
  PKI_ERROR_PENALTY: -5,
  /** Traceroute timeout in milliseconds (5 minutes) */
  TRACEROUTE_TIMEOUT_MS: 5 * 60 * 1000,
} as const;

export interface LinkQualityState {
  quality: number;
  lastHops: number;
}

/** Clamp a score to MIN..MAX. */
export function clampLinkQuality(q: number): number {
  return Math.max(LINK_QUALITY.MIN, Math.min(LINK_QUALITY.MAX, q));
}

/** Initial LQ = 8 - hops, clamped to 1..7. */
export function initialLinkQuality(hops: number): number {
  return Math.max(1, Math.min(LINK_QUALITY.INITIAL_BASE - 1, LINK_QUALITY.INITIAL_BASE - hops));
}

/** Score adjustment for a message that arrived over `hops` after `lastHops`. */
export function hopAdjustment(lastHops: number, hops: number): number {
  const diff = hops - lastHops;
  if (diff <= 0) return LINK_QUALITY.STABLE_MESSAGE_BONUS;
  if (diff === 1) return 0;
  return LINK_QUALITY.DEGRADED_PATH_PENALTY;
}

/**
 * Advance the state with one message. A null `state` initialises it first
 * (as the manager does on the first message from a node), then applies the step.
 */
export function nextLinkQuality(state: LinkQualityState | null, hops: number): LinkQualityState {
  const cur = state ?? { quality: initialLinkQuality(hops), lastHops: hops };
  return {
    quality: clampLinkQuality(cur.quality + hopAdjustment(cur.lastHops, hops)),
    lastHops: hops,
  };
}

/**
 * Replay ascending hop samples into quality points. Emits a point for the first
 * in-window sample and whenever the score then changes, from `emitFrom` (ms) on; samples
 * before it only warm the state up.
 */
export function replayLinkQuality(
  samples: Array<{ timestamp: number; value: number }>,
  emitFrom: number
): Array<{ timestamp: number; quality: number }> {
  const sorted = [...samples].sort((a, b) => a.timestamp - b.timestamp);
  const out: Array<{ timestamp: number; quality: number }> = [];
  let state: LinkQualityState | null = null;
  for (const s of sorted) {
    const prev: number | null = state ? state.quality : null;
    const init = state === null ? initialLinkQuality(s.value) : null;
    state = nextLinkQuality(state, s.value);
    if (s.timestamp < emitFrom) continue;
    if (init !== null && init !== state.quality) out.push({ timestamp: s.timestamp, quality: init });
    if (out.length === 0 || state.quality !== prev) out.push({ timestamp: s.timestamp, quality: state.quality });
  }
  return out;
}
