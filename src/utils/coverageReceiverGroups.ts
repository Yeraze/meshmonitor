/**
 * Pure grouping/search/sort helpers for `CoverageReceiverFilter` (#5277
 * Phase 2 WP4, spec §2.9). Kept out of the `.tsx` component per the
 * react-refresh/only-export-components rule (CLAUDE.md ESLint ratchet) and
 * so the scaling behaviour (500+ receivers) is unit-testable without
 * mounting React.
 *
 * Receivers are keyed by `(sourceId, receiverId)` everywhere (carry-over a,
 * COVERAGE_P2_SPEC.md §5 D7) via `receiverKey` from
 * `src/utils/coverageReceiverFilter.ts` — the same composite key the wire
 * format and `CoverageMap` use.
 */
import { receiverKey } from './coverageReceiverFilter.js';
import type { CoverageReceiverDto } from '../types/coverage.js';

/** Per-group cap before the group collapses to "Show all N" (spec §2.9). */
export const RECEIVER_GROUP_CAP = 200;

export interface ReceiverGroup {
  sourceId: string;
  sourceName: string;
  /** Every receiver of this source that matches the current search, sorted
   *  by `receptionCount` descending. */
  receivers: CoverageReceiverDto[];
}

/** Tri-state a group's checkbox reflects, from the (composite-keyed)
 *  deselected set — used to drive the `indeterminate` DOM property. */
export type GroupSelectionState = 'all' | 'none' | 'partial';

/**
 * Groups receivers by `sourceId`, sorted within each group by
 * `receptionCount` descending (spec §2.9). Group order follows first
 * appearance in the input (server response order), which is stable across
 * renders since `receivers` comes from one query result.
 */
export function groupReceiversBySource(receivers: CoverageReceiverDto[]): ReceiverGroup[] {
  const order: string[] = [];
  const bySource = new Map<string, ReceiverGroup>();

  for (const r of receivers) {
    let group = bySource.get(r.sourceId);
    if (!group) {
      group = { sourceId: r.sourceId, sourceName: r.sourceName, receivers: [] };
      bySource.set(r.sourceId, group);
      order.push(r.sourceId);
    }
    group.receivers.push(r);
  }

  for (const group of bySource.values()) {
    group.receivers.sort((a, b) => b.receptionCount - a.receptionCount);
  }

  return order.map((id) => bySource.get(id) as ReceiverGroup);
}

/** Case-insensitive match against long name, short name, `!id`, and source name. */
export function matchesReceiverSearch(receiver: CoverageReceiverDto, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  const haystacks = [receiver.longName, receiver.shortName, receiver.receiverId, receiver.sourceName];
  return haystacks.some((h) => h != null && h.toLowerCase().includes(q));
}

/** Filters a group's receivers by the search query; drops groups left empty. */
export function filterReceiverGroups(groups: ReceiverGroup[], query: string): ReceiverGroup[] {
  const q = query.trim();
  if (q === '') return groups;
  return groups
    .map((g) => ({ ...g, receivers: g.receivers.filter((r) => matchesReceiverSearch(r, q)) }))
    .filter((g) => g.receivers.length > 0);
}

/** Tri-state selection of a group, from the composite-keyed deselected set. */
export function groupSelectionState(
  group: ReceiverGroup,
  deselected: ReadonlySet<string>,
): GroupSelectionState {
  if (group.receivers.length === 0) return 'none';
  let selectedCount = 0;
  for (const r of group.receivers) {
    if (!deselected.has(receiverKey(r.sourceId, r.receiverId))) selectedCount++;
  }
  if (selectedCount === 0) return 'none';
  if (selectedCount === group.receivers.length) return 'all';
  return 'partial';
}

/** `{ selected, total }` across every receiver (not just the searched/visible ones). */
export function receiverSelectionSummary(
  receivers: CoverageReceiverDto[],
  deselected: ReadonlySet<string>,
): { selected: number; total: number } {
  let selected = 0;
  for (const r of receivers) {
    if (!deselected.has(receiverKey(r.sourceId, r.receiverId))) selected++;
  }
  return { selected, total: receivers.length };
}
