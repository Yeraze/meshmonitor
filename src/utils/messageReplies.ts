/**
 * Which message answers which: the ONE rule for "B is a tapback on A" and
 * "B is a reply to A".
 *
 * Two callers share it and must not drift:
 *  - the Meshtastic channel and DM views (`ChannelsTab`, `MessagesTab`), which
 *    hang tapbacks under a message and quote the parent above a reply;
 *  - the server's Auto-Acknowledge response cap, which counts the tapbacks and
 *    replies other nodes have already made to a trigger before it answers.
 *
 * Pure and browser-safe: every function reads two plain message records and
 * nothing else. Each caller does its own lookup (the views search the loaded
 * conversation; the server asks the database for rows on the same source and
 * channel) and then asks these functions.
 *
 * The rule was lifted out of the views unchanged, quirks included:
 *  - The parent is matched on the LAST `_` segment of its row id
 *    (`${sourceId}_${fromNum}_${packetId}`), compared as a string with the
 *    child's `replyId`. A row whose id does not end in its packet id (the
 *    `_dbchan` / `_radio` copies of a server-decrypted message) never matches.
 *  - A tapback is a row flagged `emoji === 1`, OR a row whose whole text is
 *    emoji. A reply whose text is a lone emoji is therefore a tapback even
 *    without the flag.
 *  - Attaching to a parent needs a truthy `replyId`: absent, null and 0 all
 *    mean "answers nothing". (The server already stores a wire `reply_id` of 0
 *    as absent.)
 *  - Nothing here checks channel, source or sender. The views get that from the
 *    list they search; the server query does the same job.
 */
import { isEmoji } from './text.js';

/** The fields of a message that can answer another. */
export interface ResponseCandidate {
  text?: string | null;
  emoji?: number | null;
  replyId?: number | null;
}

/** The message being answered. Only its row id matters. */
export interface ResponseParent {
  id: string;
}

/**
 * The packet-id part of a message row id: its last `_` segment. This is the
 * value a child's `replyId` must equal.
 */
export function replyKeyOfMessageId(rowId: string): string | undefined {
  return rowId.split('_').pop();
}

/**
 * True when the views hide this message from the list because it is a
 * tapback: flagged as one, or answering something with emoji-only text.
 */
export function isTapbackMessage(msg: ResponseCandidate): boolean {
  return msg.emoji === 1 || (msg.replyId != null && isEmoji(msg.text ?? ''));
}

/** True when `candidate.replyId` points at `parent`. */
function pointsAt(candidate: ResponseCandidate, parent: ResponseParent): boolean {
  if (!candidate.replyId) return false;
  return candidate.replyId.toString() === replyKeyOfMessageId(parent.id);
}

/** True when the views show `candidate` as a tapback under `parent`. */
export function isTapbackOf(candidate: ResponseCandidate, parent: ResponseParent): boolean {
  return (candidate.emoji === 1 || isEmoji(candidate.text ?? '')) && pointsAt(candidate, parent);
}

/** True when the views show `candidate` as a reply quoting `parent`. */
export function isReplyTo(candidate: ResponseCandidate, parent: ResponseParent): boolean {
  return !isTapbackMessage(candidate) && pointsAt(candidate, parent);
}

/** A tapback on `parent` or a reply to it. */
export function isResponseTo(candidate: ResponseCandidate, parent: ResponseParent): boolean {
  return isTapbackOf(candidate, parent) || isReplyTo(candidate, parent);
}

/** A candidate with the node that sent it. */
export interface ResponseRow extends ResponseCandidate {
  fromNodeNum: number | string;
}

/**
 * How many distinct nodes have answered `parent` (tapback, reply or both — a
 * node that sends both is one), leaving out the nodes in `excludeNodeNums`.
 */
export function countDistinctResponders(
  parent: ResponseParent,
  rows: readonly ResponseRow[],
  excludeNodeNums: ReadonlyArray<number | null | undefined> = [],
): number {
  const excluded = new Set<number>();
  for (const n of excludeNodeNums) {
    if (n != null) excluded.add(Number(n));
  }
  const responders = new Set<number>();
  for (const row of rows) {
    const from = Number(row.fromNodeNum);
    if (excluded.has(from)) continue;
    if (isResponseTo(row, parent)) responders.add(from);
  }
  return responders.size;
}
