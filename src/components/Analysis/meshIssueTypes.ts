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
  /** #4964 Phase 3 WP3 — dismiss/restore. */
  dismissed: boolean;
  dismissedAt: number | null;
}

export interface MeshIssueCounts {
  critical: number;
  warning: number;
  info: number;
  total: number;
  /** Count of RETURNED rows with `dismissed === true` (Phase 3 WP3, spec §4.1). */
  dismissed: number;
}

export interface MeshIssuesResponse {
  /** One PAGE of the full filtered set — `sortIssues(fullSet).slice(offset,
   *  offset + limit)` server-side. Use `total`/`counts` for full-set totals,
   *  not `issues.length` (#4964 post-epic follow-ups: wire-level pagination). */
  issues: MeshIssueRow[];
  /** Computed over the FULL filtered (post-permission) set, not the page. */
  counts: MeshIssueCounts;
  /** Permitted-source id -> display name (Phase 3 WP3, spec §4.1). Only
   *  sources the caller can read appear here. */
  sourceNames: Record<string, string>;
  /** Size of the full filtered set — equals `counts.total`. Compare against
   *  `issues.length` to know whether more pages remain. */
  total: number;
  /** The `limit` actually applied (after clamping to [50, 2000]). */
  limit: number;
  /** The `offset` actually applied (floored at 0). */
  offset: number;
}

/** RF-evidence availability flags (Phase 2/3, `rfGraph.ts`'s `RfEvidenceAvailability`). */
export interface MeshIssuesEvidenceAvailability {
  neighborInfo: boolean;
  traceroute: boolean;
  mqttGateway: boolean;
  packetLog: boolean;
  /**
   * Whether an MQTT source exists at all (#4964 post-epic follow-ups —
   * frozen contract). Distinct from `mqttGateway`: a mesh can have an MQTT
   * source configured but producing no usable gateway evidence (e.g. the
   * packet log is off), or no MQTT source at all — those are different
   * situations for the "enable MQTT packet log" hint below. Optional/absent
   * on older stored `lastRunResult` summaries persisted before this field
   * existed (see `coverageNotes`'s gating).
   */
  mqttSourceConfigured?: boolean;
}

/** A rule the run skipped entirely, and why (`rulesTierB.ts`'s `RuleSkip`). */
export interface MeshIssueRuleSkip {
  rule: string;
  reason: string;
}

/** Phase 2/3 RF-evidence coverage summary (`meshIssuesAnalysisService.ts`'s `MeshIssuesCoverage`). */
export interface MeshIssuesCoverageWire {
  evidence: MeshIssuesEvidenceAvailability;
  neighborInfoRowCount: number;
  neighborInfoEdgeCount: number;
  tracerouteEdgeCount: number;
  tracerouteSentinelHopsDropped: number;
  gatewayCount: number;
  gatewayDirectEdgeCount: number;
  gatewayCoReceptionEdgeCount: number;
  gatewayCellsSkipped: number;
  directEdgeCount: number;
  totalEdgeCount: number;
  graphNodeCount: number;
  snrDirectionsWithMinSamples: number;
  /** Which log actually fed B6, or null when neither was usable. */
  hopHorizonSource: 'packet_log' | 'mqtt_packet_log' | null;
  hopHorizonNodeCount: number;
  skippedRules: MeshIssueRuleSkip[];
}

/** Traceroute corpus funnel (`tracerouteCorpus.ts`'s `TracerouteCorpusStats`). */
export interface MeshIssuesCorpusStats {
  rawCount: number;
  validCount: number;
  dedupedCount: number;
  sampledCount: number;
  distinctPairCount: number;
  /** True when the caller stopped paginating at the page cap. */
  truncated: boolean;
}

