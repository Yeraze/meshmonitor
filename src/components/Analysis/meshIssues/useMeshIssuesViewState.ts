/**
 * `useMeshIssuesViewState` — localStorage-backed persistence for the mesh
 * issues report's view state (#4964 report reorganization, WP3, spec §7.3).
 * Follows the established de-facto pattern (`PacketMonitorPanel.tsx`): a
 * local `safeJsonParse` guard, a lazy `useState` initializer, and a writer
 * `useEffect`, keyed `meshIssues.viewState.v1`.
 *
 * Read is fully defensive: a parse failure, a missing/mismatched `version`,
 * or a non-object returns the default state. Unknown issue types in
 * `sortByType`/`expandedTypes` are dropped on read (validated against
 * `ISSUE_TYPE_LABELS`'s keys — the frozen, WP1-owned set of 18 canonical
 * issue types) so a downgrade after a rule is added cannot poison the state.
 * Every write is `try/catch`-wrapped (Safari private mode).
 */
import { useEffect, useState } from 'react';
import { ISSUE_TYPE_LABELS, type MeshIssuesFilters } from '../meshIssueTypes';
import { DEFAULT_MESH_ISSUES_FILTERS } from './grouping';

export type MeshIssuesView = 'byIssue' | 'byNode';

export interface MeshIssuesSortState {
  key: string;
  dir: 'asc' | 'desc';
}

export interface MeshIssuesViewState {
  version: 1;
  view: MeshIssuesView;
  filters: MeshIssuesFilters;
  /** issueType -> {key, dir}. Absent means the type's primary column, desc. */
  sortByType: Record<string, MeshIssuesSortState>;
  expandedTypes: string[];
  expandedNodes: Array<number | 'mesh-wide'>;
}

const STORAGE_KEY = 'meshIssues.viewState.v1';

export const DEFAULT_MESH_ISSUES_VIEW_STATE: MeshIssuesViewState = {
  version: 1,
  view: 'byIssue',
  filters: DEFAULT_MESH_ISSUES_FILTERS,
  sortByType: {},
  expandedTypes: [],
  expandedNodes: [],
};

const VALID_ISSUE_TYPES: ReadonlySet<string> = new Set(Object.keys(ISSUE_TYPE_LABELS));
const SEVERITIES: ReadonlySet<string> = new Set(['critical', 'warning', 'info']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function safeJsonParse(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.warn('Failed to parse mesh issues view state from localStorage:', error);
    return null;
  }
}

function sanitizeStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function sanitizeFilters(raw: unknown): MeshIssuesFilters {
  if (!isPlainObject(raw)) return { ...DEFAULT_MESH_ISSUES_FILTERS };
  const f = raw;
  return {
    severities: Array.isArray(f.severities)
      ? (f.severities.filter((s): s is MeshIssuesFilters['severities'][number] => SEVERITIES.has(String(s))) as MeshIssuesFilters['severities'])
      : [],
    tiers: sanitizeStringArray(f.tiers),
    issueTypes: sanitizeStringArray(f.issueTypes).filter((t) => VALID_ISSUE_TYPES.has(t)),
    sources: sanitizeStringArray(f.sources),
    q: typeof f.q === 'string' ? f.q : '',
    includeClosed: f.includeClosed === true,
    includeDismissed: f.includeDismissed === true,
  };
}

function sanitizeSortByType(raw: unknown): Record<string, MeshIssuesSortState> {
  if (!isPlainObject(raw)) return {};
  const out: Record<string, MeshIssuesSortState> = {};
  for (const [type, value] of Object.entries(raw)) {
    if (!VALID_ISSUE_TYPES.has(type)) continue;
    if (!isPlainObject(value)) continue;
    if (typeof value.key !== 'string') continue;
    if (value.dir !== 'asc' && value.dir !== 'desc') continue;
    out[type] = { key: value.key, dir: value.dir };
  }
  return out;
}

function sanitizeExpandedTypes(raw: unknown): string[] {
  return sanitizeStringArray(raw).filter((t) => VALID_ISSUE_TYPES.has(t));
}

function sanitizeExpandedNodes(raw: unknown): Array<number | 'mesh-wide'> {
  if (!Array.isArray(raw)) return [];
  return raw.filter((n): n is number | 'mesh-wide' => n === 'mesh-wide' || typeof n === 'number');
}

/** Pure — exported for direct unit testing without touching `localStorage`. */
export function sanitizeViewState(raw: unknown): MeshIssuesViewState {
  if (!isPlainObject(raw)) return { ...DEFAULT_MESH_ISSUES_VIEW_STATE };
  if (raw.version !== 1) return { ...DEFAULT_MESH_ISSUES_VIEW_STATE };
  return {
    version: 1,
    view: raw.view === 'byNode' ? 'byNode' : 'byIssue',
    filters: sanitizeFilters(raw.filters),
    sortByType: sanitizeSortByType(raw.sortByType),
    expandedTypes: sanitizeExpandedTypes(raw.expandedTypes),
    expandedNodes: sanitizeExpandedNodes(raw.expandedNodes),
  };
}

function loadViewState(): MeshIssuesViewState {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (error) {
    console.warn('Failed to read mesh issues view state from localStorage:', error);
  }
  return sanitizeViewState(safeJsonParse(raw));
}

export function useMeshIssuesViewState() {
  const [viewState, setViewState] = useState<MeshIssuesViewState>(() => loadViewState());

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(viewState));
    } catch (error) {
      console.warn('Failed to persist mesh issues view state:', error);
    }
  }, [viewState]);

  return [viewState, setViewState] as const;
}
