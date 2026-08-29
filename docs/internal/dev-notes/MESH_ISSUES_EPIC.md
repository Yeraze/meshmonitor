# Mesh Issues Analysis — Epic Plan

**Epic issue:** #4964
**Status:** Phase 1 in progress
**Owner decisions recorded:** 2026-08-28 (interview happened in the design conversation; user approved the phase plan and said "go straight into Phase 1")

## Goal

A scheduled analysis + Reports-workspace report that flags mesh health issues from
**passively collected data only** (zero mesh traffic): wrongly-roled or poorly placed
ROUTERs/REPEATERs, airtime abusers, and nodes that should move to CLIENT_BASE /
ROUTER_LATE. Data pools across ALL Meshtastic sources including MQTT.

## Locked decisions

- **Passive only.** No traceroute generation, no remote LocalStats polling in this epic.
  (An opt-in "deep probe" of flagged nodes is explicitly out of scope; it would need the
  mesh-impact checklist and user sign-off.)
- **Cross-source pooling by physical `nodeNum`** (precedent: `estimated_positions` /
  `positionEstimationService`). Findings are global, with per-source evidence.
- **Packet dedup by `(packetId, fromNode)`** before any rate metric — the same packet can
  land via TCP plus N MQTT gateway rows.
- **RF topology comes only from RF observations.** MQTT-transport hops are excluded;
  MQTT *gateway receptions* (`mqtt_packet_log.rxSnr/hopStart/hopLimit/gatewayNodeNum`)
  count as RF observations at the gateway's antenna.
- **Hop-delta guards:** `hopStart − hopLimit` is a lower bound (2.7+ zero-cost
  favorite-router hops skip the decrement); `hopStart == 0` means unknown, never direct.
- **Thresholds:** only ChUtil > 25% / AirUtilTX > 7-8% are official (ROUTER_LATE blog).
  Every other threshold is ours — labeled `[ours]` in code/UI and tunable.
- **Recommendation language follows official guidance.** Never "promote to ROUTER".
  Suggest CLIENT_BASE, ROUTER_LATE, or "deploy another CLIENT nearby".
- **Traceroute corpus:** 7-day lookback (clamp 1–30 d) → validity filter
  (`hasRouteData`, no BROADCAST_ADDR/invalid nodes, no self-traces) → exact dedup by
  `(packetId, fromNodeNum)` keeping the most complete copy (routeBack > SNR arrays >
  newest) → stratified cap: 1 traceroute per (unordered pair, 6 h bucket). Downstream
  stats count **distinct pairs**, not raw samples. Directional SNR rules need ≥3 samples
  per direction. No recency decay (the cap already flattens frequency bias).
- **Edge graph is computed in memory per run** — no persisted edge-stats table.
- **One new table `mesh_issues`** (global, keyed by physical nodeNum — no `sourceId`
  column, cross-source-by-design like `estimated_positions`): issue type, severity,
  confidence, evidence JSON, source list, firstDetected/lastDetected, dismissed flag.
  Findings persist across runs: re-detection updates `lastDetected`; auto-close after N
  consecutive clean runs (default 3) rather than delete.
- **Scheduler:** `positionEstimationScheduler` pattern — 60 s tick, `isRunDue` pure
  function, last-run persisted in settings. Default cadence 24 h.
- **Settings keys (server snake_case scheduler convention):**
  `mesh_issues_enabled` (default ON), `mesh_issues_frequency_hours` (24),
  `mesh_issues_lookback_hours` (168, clamp 24–720),
  `mesh_issues_pair_bucket_hours` (6, clamp 1–24), `mesh_issues_last_run`,
  plus per-rule threshold keys added as rules land.
- **UI:** new report card in the Reports workspace (`AnalysisTab.tsx`), pattern-matched
  to `SolarMonitoringReport`. CSS via module or `analysis-reports.css` conventions.

## Heuristic spec

### Tier A (Phase 1)