/** The subset of thresholds a user can tune (`thresholds.ts`'s `ResolvedMeshIssueThresholds`). */
export interface ResolvedMeshIssueThresholds {
  tierAEnabled: boolean;
  tierBEnabled: boolean;
  tierCEnabled: boolean;
  /** @deprecated legacy; folded into `disabledRules` (spec §5.2). Kept on the
   *  wire so existing consumers/tests do not break. */
  b7Enabled: boolean;
  airUtilTxPct: number;
  channelUtilPct: number;
  mobileSpanMeters: number;
  snrAsymmetryDb: number;
  overBroadcastSeconds: number;
  /** count, #4964 post-epic follow-ups. How many consecutive clean analysis
   *  runs a finding survives before it auto-closes. Mirrors the server's
   *  `ResolvedMeshIssueThresholds.autoCloseCleanRuns` (`thresholds.ts`) — WP5
   *  wire-type gap fix: this field existed server-side and in
   *  `MeshIssuesSection.tsx`'s locally-declared mirror but was missing here,
   *  which `MuteRuleDialog` needs for its auto-close copy (spec §6.4). */
  autoCloseCleanRuns: number;
  /** km, B1/B6 cluster-adjacency distance guard (#4976). */
  routerClusterMaxLinkKm: number;
  /** Resolved, validated, sorted `mesh_issues_disabled_rules` (#4964 report
   *  reorg, spec §4.5/§5.2). Unknown ids dropped. */
  disabledRules: string[];
}

/** The last completed run's summary (`meshIssuesAnalysisService.ts`'s `MeshIssuesRunResult`). */
export interface MeshIssuesLastRunResult {
  durationMs: number;
  sourceCount: number;
  nodeCount: number;
  findingCount: number;
  newCount: number;
  reopenedCount: number;
  updatedCount: number;
  closedCount: number;
  byType: Record<string, number>;
  corpusStats: MeshIssuesCorpusStats;
  coverage: MeshIssuesCoverageWire;
  /** issueType -> findings CREATED by the last run (#4964 report reorg,
   *  spec §4.6). Optional: absent on summaries persisted before this field
   *  existed — same doctrine as `mqttSourceConfigured`. Absent means the
   *  dashboard renders no "new this run" chip rather than a zero. */
  newByType?: Record<string, number>;
  /** issueType -> findings REOPENED by the last run. Same optionality. */
  reopenedByType?: Record<string, number>;
}

