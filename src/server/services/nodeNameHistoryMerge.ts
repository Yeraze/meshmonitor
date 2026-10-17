/**
 * Merge per-source rename rows into one timeline for Node Details (#5862).
 *
 * A node heard on several sources (TCP plus MQTT, say) is renamed once but
 * logged once per source. Rows naming the same old → new change within
 * `MERGE_WINDOW_MS` of each other are one rename: the entry keeps the earliest
 * time any source saw it and lists every source that did.
 */
import type { NodeNameHistoryRow } from '../../db/repositories/nodeNameHistory.js';

export const NAME_HISTORY_MERGE_WINDOW_MS = 10 * 60 * 1000;

export interface NodeNameHistoryEntry {
  oldLongName: string | null;
  newLongName: string | null;
  oldShortName: string | null;
  newShortName: string | null;
  /** Earliest time a source saw this rename, ms since epoch. */
  changedAt: number;
  sourceIds: string[];
}

function changeKey(row: Pick<NodeNameHistoryRow, 'oldLongName' | 'newLongName' | 'oldShortName' | 'newShortName'>): string {
  return JSON.stringify([row.oldLongName, row.newLongName, row.oldShortName, row.newShortName]);
}

/** Newest first in, newest first out. */
export function mergeNameHistory(
  rows: readonly NodeNameHistoryRow[],
  windowMs: number = NAME_HISTORY_MERGE_WINDOW_MS,
): NodeNameHistoryEntry[] {
  const oldestFirst = [...rows].sort((a, b) => a.changedAt - b.changedAt);
  const entries: NodeNameHistoryEntry[] = [];
  // The open entry for each distinct change, while later rows can still join it.
  const open = new Map<string, NodeNameHistoryEntry>();

  for (const row of oldestFirst) {
    const key = changeKey(row);
    const current = open.get(key);
    if (current && row.changedAt - current.changedAt <= windowMs) {
      if (!current.sourceIds.includes(row.sourceId)) current.sourceIds.push(row.sourceId);
      continue;
    }
    const entry: NodeNameHistoryEntry = {
      oldLongName: row.oldLongName,
      newLongName: row.newLongName,
      oldShortName: row.oldShortName,
      newShortName: row.newShortName,
      changedAt: row.changedAt,
      sourceIds: [row.sourceId],
    };
    entries.push(entry);
    open.set(key, entry);
  }

  return entries.reverse();
}
