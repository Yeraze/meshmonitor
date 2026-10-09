/**
 * Auto-Acknowledge: wait, then stay quiet if enough others already answered.
 *
 * A channel message that matches Auto-Acknowledge is often matched by several
 * nodes at once, and each one tapbacks or replies. After the first couple the
 * extra answers tell the sender nothing and only cost airtime. So for a
 * CHANNEL message MeshMonitor waits a random 5-10 seconds, counts the nodes
 * that answered that message in the meantime, and sends nothing when the count
 * has reached `autoAckMaxResponses`.
 *
 * This only ever removes a send or delays it by seconds. It never adds a
 * packet, a retry or a later second try.
 *
 * Direct messages are left alone: nobody else can answer a DM sent to us.
 */

/** Lower bound of the random wait before a channel auto-ack (ms). */
export const AUTO_ACK_RESPONSE_WAIT_MIN_MS = 5_000;
/** Upper bound of the random wait before a channel auto-ack (ms). */
export const AUTO_ACK_RESPONSE_WAIT_MAX_MS = 10_000;

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
 */
export const AUTO_ACK_MAX_PENDING = 10;

/**
 * How long to wait before a channel auto-ack, in ms.
 *
 * Uniform over [5 s, 10 s] for `random` in [0, 1). When the user's Pre-Send
 * Delay is longer than 5 s it replaces the lower bound, so the wait is
 * [preSend, preSend + 5 s]: their minimum is kept, the 5 s of spread that
 * keeps two instances from answering at the same instant is kept, and nobody
 * waits twice.
 */
export function autoAckChannelWaitMs(preSendDelaySeconds: number, random: number): number {
  const r = Number.isFinite(random) ? Math.min(Math.max(random, 0), 1) : 0;
  const spread = AUTO_ACK_RESPONSE_WAIT_MAX_MS - AUTO_ACK_RESPONSE_WAIT_MIN_MS;
  const floor = Math.max(AUTO_ACK_RESPONSE_WAIT_MIN_MS, Math.max(0, preSendDelaySeconds) * 1000);
  return Math.round(floor + r * spread);
}
