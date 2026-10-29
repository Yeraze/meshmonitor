/**
 * Client side of the incremental `/api/poll` (see the server's
 * `services/pollDeltaTracker.ts`).
 *
 * The client keeps the last reply it merged for each poll URL (its "base",
 * kept apart from the query cache, which WebSocket events and optimistic
 * toggles patch locally) and the cursor that came with it. The next poll sends
 * that cursor; a delta reply is merged onto the base the request was sent
 * from. The merged reply equals what a full read would have returned, and
 * every node and section the delta did not touch is the same object as
 * before, so the query cache's structural sharing keeps their references and
 * a poll that changed nothing re-renders nothing.
 */
import type { PollData } from './usePoll';

/** The control keys a reply may carry next to its data sections. */
export interface PollReplyControl {
  pollCursor?: string;
  pollDelta?: boolean;
  removedNodes?: number[];
  nodeOrder?: number[];
  unchangedSections?: string[];
}

export type PollReply = PollData & PollReplyControl;

interface PollBase {
  cursor: string;
  data: PollData;
}

/** The last merged reply per poll URL (without the cursor query). */
const bases = new Map<string, PollBase>();
/** URLs held at most; the least recently used is dropped first. */
const MAX_BASES = 16;

/** The base to send a cursor from, or null for a full read. */
export function getPollBase(key: string): PollBase | null {
  return bases.get(key) ?? null;
}

export function setPollBase(key: string, cursor: string | undefined, data: PollData): void {
  bases.delete(key);
  if (!cursor) return;
  bases.set(key, { cursor, data });
  while (bases.size > MAX_BASES) bases.delete(bases.keys().next().value as string);
}

/** Forget every base (tests; a sign-out does not need it: cursors are per user). */
export function clearPollBases(): void {
  bases.clear();
}

/** Thrown when a delta does not fit the base it was asked against. */
export class PollDeltaMismatchError extends Error {}

/**
 * Merge one reply onto the base it was requested from. A full reply (no
 * `pollDelta`) is returned as is, without its control keys.
 */
export function mergePollReply(base: PollData | null, reply: PollReply): PollData {
  const { pollCursor: _c, pollDelta, removedNodes, nodeOrder, unchangedSections, ...data } = reply;
  if (!pollDelta) return data;
  if (!base) throw new PollDeltaMismatchError('delta reply without a base');

  const merged: PollData = { ...data };
  const baseRecord = base as Record<string, unknown>;
  const mergedRecord = merged as Record<string, unknown>;
  for (const name of unchangedSections ?? []) mergedRecord[name] = baseRecord[name];

  const changed = data.nodes ?? [];
  const removed = removedNodes ?? [];
  const baseNodes = base.nodes ?? [];
  if (changed.length === 0 && removed.length === 0 && !nodeOrder) {
    merged.nodes = base.nodes;
    return merged;
  }

  const changedByNum = new Map(changed.map((node) => [Number(node.nodeNum), node]));
  if (nodeOrder) {
    const baseByNum = new Map(baseNodes.map((node) => [Number(node.nodeNum), node]));
    merged.nodes = nodeOrder.map((nodeNum) => {
      const node = changedByNum.get(nodeNum) ?? baseByNum.get(nodeNum);
      if (!node) throw new PollDeltaMismatchError(`node ${nodeNum} is in the order but not held`);
      return node;
    });
    return merged;
  }

  // Same order: replace changed nodes in place, drop removed ones. A node
  // not already held would have changed the order, so it must not appear.
  const removedSet = new Set(removed);
  let replaced = 0;
  merged.nodes = baseNodes
    .filter((node) => !removedSet.has(Number(node.nodeNum)))
    .map((node) => {
      const next = changedByNum.get(Number(node.nodeNum));
      if (!next) return node;
      replaced++;
      return next;
    });
  if (replaced !== changedByNum.size) {
    throw new PollDeltaMismatchError('delta adds a node without sending the order');
  }
  return merged;
}
