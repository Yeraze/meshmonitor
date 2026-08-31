/**
 * Pure grouping/filtering/sorting helpers for the mesh-issues views (#4964
 * report reorganization, WP3, spec §6.2/§6.3/§8.4). No React, no network.
 *
 * `MeshIssuesFilters` and `tierOf` are WP1's frozen wire/shared types
 * (`meshIssueTypes.ts`, spec §9.4) — read from there, never redefined here.
 */
import {
  tierOf,
  type MeshIssueNodeSummary,
  type MeshIssueRow,
  type MeshIssuesFilters,
  type MeshIssueSeverity,
} from '../meshIssueTypes';

export const DEFAULT_MESH_ISSUES_FILTERS: MeshIssuesFilters = {
  severities: [],
  tiers: [],
  issueTypes: [],
  sources: [],
  q: '',
  includeClosed: false,
  includeDismissed: false,
};

/**
 * Filter predicate (spec §6.2/§10.1): each dimension applies independently;
 * an empty array on a given dimension means "no constraint" (matches
 * everything on that dimension). `q` matches `nodeName` or `subjectKey`,
 * case-insensitively (spec §12.4 — evidence-embedded names are NOT searched).
 * `MeshIssuesFilters` has no `nodeNum` facet (spec §9.4/§6.3): node scoping is
 * a direct per-node fetch parameter, not a filter this predicate applies.
 */
export function matchesFilters(row: MeshIssueRow, filters: MeshIssuesFilters): boolean {
  if (filters.severities.length > 0 && !filters.severities.includes(row.severity)) return false;
  if (filters.tiers.length > 0 && !filters.tiers.includes(tierOf(row.issueType))) return false;
  if (filters.issueTypes.length > 0 && !filters.issueTypes.includes(row.issueType)) return false;

  if (filters.sources.length > 0 && !row.sourceIds.some((id) => filters.sources.includes(id))) {
    return false;
  }

  const needle = filters.q.trim().toLowerCase();
  if (needle.length > 0) {
    const name = (row.nodeName ?? '').toLowerCase();
    const subject = row.subjectKey.toLowerCase();
    if (!name.includes(needle) && !subject.includes(needle)) return false;
  }

  if (!filters.includeClosed && row.status === 'closed') return false;
  if (!filters.includeDismissed && row.dismissed) return false;

  return true;
}

// ── Sort comparator (spec §8.4) ─────────────────────────────────────────

export type SortDirection = 'asc' | 'desc';

function compareSortValues(a: number | string | null, b: number | string | null, dir: SortDirection): number {
  // `null` sorts last in BOTH directions — never let the `dir` flip send it
  // to the top of an ascending sort.
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;

  const cmp = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b));
  return dir === 'asc' ? cmp : -cmp;
}

/**
 * Stable comparator for a table's rows. Ties on the primary `sortValue` fall
 * through to `lastDetected` desc, then `id` desc — mirroring the server's
 * `sortIssues` so a section's order is deterministic even when many rows
 * share the same sort value (spec §8.4).
 */
export function compareIssueRows(
  a: MeshIssueRow,
  b: MeshIssueRow,
  sortValue: (row: MeshIssueRow) => number | string | null,
  dir: SortDirection,
): number {
  const cmp = compareSortValues(sortValue(a), sortValue(b), dir);
  if (cmp !== 0) return cmp;
  if (a.lastDetected !== b.lastDetected) return b.lastDetected - a.lastDetected;
  return b.id - a.id;
}

// ── By-node grouping and ranking (spec §6.3) ────────────────────────────

const SEVERITY_RANK: Record<MeshIssueSeverity, number> = { critical: 0, warning: 1, info: 2 };

export interface NodeGroup {
  /** `null` == the Mesh-wide pseudo-group. */
  nodeNum: number | null;
  issues: MeshIssueRow[];
}

/**
 * Partitions findings by `nodeNum`. Every finding lands in exactly one
 * group — `nodeNum === null` findings (mesh-wide rules: `A2b_congested_area`,
 * `B1_router_cluster`, and `B3_asymmetric_link` when neither/both endpoints
 * are infra) form the single Mesh-wide pseudo-group rather than being
 * attached to member nodes (spec §6.3's partition property — required so
 * the node-scoped bulk action stays a partition too).
 */
