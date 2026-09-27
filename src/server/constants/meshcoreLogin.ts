/**
 * MeshCore remote-login timing (#5400).
 *
 * One place for every number that shapes a login to a remote Repeater /
 * Room Server, so the admin console, room-server login, saved-credential
 * login before read commands, and the room-sync scheduler all behave alike.
 *
 * Why the wait is longer than meshcore.js's own: its `login()` gives up at
 * the firmware's Sent `estTimeout` + 1 s. A reply from a node several hops
 * out routinely lands after that, so every attempt "timed out" and a retry
 * just repeated the same miss. We now wait max(estTimeout × 2, 10 s).
 *
 * A longer wait costs no airtime: it only keeps listening for a reply that
 * is already on its way.
 */

/** Login packets sent per user action before giving up (retry on silence only). */
export const MESHCORE_LOGIN_MAX_ATTEMPTS = 3;

/** Pause between a silent attempt and the next one. */
export const MESHCORE_LOGIN_RETRY_PAUSE_MS = 2000;

/** Per-attempt reply wait = estTimeout × this … */
export const MESHCORE_LOGIN_REPLY_WAIT_MULTIPLIER = 2;

/** … but never less than this. */
export const MESHCORE_LOGIN_REPLY_WAIT_FLOOR_MS = 10_000;

/**
 * Sanity ceiling on the per-attempt wait. Only guards against a garbage
 * `estTimeout` in a Sent frame; real firmware estimates sit far below it.
 */
export const MESHCORE_LOGIN_REPLY_WAIT_CEILING_MS = 90_000;

/**
 * How long to wait for the companion's local Sent ack (serial/TCP, no RF)
 * before the reply wait even starts. Without it a lost Sent frame would
 * leave the attempt listening forever.
 */
export const MESHCORE_LOGIN_SENT_ACK_TIMEOUT_MS = 10_000;

/** Per-attempt reply wait for a firmware `estTimeout` (ms). */
export function meshcoreLoginReplyWaitMs(estTimeoutMs: unknown): number {
  const est = typeof estTimeoutMs === 'number' && Number.isFinite(estTimeoutMs) && estTimeoutMs > 0
    ? estTimeoutMs
    : 0;
  const wait = Math.max(est * MESHCORE_LOGIN_REPLY_WAIT_MULTIPLIER, MESHCORE_LOGIN_REPLY_WAIT_FLOOR_MS);
  return Math.min(wait, MESHCORE_LOGIN_REPLY_WAIT_CEILING_MS);
}

/**
 * Outer timeout for one `login` bridge command. Must exceed the longest
 * attempt the backend can run (Sent ack + ceiling wait), so the backend's
 * own deadline always fires first and cleans up its listeners.
 */
export const MESHCORE_LOGIN_BRIDGE_TIMEOUT_MS =
  MESHCORE_LOGIN_SENT_ACK_TIMEOUT_MS + MESHCORE_LOGIN_REPLY_WAIT_CEILING_MS + 5_000;

/** Error string the backend raises when a login is cancelled mid-attempt. */
export const MESHCORE_LOGIN_CANCELLED = 'MESHCORE_LOGIN_CANCELLED';
