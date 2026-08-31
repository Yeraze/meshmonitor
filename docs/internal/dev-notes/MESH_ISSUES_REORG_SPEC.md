# Mesh Issues Report — Reorganization Spec

**Issue:** #4964 follow-on (report reorganization). The epic (#4964 Phases 1–3)
and its post-epic follow-up batch are merged to main.
**Worktree:** `../meshmonitor-mesh-issues-ui`, branch `feature/mesh-issues-report-reorg`.
**Status:** implementation spec. Wire contracts in §4 are FROZEN so the five
work packages in §11 can run in parallel.

---

## 1. Problem

On a populated mesh the report holds 1,000+ findings. A real dev-mesh run:

| type | count |
|---|---|
| `B7_coverage_shadow` | 582 |
| `C1_key_security` | 295 |
| `C1_time_offset` | 243 |
| `B5_load_bearing_client` | 61 |
| `B3_asymmetric_link` | 53 |
| … 13 more types | … |

The shipped layout is one `<div class="reports-node">` card per finding,
grouped by severity, with a per-severity "show more" of 25 and a wire-level
"Load more" of 500. Three failures:

1. **Severity is the wrong primary axis.** No rule emits `critical` today, so
   everything lands in two buckets. `info` alone holds ~800 cards.
2. **A card per finding does not scale.** 582 B7 findings differ in three
   numbers each; a card each is ~30x the ink needed.
3. **Management is per-finding only.** Dismissing 582 B7 findings is 582
   clicks, and there is no way to say "stop detecting this".

## 2. Approved design (user-signed-off, binding)