/** GET /api/analysis/mesh-issues/status. */
export interface MeshIssuesStatus {
  running: boolean;
  inProgress: boolean;
  enabled: boolean;
  frequencyHours: number;
  lookbackHours: number;
  pairBucketHours: number;
  lastRunTime: number | null;
  lastRunResult: MeshIssuesLastRunResult | null;
  /** Resolved + clamped thresholds actually in force for the next run. */
  thresholds: ResolvedMeshIssueThresholds;
  /** True when `lastRunResult` was recovered from settings (a process
   *  restart cleared the in-memory cache) rather than served from memory. */
  lastRunResultFromStorage: boolean;
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

// ── Summary dashboard + bulk mutation wire types (#4964 report reorg, spec §4.3/§4.4) ──

/** One tile in the by-type summary dashboard. Never carries `evidence`. */
export interface MeshIssueTypeSummary {
  issueType: string;
  total: number;
  bySeverity: { critical: number; warning: number; info: number };
  /** Highest severity present. `null` only if total === 0 (never emitted). */
  worstSeverity: MeshIssueSeverity;
  dismissed: number;
  /** Newest `lastDetected` across this type's findings. */
  latestDetected: number;
}

/** One row in the by-node summary view. Never carries `evidence`. */
export interface MeshIssueNodeSummary {
  /** `null` == the Mesh-wide pseudo-group (spec §6.3). */
  nodeNum: number | null;
  /** `longName ?? shortName ?? !hex`; `null` for the Mesh-wide group. */
  nodeName: string | null;
  total: number;
  bySeverity: { critical: number; warning: number; info: number };
  worstSeverity: MeshIssueSeverity;
  /** Distinct issue types under this node, ordered worst-severity-first then
   *  lexicographic. Drives the badge row. */
  issueTypes: string[];
  latestDetected: number;
}

/** GET /api/analysis/mesh-issues/summary response. */
export interface MeshIssuesSummary {
  byType: MeshIssueTypeSummary[];
  byNode: MeshIssueNodeSummary[];
  counts: MeshIssueCounts;
  total: number;
  sourceNames: Record<string, string>;
}

/** Body of POST /api/analysis/mesh-issues/bulk/{dismiss,restore} (spec §4.4). */
export type MeshIssueBulkScope =
  | { scope: 'issueType'; issueType: string }
  /** `nodeNum: null` == the Mesh-wide group. */
  | { scope: 'node'; nodeNum: number | null };

/** Response of the bulk dismiss/restore endpoints. Deliberately carries no
 *  `skipped` count — see spec §4.4 / §12.2 (a skipped count would disclose
 *  findings the caller cannot read, the #3745 leak class). */
export interface MeshIssuesBulkResult {
  affected: number;
}

/** Client-side filter state shared by the By-issue and By-node views (spec
 *  §4.1, §6.1). An empty array means "no constraint" on that dimension.
 *  `nodeNum` is deliberately NOT a member here: it is not a general filter
 *  facet, only a direct per-node fetch parameter the By-node view uses when
 *  expanding one node (spec §6.3). */
export interface MeshIssuesFilters {
  severities: MeshIssueSeverity[];
  /** 'A' | 'B' | 'C', matched against `tierOf(issueType)`. */
  tiers: string[];
  issueTypes: string[];
  sources: string[];
  /** Substring match against `nodeName` or `subjectKey`, case-insensitive. */
  q: string;
  includeClosed: boolean;
  includeDismissed: boolean;
}

/** `issueType.split('_')[0]` -> 'A1', 'A2a', 'A2b', 'B3', 'C1', 'C2' (spec §6.2). */
export function ruleShortId(issueType: string): string {
  return issueType.split('_')[0];
}

/** First character of `issueType` -> the 'A' | 'B' | 'C' tier used by the
 *  `tier` filter param (spec §4.1). */
export function tierOf(issueType: string): string {
  return issueType.charAt(0);
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
  B1_router_cluster: 'Router cluster',
  B2_redundant_router: 'Redundant router',
  B3_asymmetric_link: 'Asymmetric link',
  B4_idle_router: 'Idle router',
  B5_load_bearing_client: 'Load-bearing client',
  B6_hop_horizon: 'At the hop horizon',
  B7_coverage_shadow: 'Coverage shadow',
  // Tier C (#4964 Phase 3 WP4).
  C1_excessive_packets: 'Excessive packet rate',
  C1_key_security: 'Key security issue',
  C1_time_offset: 'Clock offset',
  C2_over_broadcasting: 'Broadcasting too often',
};

export const ISSUE_TYPE_BLURBS: Record<string, string> = {
  A1_deprecated_role: 'This node is running a role the firmware documentation now deprecates for new deployments.',
  A2a_chatty_node: "This node's airtime usage is high enough to affect the whole channel.",
  A2b_congested_area: 'Several nodes in this area are pushing channel utilization above the healthy ceiling.',
  A2b_congested_node: 'This node reports high channel utilization, but there are not yet enough neighbors nearby to call it an area problem.',
  A3_infra_power: 'An infrastructure-role node is resetting or deep-discharging on battery power.',
  A4_mobile_infra: 'A node running a routing role is moving, which routing roles assume it will not do.',
  A5_cosplay_router: 'A dedicated router role is not advertising itself as unmessagable.',
  B1_router_cluster: 'Several routers in one spot hear each other, so each one re-floods the same packets.',
  B2_redundant_router: 'This router reaches almost the same neighbours as another one nearby.',
  B3_asymmetric_link: 'One end of this link hears the other far better than the reverse.',
  B4_idle_router: 'This router is heard directly but carries almost none of its area’s traffic.',
  B5_load_bearing_client: 'A client node is carrying a large share of the paths through its area.',
  B6_hop_horizon: 'Traffic from this node arrives with no hops left, so nodes further out cannot hear it.',
  B7_coverage_shadow: 'This node only reaches us over MQTT despite sitting inside a router’s demonstrated RF range.',
  C1_excessive_packets: 'This node is putting more packets on the channel than the mesh can comfortably absorb.',
  C1_key_security: "This node's public key looks weak, duplicated, or mismatched, which undermines its encryption.",
  C1_time_offset: "This node's reported clock has drifted from the rest of the mesh.",
  C2_over_broadcasting: 'This node is sending position or telemetry updates far more often than the mesh needs.',
};

/** A node reference embedded in evidence (cluster members, shared neighbours). */
export interface EvidenceNodeRef {
  nodeNum: number;
  name?: string | null;
  role?: number | null;
  roleName?: string | null;
  directDegree?: number | null;
  /** Effective position at analysis time (#4974). Absent on rows persisted
   *  before the field existed; null when the node has no usable position. */
  latitude?: number | null;
  longitude?: number | null;
}

/**
 * Runtime guard for `EvidenceNodeRef[]` — evidence is parsed JSON from the
 * database, so shape is never guaranteed. Only requires a numeric `nodeNum`;
 * the remaining fields are optional in the interface and are simply absent
 * on some shapes (e.g. B2's `otherCoveringRouters`).
 */
export function isEvidenceNodeRefArray(v: unknown): v is EvidenceNodeRef[] {
  return (
    Array.isArray(v) &&
    v.every(
      (item) =>
        item !== null && typeof item === 'object' && typeof (item as Record<string, unknown>).nodeNum === 'number',
    )
  );
}

export interface EvidenceDirectionalSnr {
  count: number;
  meanDb: number | null;
  minDb: number | null;
  maxDb: number | null;
}

/** Runtime guard for `EvidenceDirectionalSnr` — same defensive rationale as
 * `isEvidenceNodeRefArray`. */
export function isEvidenceDirectionalSnr(v: unknown): v is EvidenceDirectionalSnr {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.count === 'number' &&
    (o.meanDb === null || typeof o.meanDb === 'number') &&
    (o.minDb === null || typeof o.minDb === 'number') &&
    (o.maxDb === null || typeof o.maxDb === 'number')
  );
}