| ID | Rule | Threshold | Guards |
|----|------|-----------|--------|
| A1 | Deprecated role in use (REPEATER=4, ROUTER_CLIENT=3) | — | note NodeInfo age in evidence |
| A2a | Chatty node: mean `airUtilTx` > 8% over 24 h, ≥6 samples | [official] | node-attributed; self-reported metric, newest per timestamp |
| A2b | Congested area: ≥3 nodes in a geographic cluster with mean `channelUtilization` > 25% | [official] | attributed to the AREA, not a node; single node = info |
| A3 | Infra role on failing power: battery ≠ 101 AND (≥2 uptime resets in 7 d OR battery < 20%) | [ours] | solar cycles battery% but stays up — require resets/deep discharge; battery-only clean-uptime = info |
| A4 | Mobile node with infra role | 500 m [ours] | reuse `nodeMobilityService` classification (handles precision truncation) |
| A5 | Cosplay router: ROUTER with `isUnmessagable=false` OR unsolicited-telemetry median interval ≪ 12 h (< 2 h) | [ours], low confidence | MUST exclude telemetry MeshMonitor solicited; if not separable, fire only on `isUnmessagable` clause |

### Tier B (Phase 2) — RF adjacency graph

Adjacency union: (1) `neighbor_info` edges, (2) adjacent pairs in traceroute
`route`/`routeBack` from RF sources, (3) co-direct-reception: two nodes both heard with
`hopLimit == hopStart`, `hopStart > 0` at the same MQTT gateway in-window.

| ID | Rule | Threshold | Guards |
|----|------|-----------|--------|
| B1 | Router cluster: ≥2 ROUTER/REPEATER mutually audible | — | severity scales with cluster size; rec: demote all but best-sited to ROUTER_LATE |
| B2 | Redundant router: neighbor set ⊆ another router's | 90% overlap, both ≥3 known [ours] | skip on sparse adjacency data |
| B3 | Asymmetric link: directional SNR delta > 6 dB (snr ÷ 4, drop −32 sentinel), ≥3 samples/direction | [ours] | flag the EDGE; attach to endpoint only if infra role |
| B4 | Idle router: heard direct but < 1% hop share while peers > 10% | [ours] | INFO severity only; needs ≥20 in-window traceroutes bracketing its area |
| B5 | Load-bearing CLIENT: intermediate hop in ≥10 traceroutes and ≥25% of area paths | [ours] | rec: CLIENT_BASE if fixed+powered, else "another CLIENT nearby" — never ROUTER |
| B6 | Hop horizon: > 50% of deduped packets arrive with hopLimit = 0 | [ours] | zero-cost hops → underflags (acceptable); cluster behind B1 finding ⇒ cite hop gobbling |
| B7 | Coverage shadow: node heard only via MQTT within estimated RF range of an RF-heard router | via `rf/propagation.ts` [ours] | INFO; needs positions both ends; skip precision-truncated |

### Tier C (Phase 3)

- C1 Fold in existing flags as report rows: `isExcessivePackets` (dedup-corrected),
  key security flags, time offset.
- C2 Over-broadcasting config: non-TRACKER/SENSOR with deduped position/telemetry median
  interval < 5 min [ours].
- C3 Data-coverage preface (report header, not a finding): NeighborInfo edge count,
  traceroute counts ("N → M after dedup → K sampled, P distinct pairs"), packet log
  on/off, MQTT packet log on/off, % nodes with position — with per-rule degradation notes.

### Excluded by design

`relay_node` identity assertions (8-bit, ambiguous — evidence garnish only); remote
LocalStats polling; "promote to ROUTER" recommendations.

## Phases

- [x] **Phase 1 — Foundation + Tier A.** Migration for `mesh_issues` (3 backends),
  traceroute corpus sampler (dedup + stratified cap), pooled node/telemetry snapshot
  builder, scheduler + service, rules A1–A5, findings repository, API route
  (envelope + `requirePermission`), minimal Reports card listing findings by severity.
  Exit: full suite green incl. PG/MySQL, report renders findings from live dev DB, PR
  merged.
- [ ] **Phase 2 — Tier B.** RF adjacency union (3 evidence classes), per-edge directional
  SNR stats, rules B1–B7, evidence rendering in the report. Exit: suite green,
  graph rules validated against dev DB, PR merged.
- [ ] **Phase 3 — Polish.** Coverage preface, dismiss/acknowledge + auto-close, Tier C
  fold-ins, threshold settings UI (SettingsDraft + VALID_SETTINGS_KEYS), user docs.
  Exit: suite green, browser-validated end-to-end, docs updated, PR merged.

## Phase log