1. Summary dashboard of per-type tiles at the top; clicking a tile filters below.
2. **By issue** view: one collapsible section per issue type, containing a
   compact table with **type-specific columns**; a row expands inline to the
   full evidence detail (today's card body, reused verbatim).
3. **By node** view: findings grouped by `nodeNum`, ranked worst-first, with
   type badges and an expandable finding list.
4. Filters over both views: severity, tier, issue type, source, node-name
   substring. Persisted in `localStorage`.
5. Bulk management: dismiss/restore all of a type, dismiss/restore all for a
   node; plus per-rule mute with an "N open findings will auto-close" confirm.
6. Severity becomes a badge + a filter, not the grouping.

---

## 3. Reuse inventory (read before writing anything new)

Everything below **already exists**. Do not re-implement.

### 3.1 The closest precedent is `MqttViolationsReport.tsx`

`src/components/Analysis/MqttViolationsReport.tsx` is the same shape of
problem, already solved: a sortable table with expandable detail rows inside
an Analysis report.

| Thing | Where | Use |
|---|---|---|
| `SortableTh` | `MqttViolationsReport.tsx:1154-1181` | **Promote verbatim** to `meshIssues/SortableTh.tsx`. Renders `<th title><button className={styles.sortHeader}> label + <UiIcon name={dir==='asc'?'sortAscending':'sortDescending'} size={12}/></button></th>` with `aria-sort`. |
| Expandable-row idiom | `MqttViolationsReport.tsx:754-845` | Copy exactly: rows in `<Fragment key>`, summary `<tr className="reports-row--clickable" onClick>`, a dedicated `<td className={styles.expandButton}>` holding a `<button aria-expanded onClick={e => {e.stopPropagation(); toggle();}}>`. **`aria-expanded` goes on the button, never the `<tr>`** — `role="row"` does not support it (the comment at `:781-783` is load-bearing). Detail row: `<tr><td colSpan={columnCount} className={styles.detailCell}><div className={styles.detailInner}>`. |
| Detail-row CSS | `MqttViolationsReport.module.css:45-53, 116-135` | `.detailCell{padding:0;white-space:normal}` / `.detailInner{padding:.75rem 1rem;background:var(--color-bg-raised)}`. Copy the values. |

### 3.2 Global table classes (do not re-invent, do not move to a module)

`src/styles/analysis-reports.css`: `.reports-table-wrap` (:422),
`.reports-table` (:428), `.reports-table th` (:435), `.reports-table td`
(:447), `.reports-table tbody tr:hover` (:457),
`.reports-row--clickable` (:462). Plus `.reports-panel`, `.reports-controls`,
`.reports-btn`, `.reports-btn--ghost`, `.reports-banner--{error,empty,warning}`,
`.reports-stats`, `.reports-pill{,--ok,--warn}` (:498-515),
`.reports-node__{name,meta,field-label,field-value}`, `.reports-node-list`,
`.reports-section__{title,subtitle}`.

`.reports-table-wrap` already provides the `overflow-x:auto` container that
wide type-specific tables need.

### 3.3 Existing mesh-issues frontend code to reuse, not rewrite

From `src/components/Analysis/meshIssueTypes.ts` (all exported, all
unit-tested in `meshIssueTypes.test.ts`):

`SEVERITY_ORDER`, `ISSUE_TYPE_LABELS`, `ISSUE_TYPE_BLURBS`,
`STRUCTURED_EVIDENCE_KEYS`, `EvidenceNodeRef`, `isEvidenceNodeRefArray`,
`EvidenceDirectionalSnr`, `isEvidenceDirectionalSnr`, `formatSnrDirection`,
`hexNodeId`, `formatEvidenceKey`, `formatDurationMs`, `formatEvidenceValue`,
`shortSourceId`, `formatSourceIds`, `coverageNotes`.

From `src/components/Analysis/MeshIssuesReport.tsx` — **move verbatim**, do not
rewrite: `CoveragePreface` (:372-455), `NODE_LIST_EVIDENCE_KEYS` (:461-466),
`formatFieldValue` (:612-616), `normalizeMemberList` (:765-771),
`truncationLabel` (:776-782), `MemberList` (:784-809), `isEvidenceEdgeRefArray`
(:817-826), `EdgeList` (:828-854), `SnrDirections` (:866-906) — including its
load-bearing direction-convention comment — `asNodeRef` (:908-913), `Field`
(:915-920), and the `RouterClusterMap` call site (:714-721).

The whole `FindingCard` body (`:704-756`) becomes `FindingDetail` and is the
**row-expansion body**. Its header (title/badges/actions, `:649-702`) is
dissolved into table cells.

### 3.4 Server-side reuse

- `ok()` / `fail()` from `src/server/utils/apiResponse.ts:15-39`.
- `resolvePermittedSourceIds(req, resource, allSourcesIn?)` and
  `parseSourcesParam(raw)` from `src/server/utils/permittedSources.ts`.
- `redactEvidence`, `toWireIssue`, `buildNodeNameMap`, `sortIssues`,
  `SEVERITY_RANK`, `parsePageLimit`, `parsePageOffset` — all already in
  `meshIssuesRoutes.ts`. The new endpoints reuse them; **none of them change**.
- `BaseRepository.getAffectedRows(result)` (`src/db/repositories/base.ts:177`)
  for a dialect-portable bulk-update row count.
- Route tests: `createRouteTestApp()` from
  `src/server/test-helpers/routeTestApp.ts` — already used by
  `meshIssuesRoutes.test.ts`.
- `runRulesIsolated` (`meshIssues/ruleRunner.ts`) — unchanged.

### 3.5 Bulk-endpoint precedent

Two shapes exist; there is **no** "apply to a filter object" precedent.

- Explicit id array: `POST /api/security/dead-nodes/bulk-delete`
  (`securityRoutes.ts:438`) — `{nodeNums, sourceId}` in body, per-item
  try/catch, `results[]`, `auditLogAsync(..., 'dead_nodes_cleanup', 'nodes', ...)`.
- Implicit scope: `POST /api/settings/mark-all-welcomed`
  (`settingsRoutes.ts:1909`) — no id list, one optional `sourceId`, returns
  `{success, count, message}`, 7-arg audit with `JSON.stringify({count, sourceId})`
  as `valueAfter`.

This spec uses the **implicit-scope** shape (§4.4) and justifies it there.

### 3.6 localStorage convention

No `useLocalStorage` hook and no global key prefix exist. The de-facto pattern
for view state is `PacketMonitorPanel.tsx:46-52` (a local `safeJsonParse`
guard) + a lazy `useState` initializer (`:69-88`) + a one-line writer
`useEffect` (`:241-256`), with keys in `camelCaseFeature.camelCaseProp` form
(`packetMonitor.filters`, `mqttPacketMonitor.selectedGateways`,
`mapAnalysis.config.v1`). This spec follows that, versioned (§7.3).

### 3.7 CSS tokens

`MeshIssuesReport.module.css:1-6` states the rule: **`var(--color-*)` with no
fallback value**, so themes apply (map-sidebar lesson). Restated at `:107-109`.
Tints use `color-mix(in srgb, var(--color-X) 18%, transparent)` (`:59`, `:64`).
Tokens in use: `--color-error` (critical), `--color-warning` (warning),
`--color-text-subtle` (info/muted), `--color-success` (ok),
`--color-surface`, `--color-bg-raised`, `--color-text`, `--color-text-muted`,
`--color-accent`. The only permitted fallback anywhere is the non-color
`var(--font-mono, monospace)`.

### 3.8 Icons

`UiIcon` only (`src/components/icons/UiIcon.tsx`). Names this spec uses, all
existing: `sortAscending`, `sortDescending`, `chevronDown`, `chevronUp`,
`filter`, `search`, `close`, `refresh`, `muted`, `unmute`, `alert`, `error`,
`info`, `play`, `sparkles`, `checkAll`, `more`, `nodes`, `list`, `network`.
No emoji, no Unicode icon stand-ins.

---

## 4. Wire contracts (FROZEN)

All under `/api/analysis/mesh-issues`. `ApiService.request()` returns the raw
envelope and does **not** unwrap `data` — every frontend call reads
`body.data` explicitly.

### 4.1 Shared filter query params (new)

Accepted by `GET /` and `GET /summary`. All optional; absent means "no
constraint". Parsing is **clamp-never-reject**: an unknown token is dropped,
an all-unknown list is treated as absent.

| Param | Format | Applies to |
|---|---|---|
| `severity` | csv of `critical,warning,info` | both |
| `tier` | csv of `A,B,C` — matched against `issueType[0]` | both |
| `issueType` | csv of `MESH_ISSUE_TYPES` values | `GET /` only |
| `nodeNum` | integer, or the literal `none` (matches `nodeNum IS NULL`) | `GET /` only |
| `sources` | csv of source ids, via `parseSourcesParam`; intersected with the caller's permitted set | both |
| `q` | case-insensitive substring, matched against the resolved `nodeName` **or** `subjectKey` | both |
| `includeClosed` | `true` | both |
| `includeDismissed` | `true` | both |
| `limit` / `offset` | unchanged: default 500, clamp `[50, 2000]`; offset floors at 0 | `GET /` only |

`GET /summary` deliberately ignores `issueType` and `nodeNum`: the tiles *are*
those dimensions, so filtering them by themselves is circular and would empty
the dashboard the moment a tile is clicked.

**Filtering happens server-side, before `counts`/`total`/pagination.** A
client-side filter over one page would make `total` and `counts` lie. This is
the single most important architectural call in this spec.

### 4.2 `GET /api/analysis/mesh-issues` — response UNCHANGED

`MeshIssuesResponse` keeps its exact shape (`issues`, `counts`, `sourceNames`,
`total`, `limit`, `offset`). `counts` and `total` continue to describe the
**full filtered post-permission set**; the filters in §4.1 simply narrow what
"filtered" means. `sortIssues()` and its severity → `lastDetected` desc → `id`
desc ordering are unchanged, so offset paging stays stable.

### 4.3 `GET /api/analysis/mesh-issues/summary` — NEW

Same `403 NO_PERMITTED_SOURCES` gate as `GET /`. Never returns `evidence`.

```ts
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

export interface MeshIssueNodeSummary {
  /** `null` == the Mesh-wide pseudo-group (see §6.3). */
  nodeNum: number | null;
  /** `longName ?? shortName ?? !hex`; `null` for the Mesh-wide group. */
  nodeName: string | null;
  total: number;
  bySeverity: { critical: number; warning: number; info: number };
  worstSeverity: MeshIssueSeverity;
  /** Distinct issue types under this node, ordered worst-severity-first
   *  then lexicographic. Drives the badge row. */
  issueTypes: string[];
  latestDetected: number;
}

export interface MeshIssuesSummary {
  byType: MeshIssueTypeSummary[];   // only types with total > 0
  byNode: MeshIssueNodeSummary[];   // ranked; see §6.3
  counts: MeshIssueCounts;          // same shape as GET /
  total: number;                    // === counts.total
  sourceNames: Record<string, string>;
}
```

Ordering: `byType` by `worstSeverity` rank, then `total` desc, then
`issueType` asc. `byNode` per §6.3.

Errors: `403 NO_PERMITTED_SOURCES`, `500 MESH_ISSUES_SUMMARY_FAILED`.

### 4.4 Bulk dismiss / restore — NEW

```
POST /api/analysis/mesh-issues/bulk/dismiss
POST /api/analysis/mesh-issues/bulk/restore
```

`requirePermission('settings', 'write')` — identical to the single-finding
routes (P3-D7: `mesh_issues` is a global table with no `sourceId`, so
`nodes:write` scoping is not available).

Body — a **declarative scope**, not an id array:

```ts
type MeshIssueBulkScope =
  | { scope: 'issueType'; issueType: string }
  | { scope: 'node'; nodeNum: number | null };   // null == Mesh-wide group
```

Response: `ok(res, { affected: number })`.

**Why a scope and not an id list.** An id array from a page loaded ten minutes
ago races the scheduler: ids reopen, close, and are re-detected between load
and click. A declarative scope is idempotent, is resolved server-side under the
caller's own permitted sources, and needs no client-side pre-filtering. It also
makes the confirm dialog's wording ("dismiss all 582 coverage-shadow findings")
literally true at execution time.

**Partial-visibility semantics (decided, justify in review).** The scope
resolves to rows whose stored `sourceIds` intersect the caller's permitted set
— exactly the `toWireIssue` test the list endpoint uses. Rows with an empty
intersection are **skipped and never mutated**. The response reports **only
`affected`**; it does **not** report a `skipped` count, because a skipped
count is itself a disclosure that findings exist on sources the caller cannot
read (#3745 leak class — the same reason the single-finding routes 404 rather
than 403). If a caller can see 30 of 50 findings of a type, they dismiss 30 and
are told `affected: 30`; the other 20 stay open for whoever can see them.
That is the honest, non-leaking behaviour and it matches the "bulk ops only
affect findings the caller can see" requirement exactly.

**Dismiss/restore vs. status.** `dismiss` targets scope rows with
`dismissed === false`, regardless of `status`. `restore` targets scope rows
with `dismissed === true`, regardless of `status`. Dismissal is orthogonal to
open/closed: a closed row that later reopens should stay dismissed if the user
dismissed its whole type.

**Filters are deliberately NOT part of the scope.** "Dismiss everything
matching my current arbitrary filter combination" is a footgun that cannot be
described honestly in a confirm dialog. Weakened on purpose; see §12.

Errors:

| Status | Code | When |
|---|---|---|
| 400 | `INVALID_BULK_SCOPE` | missing/unknown `scope`, or a `nodeNum` that is neither an integer nor `null` |
| 400 | `INVALID_ISSUE_TYPE` | `issueType` not in `MESH_ISSUE_TYPES` |
| 403 | `NO_PERMITTED_SOURCES` | caller has no readable source |
| 500 | `MESH_ISSUE_BULK_DISMISS_FAILED` / `MESH_ISSUE_BULK_RESTORE_FAILED` | |

Audit (7-arg form, awaited — the count matters):

```ts
await databaseService.auditLogAsync(
  req.user!.id,
  dismissed ? 'mesh_issue_bulk_dismiss' : 'mesh_issue_bulk_restore',
  'settings',
  `${dismissed ? 'Dismissed' : 'Restored'} ${affected} mesh issue(s) (${scopeLabel})`,
  req.ip || null,
  null,
  JSON.stringify({ scope, affected }),
);
```

### 4.5 Per-rule mute — settings key, no new endpoint

New key **`mesh_issues_disabled_rules`**: a CSV of `MESH_ISSUE_TYPES` values,
e.g. `B7_coverage_shadow,C1_time_offset`. Empty string == nothing muted.
Written through the existing `POST /api/settings`.

Surfaced on `GET /status` as a new field on `ResolvedMeshIssueThresholds`:

```ts
export interface ResolvedMeshIssueThresholds {
  // ... existing fields unchanged ...
  /** @deprecated legacy; folded into `disabledRules`. Kept on the wire so
   *  existing consumers/tests do not break. */
  b7Enabled: boolean;
  /** Resolved, validated, sorted. Unknown ids dropped. */
  disabledRules: string[];
}
```

### 4.6 Per-type run outcome — extends the stored run summary, no migration

`MeshIssuesRunResult` (and therefore `MeshIssuesLastRunResult` on the wire)
gains two **optional** fields:

```ts
  /** issueType -> findings CREATED by the last run. */
  newByType?: Record<string, number>;
  /** issueType -> findings REOPENED by the last run. */
  reopenedByType?: Record<string, number>;
```

Optional because `mesh_issues_last_run_summary` holds summaries persisted
before these fields existed — same doctrine as `mqttSourceConfigured`. Absent
⇒ the dashboard renders no new/reopened chip rather than a zero.

**Note (accepted, pre-existing):** `/status.lastRunResult` is already a
run-level, cross-source aggregate gated only by "caller has ≥1 permitted
source" (`byType`, `findingCount`, `nodeCount` are already there). These two
fields inherit that property; they are not filtered by the caller's permitted
sources. Label the chip "3 new this run" — run-level language — never "3 new
in your view".

---

## 5. Why this shape, not the alternatives

### 5.1 Pagination: KEEP the wire pagination, add filters + a summary endpoint

The brief asks whether the recently-added `limit`/`offset` still serves. It
does, and the new views make it serve *better*, provided filtering moves to
the server.

**Decision.** Keep `limit`/`offset` and the `[50, 2000]` clamp exactly as
shipped. Add the §4.1 filters and the §4.3 summary endpoint. Do not fetch the
full set.

**Why.**

- **First paint gets dramatically cheaper, not more expensive.** Today the
  report fetches 500 findings-with-evidence before it can draw anything. Under
  this design the initial load is `GET /summary` + `GET /status` and **zero
  finding rows** — every type section starts collapsed (§6.2). A ~1.8 MB
  first payload becomes a few KB. Regressing that to "fetch everything" would
  throw away the payload win *and* make the worst case worse.
- **Sort correctness is preserved where it matters.** A table sorted by a
  type-specific evidence column must sort the whole type group, not a page.
  With `issueType=` filtering, one group is bounded by that type's count — 582
  for the worst real case, well under the 2000 cap — so expanding a section
  fetches the **entire group in one request** (`limit=2000`) and sorts it
  client-side. Correct sort, one round trip, no server-side evidence parsing.
- **Server-side sort is not an option for these columns.** Sorting by
  `deltaDb` or `overlapRatio` server-side would mean the route parsing
  evidence JSON and carrying 18 column specs. That belongs in the frontend,
  which already parses evidence to render it.
- **The by-node view never needs bulk rows at all** — `/summary.byNode` gives
  the ranked list and badges; expanding one node fetches `?nodeNum=X`, at most
  ~18 rows.

**Degradation, documented in the UI.** If a single type ever exceeds 2000
findings, the section keeps the existing "Load more" control and shows a note:
sorting then applies to loaded rows only. This cannot happen with today's 18
rules on a realistic mesh (findings are capped by auto-close at ~1–2k total),
but the code must not lie about it.

### 5.2 Rule mute: ONE CSV key, not 18 boolean keys

**Decision.** `mesh_issues_disabled_rules` (CSV), not
`mesh_issues_<rule>_enabled` × 18.

**Why.** 18 keys would mean 18 entries in `VALID_SETTINGS_KEYS`, 18 in
`GLOBAL_ONLY_SETTINGS_KEYS`, 18 in `MESH_ISSUE_THRESHOLD_SETTINGS_KEYS`, 18
fields on `ResolvedMeshIssueThresholds`, 18 lines in `resolveThresholds`, 36
`useState` pairs in `MeshIssuesSection.tsx` (it keeps a `local*` mirror per
field), 18 entries in its hand-maintained `handleSave` literal and 18 in that
callback's dependency array — ~130 hand-edited lines that must stay in step,
and a new one for every future rule. The CSV is one entry in each registry and
one line in `resolveThresholds`. CSV rather than JSON because rule ids are
`[A-Za-z0-9_]+` so no escaping is possible or needed, and settings values are
stored as strings anyway.

**Clamp-on-read, per the established seam.** `resolveThresholds` parses the
CSV, trims, drops empties, intersects with `MESH_ISSUE_RULE_IDS`, dedupes and
sorts. An unknown id is **silently dropped**, never rejected — the same
doctrine as `resolveClampedNumber` ("unparseable falls back to the default, a
finite out-of-range value clamps to the nearer bound"). A garbage value
therefore mutes nothing rather than breaking the run.

**Canonical rule id == the `issueType` string.** Not the rule-function names,
which are inconsistent (`rules.ts:471` uses `'A1'`, `rulesTierB.ts:976` uses
`'B1'`, `rulesTierC.ts:315` uses `'C1_key_security'`) and not 1:1 with issue
types anyway: `evaluateA2b` emits both `A2b_congested_area` and
`A2b_congested_node`. Using issue types gives exactly 18 stable, already-frozen
ids that match what the UI groups by and what a "mute this" button naturally
sends.

**Gate at the finding level, not the rule level.** In
`meshIssuesAnalysisService.runAnalysis`, after the three tiers have contributed:

```ts
const disabled = new Set(thresholds.disabledRules);
const kept = disabled.size === 0 ? findings : findings.filter(f => !disabled.has(f.issueType));
```

One line, exact for the A2b/C1 many-types-per-rule cases, tier-agnostic, and it
requires no surgery on the three rule-runner arrays. Cost: a muted rule still
executes (in-memory CPU only — the analyzer sends nothing and touches no
radio). Accepted; noted so a reviewer does not read it as an oversight.

**Auto-close falls out for free.** A muted type emits no findings, so
`persistFindings`' existing clean-run bookkeeping closes its open rows after
`thresholds.autoCloseCleanRuns` runs with nothing detected — the identical
"honest close" path the shipped tier toggles already rely on
(`meshIssuesAnalysisService.ts:440-452` comment). **No new close endpoint, and
no immediate deletion.** This is exactly what the confirm dialog must say.

**Legacy `mesh_issues_b7_enabled` is kept, not retired.** Installs have it set.
`resolveThresholds` folds it in:

```ts
const disabled = parseDisabledRules(raw['mesh_issues_disabled_rules']);
if (raw['mesh_issues_b7_enabled'] === 'false') disabled.add(MESH_ISSUE_TYPES.B7_COVERAGE_SHADOW);
```

**TRAP — read this before writing the UI.** Because the legacy key is
OR-ed in, un-muting B7 through the CSV alone does nothing while
`mesh_issues_b7_enabled === 'false'`. Every write of the mute set must
therefore also write the legacy key. A single shared helper does this and both
call sites use it:

```ts
// src/components/Analysis/meshIssueRuleIds.ts  (WP2)
export function buildRuleMuteSettingsPatch(disabledRuleIds: string[]): Record<string, string> {
  return {
    mesh_issues_disabled_rules: [...new Set(disabledRuleIds)].sort().join(','),
    // Keeps the legacy key from silently re-muting B7 (§5.2).
    mesh_issues_b7_enabled: String(!disabledRuleIds.includes(MESH_ISSUE_TYPE_IDS.B7_COVERAGE_SHADOW)),
  };
}
```

The tier toggles (`mesh_issues_tier_{a,b,c}_enabled`) stay as they are — a
coarse control that already ships and already works.

### 5.3 No migration

Nothing in this spec needs a schema change.

- Bulk dismiss reuses the existing `dismissed`/`dismissedAt`/`dismissedBy`
  columns.
- Filters and the summary are derived from existing columns.
- Rule mute is a settings key.
- The one thing that genuinely has **no** trace in the schema — "was this
  finding reopened by the last run?" — is solved in §4.6 by extending the
  already-persisted run summary (a settings-key payload, not a table), because
  the analysis service already knows each upsert's `created | updated |
  reopened` outcome and only throws it away in aggregate. Adding a
  `reopenedAt` column for a badge would be a migration across three backends
  plus hand-written PG/MySQL DDL updates in the repo test, to store something
  already computed. Rejected.

### 5.4 No `dataEventEmitter`, no mesh impact

**Mesh impact checklist, discharged.** Nothing here sends a packet, arms a
timer, or emits a `dataEventEmitter` event. The analyzer is a passive read of
rows already on disk (see its own header) and the only timer involved,
`meshIssuesScheduler`, is untouched: it persists `mesh_issues_last_run` to
settings on every run (`meshIssuesScheduler.ts:282-286`) and recovers it on
boot, so **saving the mute setting cannot reset the safety timer** — the
scheduler reads settings per tick and holds no in-memory last-fire state.
Airtime cost: zero. Spam paths: none (no notifications; the epic recorded "No
notifications" as a user decision). The only new cost is a bulk `UPDATE` over
at most a few hundred rows, bounded by the finding count, behind the existing
global `apiLimiter` on `/api`. No new rate limiter, no new user-facing limit,
therefore nothing here requires a policy decision from the user.

---

## 6. UI design

### 6.1 Summary dashboard

A responsive grid of tiles above the views, one per issue type present in
`summary.byType`. Each tile:

```
┌────────────────────────────────┐
│ ⚠  B7  Coverage shadow          │   UiIcon = SEVERITY_ICON[worstSeverity]
│ 582                             │   total, large
│ 582 info · 12 new this run      │   severity breakdown + run chips
└────────────────────────────────┘
```

- Border-left 3px in the worst-severity token colour.
- `12 new this run` from `status.lastRunResult.newByType?.[issueType]`;
  `3 reopened` from `reopenedByType`. Both chips hidden when the field is
  absent (legacy summary) or zero.
- The tile is a `<button aria-pressed>`. Clicking sets
  `filters.issueTypes = [issueType]` and switches to the By-issue view with
  that section auto-expanded; clicking the active tile clears the filter.
- A leading "All" tile shows `counts.total` and clears `issueTypes`.
- Tiles reflect the active severity/tier/source/`q` filters (they are passed to
  `/summary`), but never the `issueType` filter (§4.1).

### 6.2 By-issue view

One `<section>` per type in `summary.byType` order. Header:

```
▸ B3  Asymmetric link — 53 · 51 warning, 2 info        [⋯]
```

- `ruleShortId(issueType) = issueType.split('_')[0]` → `A1`, `A2a`, `A2b`,
  `B3`, `C1`, `C2`. Label from `ISSUE_TYPE_LABELS`.
- `— {total} · {breakdown}` where breakdown lists non-zero severities
  worst-first.
- Plus `N new` / `N reopened` chips from `lastRunResult` (same source as the
  tiles).
- `[⋯]` opens `BulkActionMenu` (§6.4).
- **Collapsed by default unless `bySeverity.critical > 0`.** Implementer note:
  no shipped rule emits `critical` (§1), so in practice *every* section starts
  collapsed. That is intended, not a bug — with 1,000+ findings, collapsed is
  the correct default. A section auto-expands when the active `issueTypes`
  filter narrows to exactly that one type (i.e. after a tile click).
- Expansion state is persisted (§7.3).

On first expand the section runs its own query:
`GET /?issueType=<type>&limit=2000&offset=0` + the active filters. The group is
sorted client-side by the type's `primary` column, descending. Sorting is
per-section and independent (same as `MqttViolationsReport`'s summary vs
drill-down tables).

Table shape:

| cell | content |
|---|---|
| expand | `<button aria-expanded>` chevron (§3.1) |
| state | `New` chip when `firstDetected >= status.lastRunTime`; `Dismissed` badge when `dismissed` |
| subject | §6.5 |
| …type-specific… | §8 |
| sources | `formatSourceIds(sourceIds, sourceNames)` — **column hidden entirely when `Object.keys(sourceNames).length <= 1`**, which is most installs; it costs width and says nothing |
| severity | existing `.badge--{severity}` pill |
| last detected | `new Date(lastDetected).toLocaleString()`, `title` = ISO |
| actions | dismiss (`close`) / restore (`refresh`) icon button, existing handlers |

Row click toggles the expansion; the expansion body is `FindingDetail`
(today's card body) in a `<td colSpan={columnCount}>`.

### 6.3 By-node view

Rows come from `summary.byNode`, **ranked worst-first**: `worstSeverity` rank,
then `total` desc, then `latestDetected` desc, then `nodeNum` asc as a
deterministic tiebreak.

Each row: node name (or `!hex`), a total, a severity badge, and a badge row of
`issueTypes` rendered as `ruleShortId` pills coloured by that type's worst
severity for this node. Expanding fetches `GET /?nodeNum=<n>` and renders the
findings as a compact list reusing `FindingDetail`, one per type.

**Findings with `nodeNum === null` go into a pinned "Mesh-wide" pseudo-group**
at the top of the list (`nodeNum: null`, `nodeName: null`). Affected types:
`A2b_congested_area` (always), `B1_router_cluster` (always), and
`B3_asymmetric_link` when neither or both endpoints are infra
(`rulesTierB.ts:605`).

**Why a pseudo-group and not attachment to member nodes.**

1. **It would corrupt the ranking.** Attaching a 6-router cluster finding to
   its 6 members adds 1 to six nodes' counts for *one* real problem, so the
   worst-first ordering — the entire point of this view — would rank a
   healthy-but-clustered node above a genuinely failing one.
2. **It would break bulk-by-node.** "Dismiss all for node X" would silently
   dismiss a finding that is also listed under node Y, with no way to express
   that in the confirm dialog. The pseudo-group keeps every finding in exactly
   one bucket, so `{scope:'node'}` stays a partition.
3. **The server cannot do it cheaply or safely.** Membership lives inside
   `evidence` JSON (`members`, `nodes`, `nodeA`/`nodeB`), which is
   per-caller-redacted at `toWireIssue` time; deriving groups from it would
   mean redaction-aware grouping in the aggregate endpoint.
4. **It is honest.** A router cluster is not node X's problem; it is the
   cluster's. Labelling it "Mesh-wide" says so.

Discoverability is preserved in three ways: the group is pinned first, not
buried; each expanded finding still shows its member chips via the existing
`MemberList`; and the By-issue view remains the way to hunt a specific
cluster. See §12 for the one thing this weakens.

### 6.4 Bulk actions and mute

`BulkActionMenu` — a small popover on each type-section header and each
by-node row header, rendered only when `canAct` (the existing gate: status
query succeeded and no prior 401/403 on a mutation).

Type scope: `Dismiss all N` · `Restore all N dismissed` · `Mute this rule`.
Node scope: `Dismiss all N for this node` · `Restore all N dismissed`.

Every destructive item opens a confirm dialog before firing. Both bulk calls
invalidate `[ISSUES_BASE_KEY]` and the summary key on success.

`MuteRuleDialog`:

- On open, fetches `GET /summary` **with no filters** and reads
  `byType[type].total` so the count is the true open, non-dismissed total, not
  the filtered view's.
- Copy: *"Mute B7 Coverage shadow? New findings will stop being detected. The
  582 open findings will auto-close after {{runs}} analysis runs (about
  {{days}} days at the current schedule)."* — `runs` from
  `status.thresholds.autoCloseCleanRuns`, `days` from
  `runs * status.frequencyHours / 24`, rounded.
- Confirm writes `buildRuleMuteSettingsPatch([...current, type])` via
  `apiService.post('/api/settings', patch)` (the same CSRF-aware client the
  report already uses for `/run-now` and `/dismiss`), then invalidates
  `STATUS_KEY`.
- **Read-modify-write hazard:** `current` comes from
  `status.thresholds.disabledRules`. The mutation must invalidate and await a
  fresh status before another mute is allowed (disable the menu while
  `isPending`). Two rapid mutes off a stale list would drop one.
- Muted types are still listed in the By-issue view (their existing findings
  are still there and still auto-closing) with a `muted` icon and a
  `Restore rule` action in the header menu.

### 6.5 Subject cell, per subject kind

`subjectKey` prefix decides:

| prefix | render |
|---|---|
| `node:` | `nodeName ?? hexNodeId(nodeNum)` |
| `area:` | `Area {centerLat.toFixed(2)}, {centerLon.toFixed(2)}` from evidence, falling back to the raw `subjectKey` |
| `edge:` | `{nodeA.name ?? hex(nodeA.nodeNum)} ↔ {nodeB.name ?? hex(nodeB.nodeNum)}` from evidence, falling back to the raw `subjectKey` |
| `cluster:` | `Cluster of {size}` + the `bestSitedName` as a subtitle |

All four read through the defensive accessors in §8.3 — `evidence` is parsed
JSON and its name fields can be `null` after redaction.

---

## 7. Frontend file layout

### 7.1 New directory

`src/components/Analysis/meshIssues/`. `MeshIssuesReport.tsx` stays where it
is (it is the export the reports page imports) and shrinks to a shell.

```
src/components/Analysis/
  MeshIssuesReport.tsx              ~250 lines  shell: queries, filter state, view switch
  meshIssueTypes.ts                 wire types + formatters   (WP1 edits; everyone else reads)
  meshIssueRuleIds.ts               NEW  rule-id list + buildRuleMuteSettingsPatch  (WP2)
  RouterClusterMap.tsx              unchanged
  meshIssues/
    CoveragePreface.tsx             moved verbatim from MeshIssuesReport.tsx:372-455
    evidenceRenderers.tsx           moved verbatim: MemberList, EdgeList, SnrDirections,
                                    Field, normalizeMemberList, truncationLabel,
                                    isEvidenceEdgeRefArray, asNodeRef, formatFieldValue,
                                    NODE_LIST_EVIDENCE_KEYS
    FindingDetail.tsx               today's FindingCard BODY (:704-756) as the row expansion
    SortableTh.tsx                  promoted from MqttViolationsReport.tsx:1154-1181
    SummaryTiles.tsx
    FilterBar.tsx
    ByIssueView.tsx
    IssueTypeSection.tsx            header + per-section query + IssueTable
    IssueTable.tsx                  generic table driven by IssueColumn[]
    ByNodeView.tsx
    NodeGroupSection.tsx
    BulkActionMenu.tsx
    MuteRuleDialog.tsx
    issueColumns.ts                 PURE — the 18 column specs + fallback
    grouping.ts                     PURE — filter predicate, comparators, node ranking
    useMeshIssuesViewState.ts       localStorage-backed view state
    meshIssues.module.css           MOVED from ../MeshIssuesReport.module.css
    IssueTable.module.css           NEW
    SummaryTiles.module.css         NEW
    FilterBar.module.css            NEW
```

### 7.2 CSS split rationale

`MeshIssuesReport.module.css` **moves** to `meshIssues/meshIssues.module.css`
unchanged (imports update). It is already a family sheet — `.badge`,
`.badge--{severity}`, `.memberChip`, `.snrTable`, `.coveragePreface`,
`.recommendation` are consumed by four or more of the components above, and
splitting them per-component would fragment the severity tokens and duplicate
`color-mix` values. Genuinely new surfaces get their own modules per the CSS
containment rule. Keep the file's header comment about token-only colours; it
is the reason `.badge--critical` renders correctly in both themes.

Do not add anything to `src/styles/analysis-reports.css` or the other frozen
global sheets; the table classes there are reused as-is.

### 7.3 View-state persistence

`useMeshIssuesViewState()` follows `PacketMonitorPanel.tsx:46-52,69-88,241-256`
— a local `safeJsonParse(raw, fallback)` guard, a lazy `useState` initializer,
and a writer `useEffect` — with a single versioned key in the newest
convention (`packetMonitor.*` / `mapAnalysis.config.v1`):

```
localStorage key: "meshIssues.viewState.v1"
```

```ts
export interface MeshIssuesViewState {
  version: 1;
  view: 'byIssue' | 'byNode';
  filters: MeshIssuesFilters;
  /** issueType -> {key, dir}. Absent means the type's primary column, desc. */
  sortByType: Record<string, { key: string; dir: 'asc' | 'desc' }>;
  expandedTypes: string[];
  expandedNodes: Array<number | 'mesh-wide'>;
}
```

Read is fully defensive: a parse failure, a missing/mismatched `version`, or a
non-object returns the default state. Every write is `try/catch`-wrapped
(Safari private mode — the `nodeDisplayStorage.ts` precedent). Unknown issue
types in `sortByType`/`expandedTypes` are dropped on read, so a downgrade after
a rule is added cannot poison the state.

`filters.q` **is** persisted (it is a saved view, not a transient search);
the tile selection is not persisted separately since a tile click is just
`filters.issueTypes`.

### 7.4 Query keys

```ts
const ISSUES_BASE_KEY  = 'mesh-issues';                       // existing
const SUMMARY_BASE_KEY = 'mesh-issues-summary';               // new
const STATUS_KEY       = ['mesh-issues-status'] as const;     // existing

summaryKey(filters)            => [SUMMARY_BASE_KEY, serverFilterParams(filters)]
typeIssuesKey(type, filters)   => [ISSUES_BASE_KEY, { issueType: type, ...serverFilterParams(filters) }]
nodeIssuesKey(nodeNum, filters)=> [ISSUES_BASE_KEY, { nodeNum, ...serverFilterParams(filters) }]
```

`invalidateIssues()` keeps its existing partial-key behaviour and gains a
sibling `invalidateSummary()`; every mutation (single dismiss, bulk, run-now)
invalidates both plus `STATUS_KEY`.

---

## 8. Type-specific columns

### 8.1 The column contract (pure, in `issueColumns.ts`)

```ts
export type ColumnAlign = 'left' | 'right';

export interface ColumnCtx {
  sourceNames: Record<string, string>;
}

export interface IssueColumn {
  /** Stable id; the persisted sort key. Never renamed once shipped. */
  key: string;
  label: string;
  /** Sort value. `null` sorts LAST in BOTH directions (see §8.4). */
  sortValue: (row: MeshIssueRow) => number | string | null;
  render: (row: MeshIssueRow, ctx: ColumnCtx) => React.ReactNode;
  align?: ColumnAlign;
  numeric?: boolean;
  /** Exactly one column per type carries this: the section's default sort. */
  primary?: boolean;
  /** Default direction when this column is first selected. Default 'desc'. */
  defaultDir?: 'asc' | 'desc';
}

/** Type-specific columns only — the shell adds expand/state/subject before
 *  and sources/severity/lastDetected/actions after. */
export function columnsForType(issueType: string): IssueColumn[];
```

Invariants (asserted by unit test): every one of the 18 types returns a
non-empty array with **exactly one** `primary: true`; every `key` is unique
within its array; an unknown `issueType` returns the fallback of §8.5.

### 8.2 The 18 column sets

Derived from the actual `evidence` emissions in `rules.ts` / `rulesTierB.ts` /
`rulesTierC.ts`. **P** marks the primary (default-sort) column; `↑` means
`defaultDir: 'asc'` because low is bad.

| issueType | columns (evidence key → label) |
|---|---|
| `A1_deprecated_role` | `roleName`→Role · **P** `lastHeardAgeMs`→Last heard (`formatDurationMs`, `↑` newest-first is desc so keep desc) |
| `A2a_chatty_node` | **P** `meanAirUtilTx`→Mean AirUtilTx % · `maxAirUtilTx`→Max % · `sampleCount`→Samples · `thresholdUsed`→Threshold % |
| `A2b_congested_area` | `nodeCount`→Nodes · **P** `meanChannelUtilization`→Mean ChanUtil % · `thresholdUsed`→Threshold % · `binSizeDeg`→Bin ° |
| `A2b_congested_node` | **P** `meanChannelUtilization`→Mean ChanUtil % · `sampleCount`→Samples · `binNodeCount`→Nodes in bin · `thresholdUsed`→Threshold % |
| `A3_infra_power` | `roleName`→Role · **P** `uptimeResets`→Resets · `minBatteryLevel`→Min battery % · `latestBatteryLevel`→Latest battery % · `clause`→Clause |
| `A4_mobile_infra` | `roleName`→Role · **P** `spanMeters`→Span m · `positionSampleCount`→Samples · `mobileFlag`→Mobile flag · `positionPrecisionBits`→Precision bits |
| `A5_cosplay_router` | `roleName`→Role · `isUnmessagable`→Unmessagable · **P** `medianIntervalMs`→Median interval (`formatDurationMs`, `↑`) · `telemetryCadenceClause`→Cadence · `firmwareVersion`→Firmware |
| `B1_router_cluster` | **P** `size`→Size · `members`→Members (first 3 chips + `+N`) · `bestSitedName`→Best sited · `inferredOnly`→Inferred only · `edgesTotal ?? edges.length`→Edges |
| `B2_redundant_router` | `roleName`→Role · `neighborCount`→Neighbours · `coveredByName`→Covered by · **P** `overlapRatio`→Overlap % · `sharedNeighborsTotal ?? sharedNeighbors.length`→Shared |
| `B3_asymmetric_link` | `snrToB.meanDb`→A→B dB · `snrToA.meanDb`→B→A dB · **P** `deltaDb`→Δ dB (sort by `Math.abs`) · `weakerDirection`→Weaker (rendered as the weaker **end's name**, not `a->b`) · `observationCount`→Obs · `thresholdUsed`→Threshold dB |
| `B4_idle_router` | `roleName`→Role · **P** `hopShare`→Hop share % (`↑`) · `areaPathCount`→Area paths · `peerBestName`→Best peer · `peerBestShare`→Peer share % · `directDegree`→Direct degree |
| `B5_load_bearing_client` | `roleName`→Role · **P** `areaShare`→Area share % · `hopCount`→Hops · `areaPathCount`→Area paths · `batteryLevel`→Battery % · `fixedAndPowered`→Fixed+powered · `mobile`→Mobile |
| `B6_hop_horizon` | **P** `exhaustedRatio`→Exhausted % · `exhaustedPackets`→Exhausted · `totalPackets`→Total · `behindRouterCluster`→Behind cluster · `hopDeltaIsLowerBound`→Lower bound |
| `B7_coverage_shadow` | `nearestRouterName`→Nearest router · **P** `distanceM`→Distance km · `routerObservedRangeM`→Router range km · `routerRangeSampleCount`→Range samples · `rangeCappedAtCeiling`→Capped |
| `C1_excessive_packets` | `roleName`→Role · **P** `packetRatePerHour`→Packets/hr |
| `C1_key_security` | **P** `clauses`→Clauses (joined; sort by `clauses.length`) · `details`→Details |
| `C1_time_offset` | **P** `timeOffsetSeconds`→Clock offset (signed, `formatDurationMs(Math.abs)` with a `+`/`−` prefix; sort by `Math.abs`) |
| `C2_over_broadcasting` | `roleName`→Role · `stream`→Stream · **P** `medianIntervalSeconds`→Median interval s (`↑`) · `meanIntervalSeconds`→Mean s · `sampleCount`→Samples · `thresholdUsed`→Threshold s · `otherStreamMedianSeconds`→Other stream s |

Rendering notes:

- Percent-valued evidence (`overlapRatio`, `hopShare`, `areaShare`,
  `exhaustedRatio`) is stored as a **ratio 0–1**; render `Math.round(v*100)`
  + `%` and sort on the raw ratio. Verify against the emitting rule before
  assuming — if a value is already a percentage, render it as-is.
- `distanceM` / `routerObservedRangeM` render in km to 1 dp; sort in metres.
- Booleans render through `formatEvidenceValue` ("Yes"/"No").
- `null`/absent renders an em dash via `formatEvidenceValue`.
- Any key matching `/AgeMs$/` renders through `formatDurationMs` — reuse
  `formatFieldValue` rather than re-testing the suffix.
- `sources` is **not** a per-type column; it is the shared column of §6.2.

### 8.3 Defensive accessors (required)

`evidence` is parsed JSON from the database and is additionally
**per-caller-redacted** (`redactEvidence` replaces `*Name` fields with `null`
for unpermitted nodes). Never index it directly in a column spec. `issueColumns.ts`
exports and uses:

```ts
function num(row: MeshIssueRow, key: string): number | null;   // finite numbers only
function str(row: MeshIssueRow, key: string): string | null;   // non-empty strings only
function bool(row: MeshIssueRow, key: string): boolean | null;
function arr(row: MeshIssueRow, key: string): unknown[] | null;
function path(row: MeshIssueRow, a: string, b: string): unknown; // e.g. snrToA.meanDb
```

A column whose value is `null` renders an em dash and sorts last. No column
spec may throw on `evidence === {}`.

### 8.4 Sorting semantics

- Comparator is **stable**; the secondary key is always `lastDetected` desc
  then `id` desc, mirroring the server's `sortIssues` so a section's order is
  deterministic.
- `null` sorts **last in both directions**. Ascending with nulls first would
  fill the top of every "lowest is worst" table with rows that have no data.
- Strings compare with `localeCompare`; numbers numerically.
- Clicking the active header toggles direction; clicking another switches
  column and uses that column's `defaultDir`.
- Sort state is per-type and persisted (§7.3).

### 8.5 Unknown-type fallback

A future rule must not render an empty table. `columnsForType(unknown)`
returns up to **three** columns built from the row's own evidence: the first
three keys that are not in `STRUCTURED_EVIDENCE_KEYS`, do not end in
`Truncated`/`Total`, and are not `recommendation`/`sources`, labelled with
`formatEvidenceKey` and rendered with `formatFieldValue`. `primary` is the
first of them, or — if evidence is empty — a single synthetic
`lastDetected` primary. The full evidence is still reachable via row
expansion, so nothing is lost.

---

## 9. File-by-file changes

### 9.1 `src/server/routes/meshIssuesRoutes.ts` (WP1)

Additions only; existing helpers and the `GET /` response shape are untouched.

```ts
// ── Shared filter parsing (§4.1) ──────────────────────────────────────────
interface IssueFilterSpec {
  severities: MeshIssueSeverity[] | null;
  tiers: string[] | null;              // 'A' | 'B' | 'C'
  issueTypes: string[] | null;
  nodeNum: number | 'none' | null;
  sourceIds: string[] | null;          // already intersected with `permitted`
  q: string | null;                    // lowercased
  includeClosed: boolean;
  includeDismissed: boolean;
}

/** Clamp-never-reject: unknown tokens dropped; an all-unknown list == null. */
function parseIssueFilters(query: Request['query'], permitted: string[]): IssueFilterSpec;

/** Applied AFTER toWireIssue (so it sees redacted sourceIds and the resolved
 *  nodeName), BEFORE counts/total/sort/slice. */
function matchesFilters(issue: MeshIssueWire, f: IssueFilterSpec): boolean;

// ── Summary (§4.3) ────────────────────────────────────────────────────────
export function buildSummary(
  issues: MeshIssueWire[],
  sourceNames: Record<string, string>,
): MeshIssuesSummary;   // exported pure — unit-tested directly

router.get('/summary', async (req, res) => { /* 403 NO_PERMITTED_SOURCES; 500 MESH_ISSUES_SUMMARY_FAILED */ });

// ── Bulk (§4.4) ───────────────────────────────────────────────────────────
function parseBulkScope(body: unknown):
  | { ok: true; scope: MeshIssueBulkScope }
  | { ok: false; code: 'INVALID_BULK_SCOPE' | 'INVALID_ISSUE_TYPE' };

async function handleBulkDismissOrRestore(
  req: Request, res: Response,
  dismissed: boolean,
  auditAction: 'mesh_issue_bulk_dismiss' | 'mesh_issue_bulk_restore',
): Promise<void>;

router.post('/bulk/dismiss',  requirePermission('settings', 'write'), ...);
router.post('/bulk/restore',  requirePermission('settings', 'write'), ...);
```

`handleBulkDismissOrRestore` flow: resolve `permitted` → 403 if empty → parse
scope → read every row (`getMeshIssuesAsync({includeClosed:true,
includeDismissed:true})`, the same read `GET /` already does, ≤ ~2k rows) →
keep rows matching the scope **and** passing the `toWireIssue` visibility test
**and** whose current `dismissed !== target` → `setMeshIssueDismissedForIdsAsync`
→ audit → `ok(res, { affected })`. No new repository *read* method: reusing the
existing full read keeps one visibility code path and cannot drift from `GET /`.

`GET /` changes: build `permitted`, call `parseIssueFilters`, filter `fullSet`
with `matchesFilters` before computing `counts` and slicing. Nothing else.

### 9.2 `src/db/repositories/meshIssues.ts` (WP1)

```ts
/**
 * Bulk dismiss/restore by explicit id list (route-resolved, already
 * visibility-checked). Drizzle-only, portable across all three dialects via
 * `inArray`. Ids are chunked so no single statement exceeds a backend's bound
 * -parameter limit (PostgreSQL 65535, MySQL max_prepared_stmt_count / packet
 * size, SQLite SQLITE_MAX_VARIABLE_NUMBER). Returns the summed affected-row
 * count via `getAffectedRows`, which already normalizes the three drivers'
 * differing result shapes.
 *
 * Mirrors `setDismissed`'s column semantics exactly: dismissedAt/dismissedBy
 * are set on dismiss and NULLed on restore; `firstDetected`, `status`,
 * `cleanRuns` and `closedAt` are never touched.
 */
async setDismissedForIds(
  ids: number[],
  dismissed: boolean,
  userId: number | null,
  nowMs: number,
): Promise<number>;
```

`ID_CHUNK_SIZE = 500`. An empty `ids` array returns `0` without issuing a
statement.

### 9.3 `src/services/database.ts` (WP1)

One facade method beside the existing `setMeshIssueDismissedAsync`:

```ts
async setMeshIssueDismissedForIdsAsync(
  ids: number[], dismissed: boolean, userId: number | null, nowMs: number,
): Promise<number> {
  return this.meshIssues.setDismissedForIds(ids, dismissed, userId, nowMs);
}
```

### 9.4 `src/components/Analysis/meshIssueTypes.ts` (WP1 ONLY)

**This file is edited by WP1 alone.** Every other package reads it. This is
what makes WP3/WP4/WP5 parallel-safe.

Add: `MeshIssueTypeSummary`, `MeshIssueNodeSummary`, `MeshIssuesSummary`,
`MeshIssueBulkScope`, `MeshIssuesBulkResult`, `MeshIssuesFilters`,
`ruleShortId(issueType)`, `tierOf(issueType)`, and the two new optional fields
on `MeshIssuesLastRunResult` (§4.6) plus `disabledRules: string[]` on
`ResolvedMeshIssueThresholds` (§4.5). No existing export changes.

### 9.5 `src/server/constants/settings.ts` (WP2)

Add `'mesh_issues_disabled_rules'` to **both** `VALID_SETTINGS_KEYS` (beside
the other `mesh_issues_*` entries, ~line 162) and `GLOBAL_ONLY_SETTINGS_KEYS`
(~line 650), with the same trailing comment style
(`// global batch job (#4964 report reorg)`). Missing either one makes the
setting silently fail to save.

### 9.6 `src/server/services/meshIssues/thresholds.ts` (WP2)

- Append `'mesh_issues_disabled_rules'` to `MESH_ISSUE_THRESHOLD_SETTINGS_KEYS`
  (this is the single source of truth both the analysis service and
  `getStatus()` read from — nothing else needs updating).
- Add `disabledRules: string[]` to `ResolvedMeshIssueThresholds`; add
  `disabledRules: []` to `DEFAULT_MESH_ISSUE_THRESHOLDS`.
- New pure helper beside `resolveClampedNumber`:

```ts
/** Clamp-never-reject (same doctrine as resolveClampedNumber): splits on
 *  commas, trims, drops empties and unknown ids, dedupes, sorts. A non-string
 *  value or an all-unknown list resolves to []. */
function resolveDisabledRules(raw: Record<string, unknown>): string[];
```

- In `resolveThresholds`, set `disabledRules` from that helper **plus** the
  legacy fold-in of `mesh_issues_b7_enabled === 'false'` (§5.2). Keep
  `b7Enabled` exactly as it is.

### 9.7 `src/server/services/meshIssues/types.ts` (WP2)

```ts
/** Every issue type, as the canonical mute id. Derived so a new rule cannot
 *  be forgotten. */
export const MESH_ISSUE_RULE_IDS: readonly MeshIssueType[] =
  Object.values(MESH_ISSUE_TYPES);
```

### 9.8 `src/server/services/meshIssuesAnalysisService.ts` (WP2)

1. **The mute gate**, immediately after the three tiers contribute and before
   `skippedRules` is assembled (~line 468):

```ts
// Muted rules (mesh_issues_disabled_rules, §5.2) contribute no findings this
// run. Existing rows are NOT deleted — persistFindings' clean-run bookkeeping
// closes them after thresholds.autoCloseCleanRuns runs, exactly as the tier
// toggles already do.
const disabled = new Set(thresholds.disabledRules);
const kept = disabled.size === 0 ? findings : findings.filter((f) => !disabled.has(f.issueType));
```

Use `kept` for `persistFindings` and for `findingCount`.

2. **Per-type run outcome.** `persistFindings` already receives each upsert's
   `outcome`. Accumulate `newByType` / `reopenedByType` alongside the existing
   `newCount` / `reopenedCount` and return them on `MeshIssuesRunResult`
   (optional fields, §4.6).

3. Add each muted rule to `skippedRules` as
   `{ rule: ruleShortId, reason: 'muted in settings' }` so the coverage preface
   explains the silence — reusing the existing `RuleSkip` plumbing means the
   frontend needs no change for this.

### 9.9 `src/server/services/meshIssuesScheduler.ts` (WP2)

No behavioural change. `getStatus()` already resolves thresholds from
`MESH_ISSUE_THRESHOLD_SETTINGS_KEYS`, so `disabledRules` appears on `/status`
for free once §9.6 lands. Confirm no restart-on-save path exists (there is
none: the scheduler ticks every 60 s and reads settings per tick).

### 9.10 `src/components/MeshIssuesSection.tsx` (WP2)

- Replace the single `b7Enabled` checkbox with a per-rule mute list: 18 rows,
  grouped by tier, label from `ISSUE_TYPE_LABELS`, prefix from `ruleShortId`.
- One `local` state field replaces the `b7Enabled` pair:
  `const [localDisabledRules, setLocalDisabledRules] = useState<string[]>([])`.
- `applyStatus` seeds it from `data.thresholds.disabledRules`.
- `handleSave` replaces the `mesh_issues_b7_enabled` line with
  `...buildRuleMuteSettingsPatch(localDisabledRules)` — which writes both keys
  (§5.2). Update the dependency array accordingly (`localB7Enabled` →
  `localDisabledRules`).
- `resetChanges` mirrors the same field.
- Keep the tier toggles; add a note that a muted rule's open findings
  auto-close after `autoCloseRuns` runs rather than disappearing.

### 9.11 `src/components/Analysis/MeshIssuesReport.tsx` (WP4, then WP5)

Reduced to a shell:

- `useMeshIssuesViewState()` for filters/view/sort/expansion.
- `useQuery` for `/summary` (keyed on the server filter params) and the
  existing `useQuery` for `/status`. **The `useInfiniteQuery` over `GET /`
  moves down into `IssueTypeSection` / `NodeGroupSection`** — the shell no
  longer fetches findings at all.
- Keeps: `runNowMutation`, `dismissMutation`, `restoreMutation`,
  `runNowForbidden` / `actionsForbidden` / `canRunNow` / `canAct`,
  `isForbidden`, the header, the controls row, `CoveragePreface`, and the
  loading/error/empty banners.
- Adds `bulkDismissMutation`, `bulkRestoreMutation`, `muteRuleMutation`.
- Renders `<SummaryTiles>`, `<FilterBar>`, a view switch, and one of
  `<ByIssueView>` / `<ByNodeView>`.
- Deletes: `SeverityGroupSection`, `FindingCard`, `INFO_PAGE_SIZE`, the
  `groups` memo, the report-level "Load more" row.

---

## 10. Test plan

### 10.1 Pure unit tests (no DOM, fastest signal)

`meshIssues/issueColumns.test.ts`
- For each of the 18 `MESH_ISSUE_TYPES`: `columnsForType` returns ≥1 column,
  exactly one `primary`, unique keys.
- Every column survives `evidence: {}` — no throw, renders an em dash, sorts
  as `null`.
- Every column survives redaction (`nearestRouterName: null`,
  `coveredByName: null`).
- Ratio columns render `%` and sort on the raw ratio.
- `distanceM` renders km, sorts metres.
- B3's `weakerDirection` renders an endpoint name, never the literal `a->b`.
- `C1_time_offset` sorts by absolute offset; a negative offset renders signed.
- Unknown type → the §8.5 fallback; empty evidence → the synthetic primary.

`meshIssues/grouping.test.ts`
- Node ranking: severity beats count; count beats recency; `nodeNum` breaks
  ties deterministically.
- `nodeNum === null` findings land in the Mesh-wide group and appear **first**,
  regardless of their severity/count.
- No finding appears in two groups (the partition property that §4.4's
  node scope depends on).
- Filter predicate: each dimension independently; empty arrays mean "all";
  `q` matches `nodeName` and `subjectKey`, case-insensitively.
- Sort comparator: `null` last ascending **and** descending; stability;
  the `lastDetected`→`id` secondary key.

`src/server/services/meshIssues/thresholds.test.ts` (additions)
- CSV parse: whitespace, trailing commas, duplicates, unknown ids dropped.
- All-unknown → `[]`. Non-string → `[]`. Absent → `[]`.
- Legacy `mesh_issues_b7_enabled: 'false'` adds `B7_coverage_shadow` even when
  the CSV is empty; `'true'` does not remove it if the CSV names it.
- Result is sorted and deduped.

`src/server/routes/meshIssuesRoutes.test.ts` (additions to the existing suite)
- `buildSummary` as a pure function: type ordering, node ordering,
  `worstSeverity`, `issueTypes` ordering, the Mesh-wide bucket.

### 10.2 Route tests — `createRouteTestApp()` harness (mandatory)

Extend `src/server/routes/meshIssuesRoutes.test.ts`, which already uses the
harness with real session + real `requirePermission` + real SQL. Do not
introduce a `vi.mock` of `services/database.js`.

Filters:
- Each param narrows `issues`, `total` **and** `counts` together.
- Unknown tokens are dropped, not 400 (clamp-never-reject).
- `nodeNum=none` returns only `nodeNum IS NULL` rows.
- `q` matches on the resolved `nodeName` (not the raw row) and is
  case-insensitive.
- `sources` is intersected with the permitted set: a limited user passing a
  source they cannot read gets it dropped, never a 403.
- Filters compose with `limit`/`offset` and the sort stays deterministic.

Summary:
- Aggregates match a hand-computed fixture.
- Honours severity/tier/sources/`q`; **ignores** `issueType`/`nodeNum`.
- A limited user's summary counts only their visible findings.
- `403 NO_PERMITTED_SOURCES` for a user with no readable source.

Bulk (the important ones):
- Admin, `{scope:'issueType'}` → every finding of that type flips; `affected`
  equals the count.
- **Partial visibility:** seed 3 findings of one type — two on source A, one on
  source B only. A user permitted on A only calls bulk dismiss → `affected: 2`;
  the source-B row is still `dismissed: false` in the DB; the response contains
  **no** `skipped` field.
- `{scope:'node', nodeNum:null}` hits only `nodeNum IS NULL` rows.
- Idempotent: a second identical call returns `affected: 0`.
- Restore is the inverse and only touches `dismissed === true` rows.
- A user without `settings:write` gets 403 from `requirePermission`.
- A user with `settings:write` but no readable source gets
  `403 NO_PERMITTED_SOURCES`.
- `400 INVALID_BULK_SCOPE` / `400 INVALID_ISSUE_TYPE`.
- Audit row written with the right action and an `affected` count in
  `valueAfter`.

### 10.3 Repository tests — `src/db/repositories/meshIssues.test.ts`

`setDismissedForIds`: sets/clears `dismissedAt`/`dismissedBy`; leaves
`firstDetected`/`status`/`cleanRuns`/`closedAt` untouched; empty array is a
no-op returning 0; a >500-id list chunks correctly and returns the summed
count; the affected count is right on all three backends.

**This file has PostgreSQL and MySQL suites that `describe.skipIf` silently
when the containers are not up.** Bring them up before claiming this is
verified:

```bash
docker run -d --rm --name mm-test-pg -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=meshmonitor_test -p 5433:5432 postgres:16
docker run -d --rm --name mm-test-mysql -e MYSQL_ROOT_PASSWORD=root -e MYSQL_USER=test \
  -e MYSQL_PASSWORD=test -e MYSQL_DATABASE=meshmonitor_test -p 3307:3306 mysql:8.4
```

Confirm coverage via `numPendingTests` in the JSON reporter, not `success`.
No column is added to `nodes`, so the hand-written `POSTGRES_CREATE` /
`MYSQL_CREATE` blocks in `nodes.test.ts` do **not** need touching.

### 10.4 Analysis-service tests

`src/server/services/meshIssuesAnalysisService.test.ts`:
- A type in `disabledRules` produces zero findings of that type while every
  other type is unaffected.
- Muting one of `A2b`'s two types leaves the other firing (the reason the gate
  is per-issue-type, not per-rule-function).
- Muted types appear in `coverage.skippedRules`.
- A muted type's existing open row is **not** deleted; it accumulates
  `cleanRuns` and closes after `autoCloseCleanRuns` runs.
- `newByType` / `reopenedByType` match the aggregate `newCount` /
  `reopenedCount` for the same run.

### 10.5 Component tests (`@vitest-environment jsdom`)

Model on the existing `MeshIssuesReport.test.tsx` header — it already carries
the local `react-i18next` mock (the global mock's `t(key, options)` signature
does not understand this family's `t(key, default, options)` calls) and the
`../../services/api` mock that must keep `setBaseUrl: vi.fn()` because
`RouterClusterMap` pulls `BaseMap → TilesetSelector → SettingsContext → i18n →
init.ts`. Copy both into every new component test.

- `SummaryTiles.test.tsx` — one tile per type, worst-severity icon/colour,
  new/reopened chips present only when the run summary carries them, click sets
  the filter and `aria-pressed`, "All" tile clears.
- `IssueTypeSection.test.tsx` — collapsed by default; expands when
  `bySeverity.critical > 0`; the section query fires only on first expand;
  header sort toggles direction and re-orders; row click renders
  `FindingDetail` in a `colSpan` row; `aria-expanded` is on the button.
- `IssueTable.test.tsx` — column set switches with `issueType`; malformed
  evidence renders em dashes; the sources column is hidden with ≤1 source.
- `ByNodeView.test.tsx` — Mesh-wide group pinned first; worst-first ordering;
  badge row; expansion fetches by `nodeNum`.
- `FilterBar.test.tsx` + `useMeshIssuesViewState.test.ts` — round-trip to
  localStorage; corrupt JSON, wrong `version`, and unknown issue types in
  `expandedTypes` all fall back cleanly; a `localStorage.setItem` throw does
  not crash the component.
- `MuteRuleDialog.test.tsx` — shows the unfiltered open count; the copy names
  the auto-close run count; confirm posts **both** settings keys.
- `BulkActionMenu.test.tsx` — hidden when `!canAct`; confirm required;
  success invalidates issues + summary + status.
- `MeshIssuesReport.test.tsx` — rewritten for the shell: loading/error/empty,
  view switch, run-now, the 401/403 permanent-hide behaviour for both
  `run-now` and mutations. Existing assertions that no longer have a home
  (severity groups, `INFO_PAGE_SIZE`) move to the new component tests rather
  than being deleted.

### 10.6 Whole-suite gates

- Full Vitest run, 0 failures, before any PR. Judge by `success: true` in the
  JSON reporter, not an assertion count.
- `npm run lint:ci`, judged as
  `npm run lint:ci 2>&1 | grep '^FAIL' | grep -v '.claude/worktrees'` → empty.
  Do not grow any rule count in `eslint-baseline.json`. New components must not
  use raw `fetch()` (banned in `src/components/**`) — use `apiService` or a
  TanStack query hook.
- No system-test label needed: no device comms, no version bump.

---

## 11. Work packages

Five packages, dependency-ordered, with disjoint file ownership.

```
WP1 (server: read + mutate surface)  ─┐
WP2 (server: rules + settings)       ─┼─ parallel
WP3 (frontend: decomposition + pure) ─┘
                    │
                  WP4 (By-issue + dashboard + filters)
                    │
                  WP5 (By-node + bulk UI + mute UI)
```

WP1, WP2 and WP3 start together. WP3 depends only on the §4 frozen types,
which WP1 writes first — so **WP1 lands `meshIssueTypes.ts` before anything
else**, ideally as its first commit, and WP3 branches from it. WP4 needs WP1's
endpoints and WP3's components. WP5 needs WP2's settings surface and WP4's
shell.

### WP1 — Server read + mutate surface

**Owns:** `src/server/routes/meshIssuesRoutes.ts`,
`src/db/repositories/meshIssues.ts`, `src/services/database.ts` (one method),
`src/components/Analysis/meshIssueTypes.ts`,
`src/server/routes/meshIssuesRoutes.test.ts`,
`src/db/repositories/meshIssues.test.ts`.

**Does:** §4.1 filters on `GET /`; §4.3 `GET /summary`; §4.4 bulk routes;
§9.2 `setDismissedForIds`; §9.3 facade; §9.4 wire types (including the
`disabledRules` and `newByType`/`reopenedByType` declarations WP2 will
populate, so no one else edits this file).

**Acceptance:**
- `GET /?severity=warning&tier=B` narrows `issues`, `counts` and `total`
  together; an unknown token is dropped, never a 400.
- `GET /summary` on the dev DB returns 18 `byType` entries and a `byNode` list
  whose first entry is the Mesh-wide group, with **no `evidence` anywhere in
  the payload**.
- Bulk dismiss by `issueType` on the dev DB flips every visible finding of that
  type in one call and audit-logs the count.
- The partial-visibility route test of §10.2 passes and the response has no
  `skipped` field.
- Repository tests green on SQLite **and** PostgreSQL **and** MySQL with the
  containers up (`numPendingTests` confirms they ran).
- `GET /`'s response shape is byte-for-byte unchanged for a request with no new
  params — the existing suite passes untouched.

### WP2 — Rule mute + per-type run outcome

**Owns:** `src/server/constants/settings.ts`,
`src/server/services/meshIssues/thresholds.ts` (+ its test),
`src/server/services/meshIssues/types.ts`,
`src/server/services/meshIssuesAnalysisService.ts` (+ its test),
`src/components/MeshIssuesSection.tsx` (+ its test),
`src/components/Analysis/meshIssueRuleIds.ts` (new),
`docs/features/mesh-issues.md`.

**Does:** §9.5–§9.10.

**Acceptance:**
- `mesh_issues_disabled_rules` saves and survives a reload (proving both
  registry entries are present).
- `resolveThresholds` drops unknown ids silently and folds in the legacy
  `mesh_issues_b7_enabled === 'false'`.
- Muting a type stops it being emitted; its existing rows are untouched on the
  next run and close after `autoCloseCleanRuns`.
- Muting `A2b_congested_area` leaves `A2b_congested_node` firing.
- Un-muting B7 through the settings section actually un-mutes it — i.e. the
  save wrote `mesh_issues_b7_enabled: 'true'` as well (§5.2 trap).
- `/status.thresholds.disabledRules` reflects the saved value.
- `lastRunResult.newByType` sums to `newCount`.
- `docs/features/mesh-issues.md` gains a "muting a rule" section stating the
  auto-close behaviour.

### WP3 — Frontend decomposition + pure logic

**Owns:** `src/components/Analysis/meshIssues/**` (creates the directory),
the move of `MeshIssuesReport.module.css` → `meshIssues/meshIssues.module.css`,
and the import updates that move forces in `MeshIssuesReport.tsx`.
**Must not edit** `meshIssueTypes.ts`.

**Does:** move `CoveragePreface`, the evidence renderers, `FindingDetail`,
`SortableTh` (promoted from `MqttViolationsReport.tsx`) — all **verbatim**;
write `issueColumns.ts`, `grouping.ts`, `useMeshIssuesViewState.ts` and their
three unit-test files. `MeshIssuesReport.tsx` is left functionally identical,
just importing from the new locations.

**Acceptance:**
- `MeshIssuesReport.test.tsx` passes **unchanged** — this package is a
  refactor and must be behaviour-preserving.
- The three new unit-test files cover every assertion in §10.1.
- No new lint-baseline entries; no new raw `fetch()`.
- Zero diff in the moved components beyond import paths and the `export`
  keyword.

### WP4 — Dashboard, filters, By-issue view

**Owns:** `meshIssues/SummaryTiles.tsx`, `FilterBar.tsx`, `ByIssueView.tsx`,
`IssueTypeSection.tsx`, `IssueTable.tsx`, their `.module.css` files and tests;
the rewrite of `src/components/Analysis/MeshIssuesReport.tsx` (§9.11) and its
test.

**Depends on:** WP1 (endpoints + types), WP3 (columns, state hook, detail
component).

**Acceptance:**
- On the dev DB the initial load issues exactly two requests (`/summary`,
  `/status`) and **no** findings request; the DOM contains no finding rows
  until a section is expanded.
- Every one of the 18 types renders its §8.2 columns; expanding the 582-row B7
  section is a single request and sorts by distance without a second one.
- Sorting by a type-specific column reorders the whole group and persists
  across a reload.
- Filters narrow both the tiles and the sections; a tile click filters and
  auto-expands.
- Browser-validated screenshot attached to the PR (UI change).

### WP5 — By-node view, bulk actions, mute UI

**Owns:** `meshIssues/ByNodeView.tsx`, `NodeGroupSection.tsx`,
`BulkActionMenu.tsx`, `MuteRuleDialog.tsx` and their tests; the small wiring
edits in `MeshIssuesReport.tsx` (view switch + the three new mutations).

**Depends on:** WP4 (shell), WP1 (bulk endpoints), WP2 (`disabledRules` on
`/status`, `buildRuleMuteSettingsPatch`).

**Acceptance:**
- By-node ranks worst-first with the Mesh-wide group pinned first; a node's
  badge row lists its distinct types.
- Bulk dismiss from a type header and from a node row both work against the
  live dev DB, show the confirm first, and refresh tiles + sections + status.
- Mute shows the unfiltered open count and the auto-close wording, writes both
  settings keys, and the muted type shows a muted marker afterwards.
- Bulk/mute controls are absent for a user without `settings:write`.
- Browser-validated screenshot attached to the PR.

---

## 12. Weakened / deferred, with justification

1. **Bulk scope is type-or-node, not "everything matching my filters."**
   Rejected because a confirm dialog cannot honestly describe an arbitrary
   filter combination, and because a filter-scoped mutation resolved on the
   server would silently include rows the user never saw (they were on a page
   they did not load). The two offered scopes cover the real workflows.

2. **`skipped` is not reported by bulk operations.** A count of findings the
   caller cannot see is itself a disclosure (#3745 leak class). The user is
   told what they changed, not what exists beyond their permissions. Consistent
   with the single-finding routes' 404-not-403 choice.

3. **Per-finding "reopened" badges are not available — only per-type,
   per-run.** There is no `reopenedAt` column and §5.3 declines to add one. The
   dashboard tile and the section header get "N reopened this run" from the
   persisted run summary; individual rows get only a "New" chip (derivable from
   `firstDetected >= lastRunTime`). Adding the column later is a
   straightforward migration if the coarse signal proves insufficient.

4. **The node-name filter (`q`) does not match names embedded inside
   evidence.** Searching for a node will not surface the `B1_router_cluster`
   finding it is a member of, or the `B3_asymmetric_link` it is an endpoint of
   when the finding is attributed to the other end. Doing so would mean
   rule-specific evidence traversal inside the route's filter, on top of
   per-caller redaction. Deferred; the Mesh-wide group is pinned and the
   By-issue view remains the way to find these. Worth revisiting if users
   report it.

5. **Muted rules still execute.** The gate filters emitted findings rather than
   skipping rule evaluation (§5.2). In-memory CPU only — no radio, no I/O
   beyond what the run already does. Chosen for exactness across the
   many-types-per-rule cases and for a one-line, low-risk diff.

6. **Sorting degrades above 2000 findings of a single type.** The section falls
   back to "Load more" and sorts only loaded rows, with a visible note.
   Unreachable on a realistic mesh (§5.1); the code says so rather than
   pretending otherwise.

7. **No `critical` findings exist today**, so "collapsed unless critical"
   means "always collapsed" in practice. Correct behaviour for 1,000+
   findings; called out in §6.2 so it is not mistaken for a broken rule.

8. **`/status.lastRunResult` remains a cross-source aggregate.** The two new
   per-type fields inherit that pre-existing property rather than fixing it
   (§4.6). Out of scope; the chip copy is worded to match ("this run", not
   "in your view").

---

## 13. Veto candidates (flagged for the user, not decided here)

These are the calls most worth overruling. Each is isolated enough to change
without disturbing the rest of the spec.

- **V1 — Keeping wire pagination (§5.1).** The alternative is "fetch all,
  handle client-side", which is simpler to implement and removes the
  per-section request. It costs a ~1–2 MB first payload and throws away the
  recently-shipped pagination win. Overruling this collapses WP1's filter work
  and simplifies WP4 noticeably.
- **V2 — One CSV settings key vs. 18 boolean keys (§5.2).** Eighteen keys are
  more discoverable in the settings table and need no parser, at the cost of
  ~130 hand-maintained lines and a permanent per-rule tax.
- **V3 — Mesh-wide pseudo-group vs. attaching to member nodes (§6.3).** If
  discoverability from a node's perspective matters more than ranking
  correctness, the attachment model can be built — but §4.4's node scope stops
  being a partition and must then become "dismiss only findings solely
  attributed to this node".
- **V4 — Bulk scope excludes the active filters (§12.1).** If operators
  actually want "dismiss everything I'm currently looking at", the scope type
  can carry the full `IssueFilterSpec` instead. The confirm-dialog wording
  problem is the reason it does not today.
- **V5 — No `reopenedAt` column (§5.3, §12.3).** A per-finding reopened badge
  is genuinely useful on a health dashboard. One migration across three
  backends buys it.
