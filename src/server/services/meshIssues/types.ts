/**
 * Shared domain types for the Mesh Issues Analysis epic (#4964, Phase 1
 * WP1). Kept dependency-free (no imports from `db/`) so the pure analysis
 * modules (WP2), the repository (WP1), and the frontend contract (WP5) can
 * all agree on shape without introducing an import-order dependency.
 */

export type MeshIssueSeverity = 'info' | 'warning' | 'critical';
export type MeshIssueConfidence = 'low' | 'medium' | 'high';
export type MeshIssueStatus = 'open' | 'closed';

/** Stable machine ids. UI labels live in the frontend types module (WP5). */
export const MESH_ISSUE_TYPES = {
  A1_DEPRECATED_ROLE: 'A1_deprecated_role',
  A2A_CHATTY_NODE: 'A2a_chatty_node',
  A2B_CONGESTED_AREA: 'A2b_congested_area',
  A2B_CONGESTED_NODE: 'A2b_congested_node',
  A3_INFRA_POWER: 'A3_infra_power',
  A4_MOBILE_INFRA: 'A4_mobile_infra',
  A5_COSPLAY_ROUTER: 'A5_cosplay_router',
} as const;
export type MeshIssueType = typeof MESH_ISSUE_TYPES[keyof typeof MESH_ISSUE_TYPES];

/** What a rule emits. No persistence fields — the repository owns those. */
export interface MeshIssueFinding {
  issueType: MeshIssueType;
  /** `node:${nodeNum}` or `area:${latBin}:${lonBin}` — see schema/meshIssues.ts. */
  subjectKey: string;
  nodeNum: number | null;
  severity: MeshIssueSeverity;
  confidence: MeshIssueConfidence;
  /** Serialized to JSON by the repository. Rule-specific shape. */
  evidence: Record<string, unknown>;
  /** Sources whose rows contributed evidence. Sorted, deduped. */
  sourceIds: string[];
  /** Human-readable action, official-guidance-compliant (never "promote to ROUTER"). */
  recommendation: string;
}

/** `node:${nodeNum}` — canonical subjectKey for a node-attributed finding. */
export const nodeSubjectKey = (nodeNum: number): string => `node:${nodeNum}`;

/** `area:${latBin}:${lonBin}` — canonical subjectKey for an area-attributed finding. */
export const areaSubjectKey = (latBin: number, lonBin: number): string =>
  `area:${latBin}:${lonBin}`;
