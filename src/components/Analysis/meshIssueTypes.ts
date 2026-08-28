/**
 * Wire types for the /api/analysis/mesh-issues/* endpoints (#4964 Phase 1
 * WP5). Mirrors the frozen contract in MESH_ISSUES_P1_SPEC.md §2.16 — keep
 * in step with `src/server/routes/meshIssuesRoutes.ts` if that changes.
 *
 * Types-only sibling module next to the report (precedent: mqttViolationTypes.ts).
 */

export type MeshIssueSeverity = 'info' | 'warning' | 'critical';
export type MeshIssueConfidence = 'low' | 'medium' | 'high';
export type MeshIssueStatusValue = 'open' | 'closed';

/** One row from GET /api/analysis/mesh-issues. */
export interface MeshIssueRow {
  id: number;
  issueType: string;
  subjectKey: string;
  nodeNum: number | null;
  /** Resolved server-side: longName ?? shortName ?? `!hex`. */
  nodeName: string | null;
  severity: MeshIssueSeverity;
  confidence: MeshIssueConfidence;
  /** Parsed JSON; includes `recommendation`. */
  evidence: Record<string, unknown>;
  /** Intersected with the caller's permitted sources server-side. */
  sourceIds: string[];
  firstDetected: number;
  lastDetected: number;
  status: MeshIssueStatusValue;
}

export interface MeshIssueCounts {
  critical: number;
  warning: number;
  info: number;
  total: number;
}

export interface MeshIssuesResponse {
  issues: MeshIssueRow[];
  counts: MeshIssueCounts;
}

/** GET /api/analysis/mesh-issues/status. `lastRunResult` shape is server-internal;
 * the report only reads the fields below. */
export interface MeshIssuesStatus {
  running: boolean;
  inProgress: boolean;
  enabled: boolean;
  frequencyHours: number;
  lookbackHours: number;
  pairBucketHours: number;
  lastRunTime: number | null;
  lastRunResult: { findingCount?: number; durationMs?: number } | null;
}

/** POST /api/analysis/mesh-issues/run-now response payload (result object;
 * only the fields the report surfaces are typed here). */
export interface MeshIssuesRunNowResult {
  findingCount: number;
  newCount: number;
  reopenedCount: number;
  updatedCount: number;
  closedCount: number;
}

export const SEVERITY_ORDER: readonly MeshIssueSeverity[] = ['critical', 'warning', 'info'] as const;

export const ISSUE_TYPE_LABELS: Record<string, string> = {
  A1_deprecated_role: 'Deprecated role',
  A2a_chatty_node: 'Chatty node',
  A2b_congested_area: 'Congested area',
  A2b_congested_node: 'Congested node',
  A3_infra_power: 'Infrastructure node on failing power',
  A4_mobile_infra: 'Mobile infrastructure node',
  A5_cosplay_router: 'Router not advertised as unmessagable',
};

export const ISSUE_TYPE_BLURBS: Record<string, string> = {
  A1_deprecated_role: 'This node is running a role the firmware documentation now deprecates for new deployments.',
  A2a_chatty_node: "This node's airtime usage is high enough to affect the whole channel.",
  A2b_congested_area: 'Several nodes in this area are pushing channel utilization above the healthy ceiling.',
  A2b_congested_node: 'This node reports high channel utilization, but there are not yet enough neighbors nearby to call it an area problem.',
  A3_infra_power: 'An infrastructure-role node is resetting or deep-discharging on battery power.',
  A4_mobile_infra: 'A node running a routing role is moving, which routing roles assume it will not do.',
  A5_cosplay_router: 'A dedicated router role is not advertising itself as unmessagable.',
};

/**
 * Human label for an evidence object key. Generic camelCase -> Title Case
 * splitter; there is no per-rule override list to keep in sync as rules are
 * added in later phases.
 */
export function formatEvidenceKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
  return spaced;
}

/**
 * Human value for an evidence field. Numbers are rounded to at most 2
 * decimal places (integers render with none); arrays (e.g. `sources`) join
 * as a comma-separated list; booleans render Yes/No; null/undefined render
 * an em dash.
 */
export function formatEvidenceValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '—';
    if (Number.isInteger(value)) return String(value);
    return String(Math.round(value * 100) / 100);
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) {
    return value.length === 0 ? '—' : value.map((v) => String(v)).join(', ');
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
