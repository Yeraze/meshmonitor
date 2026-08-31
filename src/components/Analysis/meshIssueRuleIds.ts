/**
 * Canonical mesh-issue rule ids and the rule-mute settings-patch helper
 * (report reorg #4964 WP2 — spec §5.2, §9.5-§9.10).
 *
 * Mirrors the server's `MESH_ISSUE_TYPES` (`src/server/services/meshIssues/types.ts`)
 * WITHOUT importing it — the frontend never imports from `src/server/**`
 * (CLAUDE.md). Kept in step by hand; a mismatch here only means a stale
 * mute-list UI (an id `resolveThresholds` would drop on read anyway per its
 * clamp-never-reject doctrine), never a wire-format break.
 *
 * Deliberately self-contained rather than importing `ruleShortId`/`tierOf`
 * from `meshIssueTypes.ts` (owned by WP1, landing in parallel) — this file
 * only depends on `ISSUE_TYPE_LABELS`, a pre-existing, stable export that
 * predates this reorg.
 */
import { ISSUE_TYPE_LABELS } from './meshIssueTypes';

/** Canonical machine ids — mirrors the server's `MESH_ISSUE_TYPES` exactly. */
export const MESH_ISSUE_TYPE_IDS = {
  A1_DEPRECATED_ROLE: 'A1_deprecated_role',
  A2A_CHATTY_NODE: 'A2a_chatty_node',
  A2B_CONGESTED_AREA: 'A2b_congested_area',
  A2B_CONGESTED_NODE: 'A2b_congested_node',
  A3_INFRA_POWER: 'A3_infra_power',
  A4_MOBILE_INFRA: 'A4_mobile_infra',
  A5_COSPLAY_ROUTER: 'A5_cosplay_router',
  B1_ROUTER_CLUSTER: 'B1_router_cluster',
  B2_REDUNDANT_ROUTER: 'B2_redundant_router',
  B3_ASYMMETRIC_LINK: 'B3_asymmetric_link',
  B4_IDLE_ROUTER: 'B4_idle_router',
  B5_LOAD_BEARING_CLIENT: 'B5_load_bearing_client',
  B6_HOP_HORIZON: 'B6_hop_horizon',
  B7_COVERAGE_SHADOW: 'B7_coverage_shadow',
  C1_EXCESSIVE_PACKETS: 'C1_excessive_packets',
  C1_KEY_SECURITY: 'C1_key_security',
  C1_TIME_OFFSET: 'C1_time_offset',
  C2_OVER_BROADCASTING: 'C2_over_broadcasting',
} as const;

export type MeshIssueRuleId = typeof MESH_ISSUE_TYPE_IDS[keyof typeof MESH_ISSUE_TYPE_IDS];

/** Every rule id, in `MESH_ISSUE_TYPE_IDS` declaration order (== tier order). */
export const MESH_ISSUE_RULE_IDS: readonly MeshIssueRuleId[] = Object.values(MESH_ISSUE_TYPE_IDS);

/** `B7_coverage_shadow` -> `B7`. Same derivation the server's
 *  `meshIssuesAnalysisService.ts` uses for muted-rule `RuleSkip.rule`. */
export function ruleShortId(issueType: string): string {
  return issueType.split('_')[0];
}

/** `B7_coverage_shadow` -> `'B'`. The rule's tier letter, for grouping. */
export function tierOfRule(issueType: string): 'A' | 'B' | 'C' {
  const letter = ruleShortId(issueType).charAt(0);
  return letter === 'B' || letter === 'C' ? letter : 'A';
}

/** All 18 rule ids grouped by tier, each group in `MESH_ISSUE_RULE_IDS`
 *  order — the shape `MeshIssuesSection.tsx` renders as three groups. */
export function ruleIdsByTier(): Record<'A' | 'B' | 'C', MeshIssueRuleId[]> {
  const groups: Record<'A' | 'B' | 'C', MeshIssueRuleId[]> = { A: [], B: [], C: [] };
  for (const id of MESH_ISSUE_RULE_IDS) groups[tierOfRule(id)].push(id);
  return groups;
}

export { ISSUE_TYPE_LABELS };

/**
 * Builds the settings PATCH for a rule-mute change: the canonical CSV key
 * plus the legacy B7 boolean, always written together.
 *
 * TRAP (spec §5.2): the server's `resolveThresholds` ORs
 * `mesh_issues_b7_enabled === 'false'` into the resolved mute set for
 * installs that set it before `mesh_issues_disabled_rules` existed. Writing
 * only the CSV key would leave B7 muted forever whenever that legacy key
 * still says 'false' — un-muting B7 through the CSV alone does nothing.
 * Every write of the mute set MUST go through this helper so both keys move
 * together.
 */
export function buildRuleMuteSettingsPatch(disabledRuleIds: string[]): Record<string, string> {
  return {
    mesh_issues_disabled_rules: [...new Set(disabledRuleIds)].sort().join(','),
    // Keeps the legacy key from silently re-muting B7 (§5.2).
    mesh_issues_b7_enabled: String(!disabledRuleIds.includes(MESH_ISSUE_TYPE_IDS.B7_COVERAGE_SHADOW)),
  };
}