### Phase 1
- 2026-08-28: worktree `../meshmonitor-mesh-issues-p1` (`feature/mesh-issues-analysis-phase1`), epic issue #4964 filed.
- 2026-08-28: implementation complete. Spec: `MESH_ISSUES_P1_SPEC.md` (§5 lists 16
  spec-level decisions). 5 work packages (WP1 data layer, WP2 pure analysis core,
  WP3 service/scheduler, WP4 routes, WP5 Reports card). Full suite 17502/17502
  green incl. PG/MySQL containers.
- Review findings fixed: A2b per-node fallback deliberately broadened beyond the
  spec's literal gate (documented + tested); `nodeName` on GET now resolves only
  from the caller's permitted sources (#3745 class); `mesh_issues` added to
  migrate-db `TABLE_ORDER`; `/analysis/mesh-issues` must mount BEFORE the general
  `/analysis` router (found in live-container validation — the isolated route
  harness cannot catch mount-order bugs).
- Browser-validated against live dev DB: 11 real findings (9× A1 deprecated
  ROUTER_CLIENT, 1× A3 resets clause, 1× A2b congested node), run-now cycle works,
  console clean.
- Phase 3 polish backlog from validation: format `lastHeardAgeMs` as a duration
  (raw ms renders poorly), map source UUIDs to source names in the evidence pills.
- Merged as PR #4966 (squash 29049f05) on 2026-08-28.

### Phase 2
- 2026-08-28: worktree `../meshmonitor-mesh-issues-p2` (`feature/mesh-issues-analysis-phase2`).
  Spec: `MESH_ISSUES_P2_SPEC.md` (decisions D1–D14; B7 uses the observed-range
  estimator, NOT `rf/propagation.ts` — full DEM link budget would rest on invented
  RF parameters).
- Implementation: WP1 tracerouteSegments extraction (`buildLegHopLinks`) + B1–B7
  types/subject keys + shared `ruleRunner`; WP2 packet-log aggregates (direct
  receptions per gateway, hop-arrival counts with MAX(hopLimit) dedup); WP3
  `rfGraph.ts` (3 evidence classes, direct vs inferred); WP4 `rulesTierB.ts`;
  WP5a service integration + coverage counters; WP5b report rendering for
  edge/cluster/SNR evidence.
- Full suite 17670/17670 green incl. PG/MySQL. Review pass: one gap (spec §4.7
  route tests for `nodeNum: null` wire shape) fixed post-review.
- Phase 3 backlog additions: truncation note has no "+N" count (no total-count
  field in capped evidence lists); evidence node names not redacted per-source
  inside evidence JSON (D12, deliberate deferral).

### Phase 3
- 2026-08-28: worktree `../meshmonitor-mesh-issues-p3`
  (`feature/mesh-issues-analysis-phase3`). Spec: `MESH_ISSUES_P3_SPEC.md`
  (decisions P3-D1..P3-D12). No new migration: `mesh_issues` already carries the
  dismiss columns and Tier C only adds new `issueType` string values.
- Scope: C3 coverage preface, dismiss/restore routes + UI, Tier C (C1 fold-ins,
  C2 over-broadcasting), 10 new settings keys with a read-time clamped
  `resolveThresholds` seam, the full UI polish backlog from both phase logs, a
  `docs/features/mesh-issues.md` user page, and D12 implemented (evidence-level
  redaction) rather than accepted.
- Notifications stay out of scope (P1 §5.11): recorded as a post-epic follow-up.
- WP5 (settings section + docs, depends only on WP1) delivered: new
  `MeshIssuesSection.tsx` modeled on `PositionEstimationSection.tsx` (own
  state, `useSaveBar`, plain `POST /api/settings`, status from
  `GET /api/analysis/mesh-issues/status`), wired into `SettingsTab.tsx`
  (`GLOBAL_SECTIONS`, nav array, render site — same three sites as position
  estimation), a component test, and the `docs/features/mesh-issues.md` user
  page (all 18 rule rows, the passive guarantee, threshold provenance table,
  acting-on-findings guidance, and the C1/Security-tab overlap note), plus
  the VitePress sidebar entry and an `analysis-reports.md` cross-link. Landed
  independently of WP2/WP3/WP4 (Tier C, dismiss/redaction routes, report UI),
  which were still in flight in this worktree at the time — the Phase 3
  checkbox above stays unticked until all five work packages and the
  phase-exit checklist (full suite incl. PG/MySQL, `lint:ci`, browser
  validation) are done.
