/**
 * Shared domain types for the Mesh Issues Analysis epic (#4964, Phase 1
 * WP1). Kept dependency-free (no imports from `db/`) so the pure analysis
 * modules (WP2), the repository (WP1), and the frontend contract (WP5) can
 * all agree on shape without introducing an import-order dependency.
 */
import { djb2Hash } from '../../../utils/loraFrequency.js';

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
  // Tier B (RF adjacency graph, #4964 Phase 2 WP1). Values stay <= 64 chars —
  // `mesh_issues.issueType` is `varchar(64)` on MySQL.
  B1_ROUTER_CLUSTER: 'B1_router_cluster',
  B2_REDUNDANT_ROUTER: 'B2_redundant_router',
  B3_ASYMMETRIC_LINK: 'B3_asymmetric_link',
  B4_IDLE_ROUTER: 'B4_idle_router',
  B5_LOAD_BEARING_CLIENT: 'B5_load_bearing_client',
  B6_HOP_HORIZON: 'B6_hop_horizon',
  B7_COVERAGE_SHADOW: 'B7_coverage_shadow',
  // Tier C (#4964 Phase 3 WP2). Values stay <= 64 chars —
  // `mesh_issues.issueType` is `varchar(64)` on MySQL.
  C1_EXCESSIVE_PACKETS: 'C1_excessive_packets',
  C1_KEY_SECURITY: 'C1_key_security',
  C1_TIME_OFFSET: 'C1_time_offset',
  C2_OVER_BROADCASTING: 'C2_over_broadcasting',
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

/** `edge:${min}-${max}` — canonical subjectKey for an edge-attributed finding.
 *  Order-independent so a run that observes the pair in the other direction
 *  updates the same row. */
export function edgeSubjectKey(a: number, b: number): string {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return `edge:${lo}-${hi}`;
}

/**
 * `cluster:${size}:${djb2 hex}` over the sorted, deduped member list.
 *
 * Bounded to ~20 chars — `mesh_issues.subjectKey` is `varchar(128)` on MySQL,
 * so a raw member list is not an option. `size` is carried outside the hash so
 * two different-sized clusters can never collide on the 32-bit digest alone.
 *
 * STABILITY CONTRACT: the key is stable while membership is stable (sorting
 * makes it order-independent — the same member set produces the same key
 * regardless of the order findings were built in). A cluster that gains or
 * loses a member produces a NEW subjectKey; the old finding stops being
 * re-detected and auto-closes after AUTO_CLOSE_CLEAN_RUNS. That is the honest
 * behaviour — the old cluster genuinely no longer exists.
 */
export function clusterSubjectKey(members: number[]): string {
  const sorted = Array.from(new Set(members)).sort((a, b) => a - b);
  const hash = djb2Hash(sorted.join(','));
  return `cluster:${sorted.length}:${hash.toString(16)}`;
}