/** `-7.5 dB (n=6)`, or an em dash when there is no usable mean. */
export function formatSnrDirection(v: EvidenceDirectionalSnr): string {
  if (v.meanDb == null) return '—';
  const rounded = Math.round(v.meanDb * 10) / 10;
  return `${rounded} dB (n=${v.count})`;
}

/** `!hex` fallback for a node with no name in evidence. Mirrors the server
 * helper (`displayName` in `rulesTierB.ts`). */
export function hexNodeId(nodeNum: number): string {
  return `!${(nodeNum >>> 0).toString(16).padStart(8, '0')}`;
}

/** Evidence keys rendered by dedicated components (`MemberList`/`SnrDirections`
 * in `MeshIssuesReport.tsx`), excluded from the generic evidence-pill grid. */
export const STRUCTURED_EVIDENCE_KEYS: ReadonlySet<string> = new Set([
  'members',
  'edges',
  'sharedNeighbors',
  'otherCoveringRouters',
  'clusterMembers',
  'nodeA',
  'nodeB',
  'snrToA',
  'snrToB',
  // Folded into the SnrDirections table as a "weaker" row tag rather than
  // rendered as its own raw `a->b` pill (#4964 Phase 3 WP4, spec §5.5).
  'weakerDirection',
]);

/** Evidence keys ending in this suffix hold an elapsed-milliseconds duration
 * (e.g. `lastHeardAgeMs`) and render through `formatDurationMs`, not
 * `formatEvidenceValue` (spec §5.3). */
const AGE_MS_KEY_PATTERN = /AgeMs$/;

/**
 * Human label for an evidence object key. Generic camelCase -> Title Case
 * splitter; there is no per-rule override list to keep in sync as rules are
 * added in later phases. A key matching `/AgeMs$/` drops the trailing "Ms"
 * before splitting, since `formatDurationMs` already renders a unit
 * ("Last Heard Age" reads better than "Last Heard Age Ms").
 */
export function formatEvidenceKey(key: string): string {
  const base = AGE_MS_KEY_PATTERN.test(key) ? key.slice(0, -2) : key;
  const spaced = base
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
  return spaced;
}

/** `${n} ${unit}` / `${n} ${unit}s` — no i18n plural rules needed for this
 * coarse a scale (English-only report, matching the rest of this module). */