export function groupByNode(issues: MeshIssueRow[]): NodeGroup[] {
  const map = new Map<number | null, MeshIssueRow[]>();
  for (const issue of issues) {
    const key = issue.nodeNum;
    const list = map.get(key);
    if (list) list.push(issue);
    else map.set(key, [issue]);
  }
  return Array.from(map.entries()).map(([nodeNum, groupIssues]) => ({ nodeNum, issues: groupIssues }));
}

function worstSeverityRank(issues: MeshIssueRow[]): number {
  return Math.min(...issues.map((i) => SEVERITY_RANK[i.severity]));
}

function latestDetected(issues: MeshIssueRow[]): number {
  return Math.max(...issues.map((i) => i.lastDetected));
}

/** Worst-first ranking (spec §6.3): the Mesh-wide group is always first,
 * regardless of its own severity/count; every other group ranks by
 * `worstSeverity` rank, then `total` desc, then `latestDetected` desc, then
 * `nodeNum` asc as a deterministic tiebreak. */
export function rankNodeGroups(groups: NodeGroup[]): NodeGroup[] {
  return [...groups].sort((a, b) => {
    if (a.nodeNum === null && b.nodeNum === null) return 0;
    if (a.nodeNum === null) return -1;
    if (b.nodeNum === null) return 1;

    const aWorst = worstSeverityRank(a.issues);
    const bWorst = worstSeverityRank(b.issues);
    if (aWorst !== bWorst) return aWorst - bWorst;

    if (a.issues.length !== b.issues.length) return b.issues.length - a.issues.length;

    const aLatest = latestDetected(a.issues);
    const bLatest = latestDetected(b.issues);
    if (aLatest !== bLatest) return bLatest - aLatest;

    return a.nodeNum - b.nodeNum;
  });
}

/** The worst severity present in a group of findings — drives a node row's
 * severity badge. */
export function worstSeverityOf(issues: MeshIssueRow[]): MeshIssueSeverity {
  let worst: MeshIssueSeverity = 'info';
  let worstRank = SEVERITY_RANK.info;
  for (const issue of issues) {
    const rank = SEVERITY_RANK[issue.severity];
    if (rank < worstRank) {
      worst = issue.severity;
      worstRank = rank;
    }
  }
  return worst;
}

/**
 * Same worst-first/Mesh-wide-pinned-first ranking as `rankNodeGroups`, but
 * applied directly to the `/summary` endpoint's `MeshIssueNodeSummary[]`
 * shape (#4964 report reorganization, WP5, spec §6.3) rather than to raw
 * `MeshIssueRow[]` grouped client-side. `buildSummary` (server) already
 * returns `byNode` in this order — `ByNodeView` re-sorts anyway so its
 * ordering is correct and independently testable regardless of the server's
 * own sort, mirroring `rankNodeGroups`'s comparator rule-for-rule so the two
 * can never drift apart.
 */
export function rankNodeSummaries(nodes: MeshIssueNodeSummary[]): MeshIssueNodeSummary[] {
  return [...nodes].sort((a, b) => {
    if (a.nodeNum === null && b.nodeNum === null) return 0;
    if (a.nodeNum === null) return -1;
    if (b.nodeNum === null) return 1;

    const aWorst = SEVERITY_RANK[a.worstSeverity];
    const bWorst = SEVERITY_RANK[b.worstSeverity];
    if (aWorst !== bWorst) return aWorst - bWorst;

    if (a.total !== b.total) return b.total - a.total;

    if (a.latestDetected !== b.latestDetected) return b.latestDetected - a.latestDetected;

    return a.nodeNum - b.nodeNum;
  });
}

/** Distinct issue types under a group, ordered worst-severity-first then
 * lexicographic (spec §4.3's `MeshIssueNodeSummary.issueTypes`) — drives the
 * badge row. */
export function issueTypesForGroup(issues: MeshIssueRow[]): string[] {
  const bestRankByType = new Map<string, number>();
  for (const issue of issues) {
    const rank = SEVERITY_RANK[issue.severity];
    const existing = bestRankByType.get(issue.issueType);
    if (existing === undefined || rank < existing) bestRankByType.set(issue.issueType, rank);
  }
  return Array.from(bestRankByType.entries())
    .sort(([typeA, rankA], [typeB, rankB]) => (rankA !== rankB ? rankA - rankB : typeA.localeCompare(typeB)))
    .map(([type]) => type);
}
