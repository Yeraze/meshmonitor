/**
 * Shared support for the memoized message rows (`DmMessageRow`,
 * `ChannelMessageRow`).
 *
 * Every poll rebuilds the message list from fresh JSON, so each message is a
 * new object with new `Date`s even when nothing about it changed. A plain
 * `React.memo` would then redraw every row on every poll. The rows instead
 * compare their props by value (`messageRowPropsEqual`), and the parent keeps
 * its callbacks and name lookups stable (`useNodeNamesToken`), so a poll that
 * adds one message renders one row.
 */
import { useRef } from 'react';
import type { MeshMessage } from '../../types/message';
import { isEmoji } from '../../utils/text';
import { replyKeyOfMessageId } from '../../utils/messageReplies';

/**
 * Value equality for row props, `depth` levels deep: same primitive, same
 * `Date` time, arrays with equal items, or plain objects with equal fields.
 * Functions and class instances compare by identity.
 */
function looseEqual(a: unknown, b: unknown, depth: number): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (depth <= 0 || typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!looseEqual(a[i], b[i], depth - 1)) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const pa = Object.getPrototypeOf(a);
  if ((pa !== Object.prototype && pa !== null) || Object.getPrototypeOf(b) !== pa) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!looseEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], depth - 1)) return false;
  }
  return true;
}

/**
 * `React.memo` comparator for message rows. Deep enough for a prop that is
 * an array of messages (props → array → message → field).
 */
export function messageRowPropsEqual<P extends object>(prev: Readonly<P>, next: Readonly<P>): boolean {
  return looseEqual(prev, next, 3);
}

/**
 * A token that keeps its identity while every node's id, long name and short
 * name stay the same. The views' name lookups only read those three fields, so
 * a lookup memoized on this token stays stable across polls that change other
 * node fields (last heard, SNR, position…), and still changes on a rename.
 */
export function useNodeNamesToken(
  nodes: ReadonlyArray<{ user?: { id?: string; longName?: string; shortName?: string } | null }>
): object {
  const ref = useRef<{ names: Array<string | undefined>; token: object } | null>(null);
  const names: Array<string | undefined> = new Array(nodes.length * 3);
  for (let i = 0; i < nodes.length; i++) {
    const u = nodes[i].user;
    names[i * 3] = u?.id;
    names[i * 3 + 1] = u?.longName;
    names[i * 3 + 2] = u?.shortName;
  }
  const prev = ref.current;
  let same = !!prev && prev.names.length === names.length;
  if (same && prev) {
    for (let i = 0; i < names.length; i++) {
      if (prev.names[i] !== names[i]) { same = false; break; }
    }
  }
  if (!same || !prev) {
    ref.current = { names, token: {} };
  }
  return ref.current!.token;
}

/** Tapbacks under, and the quoted parent of, each message in one list. */
export interface ResponseIndex {
  /** Tapbacks on a parent, keyed by the parent's reply key, in list order. */
  tapbacksByParentKey: Map<string, MeshMessage[]>;
  /** The first message in the list with a given reply key. */
  firstByReplyKey: Map<string, MeshMessage>;
}

/**
 * One pass over a conversation, replacing the per-row `list.filter(isTapbackOf)`
 * and `list.find(isReplyTo)` scans (O(n²) per render). Gives the same answers
 * as `isTapbackOf` / `isReplyTo` in `utils/messageReplies`:
 * - a tapback is flagged `emoji === 1` or has emoji-only text, and its truthy
 *   `replyId` equals the parent's reply key;
 * - a reply quotes the FIRST message whose reply key equals its `replyId`.
 */
export function buildResponseIndex(list: readonly MeshMessage[]): ResponseIndex {
  const tapbacksByParentKey = new Map<string, MeshMessage[]>();
  const firstByReplyKey = new Map<string, MeshMessage>();
  for (const m of list) {
    const key = replyKeyOfMessageId(m.id);
    if (key !== undefined && !firstByReplyKey.has(key)) firstByReplyKey.set(key, m);
    if (m.replyId && (m.emoji === 1 || isEmoji(m.text ?? ''))) {
      const parentKey = m.replyId.toString();
      const arr = tapbacksByParentKey.get(parentKey);
      if (arr) arr.push(m);
      else tapbacksByParentKey.set(parentKey, [m]);
    }
  }
  return { tapbacksByParentKey, firstByReplyKey };
}

const NO_MESSAGES: MeshMessage[] = [];

/** Tapbacks shown under `msg` (same as `list.filter(m => isTapbackOf(m, msg))`). */
export function tapbacksFor(index: ResponseIndex, msg: MeshMessage): MeshMessage[] {
  const key = replyKeyOfMessageId(msg.id);
  return (key !== undefined && index.tapbacksByParentKey.get(key)) || NO_MESSAGES;
}

/**
 * The message `msg` quotes (same as `list.find(m => isReplyTo(msg, m))`).
 * The caller has already dropped tapbacks, which never quote.
 */
export function repliedMessageFor(index: ResponseIndex, msg: MeshMessage): MeshMessage | null {
  if (!msg.replyId) return null;
  return index.firstByReplyKey.get(msg.replyId.toString()) ?? null;
}

/** Same rule as the views' `isMyMessage` (#2584: spoofed rows are never ours). */
export function isOwnMessage(msg: MeshMessage, currentNodeId: string): boolean {
  if (msg.spoofSuspected) return false;
  return msg.from === currentNodeId || msg.isLocalMessage === true;
}