function pluralize(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/**
 * Coarse human duration for an elapsed-milliseconds evidence value (spec
 * §5.3): "just now", "17 minutes", "3 hours", "6 days", "3 weeks". Rounds to
 * the nearest whole unit at each scale; a non-finite or negative input
 * degrades to an em dash rather than throwing (evidence is parsed JSON —
 * never trust the shape).
 */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 60_000) return 'just now';
  const minutes = ms / 60_000;
  if (minutes < 60) return pluralize(Math.round(minutes), 'minute');
  const hours = ms / 3_600_000;
  if (hours < 24) return pluralize(Math.round(hours), 'hour');
  const days = ms / 86_400_000;
  if (days < 7) return pluralize(Math.round(days), 'day');
  const weeks = ms / (7 * 86_400_000);
  return pluralize(Math.round(weeks), 'week');
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

/** First 8 chars of a source id — the fallback used wherever a `sourceNames`
 * map lookup misses (spec §5.4). */
export function shortSourceId(id: string): string {
  return id.slice(0, 8);
}

/** `sources` evidence array (source ids) -> comma-separated display names,
 * falling back to `shortSourceId` for anything `sourceNames` does not
 * contain (spec §5.4). Non-string entries fall back to `String(v)` rather
 * than throwing — evidence is parsed JSON. */
export function formatSourceIds(ids: unknown, sourceNames: Record<string, string>): string {
  if (!Array.isArray(ids) || ids.length === 0) return '—';
  return ids
    .map((id) => (typeof id === 'string' ? (sourceNames[id] ?? shortSourceId(id)) : String(id)))
    .join(', ');
}

export interface CoverageNote {
  rule: string;
  note: string;
  severity: 'hint' | 'blocked';
}

/**
 * Pure, unit-tested. Turns a coverage object into per-rule plain-English
 * notes about degraded evidence (spec §5.1). One entry per condition — when a
 * note covers several rules, `rule` carries the comma-separated list, exactly
 * as the spec's table does.
 *
 * `evidence.mqttSourceConfigured` (#4964 post-epic follow-ups) gates the
 * `!evidence.mqttGateway` hint: it only makes sense to tell an operator to
 * "enable the MQTT packet log" when an MQTT source actually exists to enable
 * it on. The hint fires when `mqttSourceConfigured === true`; it is
 * suppressed when `mqttSourceConfigured === false` (no MQTT source at all —
 * the hint would be actionless). When the field is absent — an older stored
 * `lastRunResult` summary persisted before this field existed — the hint
 * falls back to the pre-#4964-follow-up behavior of firing on
 * `!evidence.mqttGateway` alone, so a stale summary does not silently lose
 * the hint it used to show.
 */
export function coverageNotes(coverage: MeshIssuesCoverageWire): CoverageNote[] {
  const notes: CoverageNote[] = [];

  if (!coverage.evidence.traceroute) {
    notes.push({
      rule: 'B1, B4, B5, B7',
      note: 'needs traceroutes; none were collected in the window',
      severity: 'blocked',
    });
  }
  if (coverage.snrDirectionsWithMinSamples === 0) {
    notes.push({
      rule: 'B3',
      note: 'needs traceroutes or the MQTT packet log: no link has 3 or more SNR samples in one direction',
      severity: 'blocked',
    });
  }
  if (coverage.hopHorizonSource === null) {
    notes.push({
      rule: 'B6',
      note: 'needs a packet monitor: enable the Meshtastic packet log or the MQTT packet log',
      severity: 'blocked',
    });
  }
  if (!coverage.evidence.mqttGateway && (coverage.evidence.mqttSourceConfigured ?? true)) {
    notes.push({
      rule: 'B3, B7',
      note: 'the MQTT packet log is off, so gateway receptions are not contributing RF evidence',
      severity: 'hint',
    });
  }
  if (!coverage.evidence.packetLog) {
    notes.push({
      rule: 'B6',
      note: 'the Meshtastic packet log is off',
      severity: 'blocked',
    });
  }
  for (const skip of coverage.skippedRules) {
    notes.push({ rule: skip.rule, note: skip.reason, severity: 'blocked' });
  }
  if (coverage.tracerouteSentinelHopsDropped > 0) {
    notes.push({
      rule: 'B1-B5',
      note: `${coverage.tracerouteSentinelHopsDropped} traceroute hops were dropped as MQTT-injected (SNR sentinel)`,
      severity: 'hint',
    });
  }

  return notes;
}
