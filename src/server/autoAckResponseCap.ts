/**
 * Auto-Acknowledge: wait, then stay quiet if enough others already answered.
 *
 * A channel message that matches Auto-Acknowledge is often matched by several
 * nodes at once, and each one tapbacks or replies. After the first couple the
 * extra answers tell the sender nothing and only cost airtime. So for a
 * CHANNEL message MeshMonitor waits a random 5-30 seconds, counts the nodes
 * that answered that message in the meantime, and sends nothing when the count
 * has reached `autoAckMaxResponses`.
 *
 * This only ever removes a send or delays it by seconds. It never adds a
 * packet, a retry or a later second try.
 *
 * Direct messages are left alone: nobody else can answer a DM sent to us.
 */

/**
 * Lower bound of the random wait before a channel auto-ack (ms). The floor is
 * what stops us answering before anyone else could have been heard: a reply
 * from another node needs seconds to cross a few hops.
 */
export const AUTO_ACK_RESPONSE_WAIT_MIN_MS = 5_000;
/**
 * Upper bound of the random wait (ms). 30 s, not 10: on a large or slow mesh
 * an answer takes many seconds to reach us, and the wider the spread, the
 * fewer instances finish their wait before hearing each other.
 */
export const AUTO_ACK_RESPONSE_WAIT_MAX_MS = 30_000;

export {
  AUTO_ACK_MAX_RESPONSES_DEFAULT,
  AUTO_ACK_MAX_RESPONSES_MAX,
  AUTO_ACK_MAX_RESPONSES_MIN,
  isValidAutoAckMaxResponses,
  resolveAutoAckMaxResponses,
} from '../utils/autoAckMaxResponses.js';

/**
 * Most channel auto-acks one source may hold waiting at a time. A burst of
 * matching messages past this is dropped, not queued: a late ack is worthless,
 * and N armed timers are N sends a few seconds later.
 *
 * Sized from the wait: slots = (matching messages per second we will serve) x
 * (longest wait, 30 s). 10 slots are full only when a NEW sender matches every
 * 3 s for a whole 30 s (every 1.75 s at the 17.5 s average wait). A LongFast
 * channel carrying text over a few hops cannot deliver distinct messages much
 * faster than that, so ordinary traffic never reaches it, while a flood is cut
 * to 10 responses per window. The source's send queue releases one packet per
 * 30 s, so more slots would only build a backlog of stale acks.
 *
 * A slot is always released when its timer fires or the source disconnects,
 * so a busy channel cannot hold the slots forever.
 */
export const AUTO_ACK_MAX_PENDING = 10;

/**
 * Extra wait per hop the triggering message travelled (ms), added to the lower
 * bound only (#5788). The instance that heard the sender over the fewest hops
 * has the best path back, so it should get the first chance to answer; the
 * farther ones are then more likely to hear that answer and stay quiet.
 *
 * Fixed, not a setting: the ordering only works when every instance uses the
 * same number. 3 s chosen by the maintainer.
 */
export const AUTO_ACK_HOP_PENALTY_MS = 3_000;
/**
 * Spread always left between the hop-raised floor and the ceiling (ms), so two
 * instances at the same distance still do not answer at the same instant.
 */
export const AUTO_ACK_MIN_SPREAD_MS = 2_000;
/** Largest hop count that counts. `hop_limit` is a 3-bit field. */
const MAX_HOPS = 7;

/**
 * How long to wait before a channel auto-ack, in ms.
 *
 * Uniform over [floor, ceiling] for `random` in [0, 1).
 *
 * - With no Pre-Send Delay the window is [5 s, 30 s]. When the user's Pre-Send
 *   Delay is longer than 5 s it replaces the lower bound, so the window is
 *   [preSend, preSend + 25 s]: their minimum is kept, the 25 s of spread that
 *   keeps instances from answering at the same instant is kept, and nobody
 *   waits twice.
 * - `hops` (how far the triggering message travelled to reach us; 0 = heard
 *   direct) raises the floor by 3 s per hop and leaves the ceiling alone:
 *   direct 5-30 s, 1 hop 8-30 s, 2 hops 11-30 s, 3 hops 14-30 s, 7 hops
 *   26-30 s. The floor never comes within 2 s of the ceiling. Unknown,
 *   negative or non-numeric hops count as 0 (no bias); more than 7 counts as 7.
 */
export function autoAckChannelWaitMs(preSendDelaySeconds: number, random: number, hops: number = 0): number {
  const r = Number.isFinite(random) ? Math.min(Math.max(random, 0), 1) : 0;
  const spread = AUTO_ACK_RESPONSE_WAIT_MAX_MS - AUTO_ACK_RESPONSE_WAIT_MIN_MS;
  const baseFloor = Math.max(AUTO_ACK_RESPONSE_WAIT_MIN_MS, Math.max(0, preSendDelaySeconds) * 1000);
  const ceiling = baseFloor + spread;
  const h = Number.isFinite(hops) ? Math.min(Math.max(Math.trunc(hops), 0), MAX_HOPS) : 0;
  const floor = Math.min(baseFloor + h * AUTO_ACK_HOP_PENALTY_MS, ceiling - AUTO_ACK_MIN_SPREAD_MS);
  return Math.round(floor + r * (ceiling - floor));
}
