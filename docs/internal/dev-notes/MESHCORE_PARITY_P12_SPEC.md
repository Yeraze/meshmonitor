# MeshCore Parity follow-up — Mesh Issues: protocol-neutral node-health rules (#6279)

## Maintainer decisions (2026-11-09, binding)
All recommended options accepted: infra nodes only; stale 24 h Meshtastic / 96 h MeshCore (tunable); stop flagging after 30 days; low battery 20 % / 3300 mV; a position override suppresses A7; A8 skips nodes whose A3 battery clause fires; A9 accepted as mostly firing with discard off; A6–A9 in Tier A. No RF, no notifications.


Part of the parity epic (`MESHCORE_PARITY_EPIC.md`, split from P6 #6263). Base: `main` @ 4402509fe (includes P6 S5 `PooledNode` adapter and P11). Paths are relative to `/home/yeraze/Development/meshmonitor/src/`. Epic rule: **one shared configurable implementation**. Every new rule in this spec runs on both protocols through `PooledNode`. Each MeshCore-only or Meshtastic-only branch below states its reason.

## Findings (evidence)

**Rule engine**
- Rule ids are `server/services/meshIssues/types.ts:14-37`. The mute allowlist is derived from them (`:44`). There are no stale, no-position, low-battery or bad-position rules today.
- `ruleRunner.ts:33-49`: a rule with no `protocols` declaration defaults to `['meshtastic']` (`:42`).
- Tier A list is `rules.ts:504-511`. `A3` and `A4` are `BOTH_PROTOCOLS`. The protocol narrowing is `nodesForProtocols` (`nodeSnapshot.ts:162-177`).
- `rules.ts` must hold no numeric literal thresholds (header `:9-12`). Recommendations must never say "promote" or suggest ROUTER, and a cross-rule test enforces this.

**Pooled node shape**
- `nodeSnapshot.ts:65-123` defines `PooledNode`. It already has `protocol`, `nodeKey`, `infra`, `advType` and `lastHeardMs`.
- Helpers: `isInfraNode` (`:139`), `subjectKeyFor` (`:148`), `persistedNodeNum` (`:154`).
- Freshness: Meshtastic `lastHeard` is in seconds and is normalised to ms below 1e12 (`:179-189`). It falls back to `updatedAt`. Pooled `lastHeardMs` is the MAX across a node's rows (`:309`).
- Position is taken as one **override-aware** pair from the freshest row (`:217-221`, `:272`), using `getEffectiveDbNodePosition` (`server/utils/nodeEnhancer.ts:52-78`). The raw reported position and the "override present" fact are lost.
- `positionPrecisionBits` is the MIN across rows (`:306`).
- Telemetry series hold only `airUtilTx`, `channelUtilization`, `batteryLevel` and `uptimeSeconds` (`:334-346`).

**MeshCore snapshot**
- `meshcoreSnapshot.ts:89-158`: `lastHeard` is treated as ms, with a seconds guard (`:75-82`).
- `batteryLevel`, `voltage` and `positionPrecisionBits` are hard-coded `null` (`:136-142`).
- The input (`:53-65`) carries no `lastAdvertHadPosition`, `isLocalNode` or `batteryMv`.
- The uptime series adapter (`:173-190`) reuses `buildTelemetrySeries`.

**MeshCore data**
- `db/schema/meshcoreNodes.ts` has `batteryMv` (latest only, with no reading timestamp), `lastAdvertHadPosition`, `positionOverrideEnabled`/`positionOverrideIsPrivate` and `isLocalNode`.
- `lastHeard` is the companion's `last_mod` (seconds → ms), clamped to now (`server/meshcoreManager.ts:6040-6066`). `lastAdvertHadPosition` is set at `:6061`.
- Battery telemetry is written in two forms:
  - Local companion: `mc_battery_mv` (mV) plus `mc_battery_volts` (`services/meshcoreTelemetryPoller.ts:275-280`).
  - Remote repeater/room server: `mc_status_battery_volts` (V) (`services/meshcoreRemoteTelemetryScheduler.ts:613`).
  - The unit split is documented at `services/meshcoreDeviceHealth.ts:110-121`.
- The powered heuristic is `isPoweredMv` at ≥4200 mV (`server/utils/poweredState.ts:81-93`). Meshtastic uses `isPowered` (batteryLevel >100, `:34`).
- Repeater firmware default `flood.advert.interval` is 47 h (P9 spec line 32, `RM:905`). For a far repeater, `lastHeard` only moves on adverts, telemetry or status replies.

**Low-battery precedent**
- `services/lowBatteryNotificationService.ts:63-64` defaults to **20 %** (Meshtastic) and **3300 mV** (MeshCore).
- Meshtastic query: `lt(batteryLevel, threshold)` and `lt(batteryLevel, 101)` (`db/repositories/nodes.ts:2424-2426`).
- MeshCore query: `batteryMv >= 1` and `< threshold` (`db/repositories/meshcore.ts:1648-1649`).
- Existing A3 battery clause: infra only, min batteryLevel < `BATTERY_LOW_PCT` (20, `thresholds.ts:38`), ≥3 samples, over 168 h, Meshtastic only (`rules.ts:317,328-337`).

**Bad position**
- `utils/nullIsland.ts:120-127` `isBogusPosition(lat, lon, precisionBits?)` = out of WGS-84 range or Null Island, precision-offset aware.
- Ingest already drops bogus fixes:
  - Out-of-range is always dropped. Null Island is dropped only while `discardInvalidPositions` is on (`shouldDiscardPosition` `:144-153`; callers `meshtasticManager.ts:8486`, `mqttIngestion.ts:503`, `db/repositories/meshcore.ts:738`).
  - MeshCore `persistContact` drops bogus fixes **unconditionally** (`meshcoreManager.ts:3976-3988`).
  - Result: a stored bogus position exists only for legacy rows, or when an operator turned discard off. The setting's stated purpose is to let operators *see* which nodes transmit (0,0).
- `A2b` already skips bogus pairs (`rules.ts:205`).

**Service**
- `services/meshIssuesAnalysisService.ts` has two paths:
  - Full path: node mapping `:296-332`, telemetry `:336-348`, MeshCore merge `:510-513`, Tier A ctx `:520-528`, mutes `:556-561`, skips `:563`.
  - MeshCore-only path: `:613-664`.
- `loadMeshcoreInputs` (`:672-748`): row map `:686-700`; a single uptime telemetry query `:711-723`.
- `resolveLocalNodeSources` (`:481`) already identifies Meshtastic local nodes.

**Thresholds**
- `thresholds.ts:216-242` (resolved shape), `:244-257` (defaults), `:265-278` (key list), `:338-410` (clamp-never-reject resolve).
- Keys are allowlisted in `server/constants/settings.ts:223-249` (valid keys) and `:967+` (global).
- UI: `components/MeshIssuesSection.tsx` (state `:105-142`, save patch `:230-248`, Thresholds block `:583-712`). It is one global section in `SettingsTab.tsx:3633`, gated on `canWriteSettings`. It is already shared by both protocols.

**Frontend registries**
- `components/Analysis/meshIssueRuleIds.ts:19-38`. `tierOfRule` uses the first letter. `meshIssueRuleIds.test.ts:17-18,46-49` asserts 18 rules.
- `meshIssueTypes.ts:120` (thresholds wire), `:282` (labels), `:304` (blurbs).
- `meshIssues/issueColumns.ts:347+` (per-type columns). Evidence keys ending in `AgeMs` auto-format as durations.

**Permissions**
- Read routes resolve permitted sources with resource `nodes` (`routes/meshIssuesRoutes.ts:767,820`).
- Evidence `sources`/`sourceIds` are intersected. A MeshCore `nodeName` is nulled when any contributing source is hidden (`:162-183`).
- Run-now, dismiss and restore require `settings:write` (`:886,986-1019`).
- Positions elsewhere need `nodes:viewOnMap`. Mesh Issues evidence has no such gate.

## Design

### Shared pieces (named first)
| ID | Piece | Used by |
|---|---|---|
| H1 | **`PooledNode` additions** (`nodeSnapshot.ts`), set by both snapshot builders. `reportedPosition: 'none' \| 'valid' \| 'bogus'` comes from the freshest row that has a raw (non-override) pair, via a new `classifyReportedPosition(lat, lon, precisionBits)` that wraps `isBogusPosition`. Also `hasPositionOverride: boolean` (any row), `advertHadPosition: boolean \| null` (MeshCore `lastAdvertHadPosition`, freshest non-null; null for Meshtastic), `isLocal: boolean`. Existing fields and their merges are unchanged. | A6, A7, A9 |
| H2 | **`NodeTelemetrySeries.batteryMv`** (new series, always mV). The MeshCore adapter `buildMeshCoreTelemetrySeries(rows, handleByKey)` replaces `buildMeshCoreUptimeSeries`, keeping it as a thin wrapper for existing tests. It maps `mc_status_uptime_secs` → `uptimeSeconds` (×1), `mc_battery_mv` → `batteryMv` (×1) and `mc_status_battery_volts` → `batteryMv` (×1000). Cross-source dedup is the existing one. Meshtastic keeps `batteryLevel` (%). | A8 |
| H3 | **`meshIssues/nodeHealth.ts`** (new, pure). See the list after this table. | A3, A6–A9 |
| H4 | **Thresholds**: new tunables in `ResolvedMeshIssueThresholds` and keys in `MESH_ISSUE_THRESHOLD_SETTINGS_KEYS`. See the list after this table. | rules, UI |
| H5 | **Tier A skips**: `tierASkips(ctx)` returns `RuleSkip[]`, mirroring `tierCSkips`. Cases: "A6: n node(s) skipped, source(s) silent" and "A8: no battery telemetry in window". Appended in both service paths. | coverage preface |

H3 helpers:
- `batteryReading(node, series, windowStart)` returns `{unit:'pct'|'mv', latest, latestTs, samples, sources} | null`. Meshtastic reads `series.batteryLevel` and returns null if latest is powered (101), or if latest is 0 and `node.voltage` is null or 0 (no battery ADC). MeshCore reads `series.batteryMv` and returns null when the latest value is ≤0.
- `isBatteryLow(reading, t)`: pct < `t.lowBatteryPct`; mv < `t.lowBatteryMv`.
- `staleHoursFor(node, t)`.
- `buildSourceLiveness(rows, isLocalRow)` returns `Map<sourceId, maxHeardMs>` over non-local rows of both protocols.
- `infraBatteryDischarging(node, series, windowStart, t)`: the A3 battery clause extracted unchanged, now reading `t.lowBatteryPct`.

H4 tunables (clamp, never reject):

| Key | Default | Range |
|---|---|---|
| `staleHoursMeshtastic` | 24 | 2–720 |
| `staleHoursMeshcore` | 96 | 12–720 |
| `lowBatteryPct` | 20 | 1–80 |
| `lowBatteryMv` | 3300 | 2500–4100 |

New code constants:
- `STALE_MAX_AGE_DAYS = 30` [ours]: beyond this a node counts as decommissioned, not stale.
- `BATTERY_CONFIRM_SAMPLES = 3` [ours].
- A3 switches from the `BATTERY_LOW_PCT` constant to `t.lowBatteryPct`. At the default this changes nothing.

`RuleContext` gains `sourceLastHeardMs: Map<string, number>`. Both service paths build the Tier A ctx through one private `buildTierAContext(...)` so the MeshCore-only path cannot drift.

### Rules (new `meshIssues/rulesNodeHealth.ts`, registered in Tier A `ALL_RULES` with `BOTH_PROTOCOLS`)
Ids, all ≤64 chars: `A6_stale_node`, `A7_no_position`, `A8_low_battery`, `A9_bad_position`.

They sit in Tier A ("Node health"). The tier A toggle, per-rule mute, auto-close and subjectKey (`subjectKeyFor`/`persistedNodeNum`) all apply unchanged.

Default scope for all four is `isInfraNode(node)`: Meshtastic `INFRA_ROLES`, MeshCore advType 2/3. The local node is excluded from A6.

- **A6 stale node**
  - Condition: `age = now − lastHeardMs`, and `staleHoursFor(node) < age ≤ STALE_MAX_AGE_DAYS`.
  - Skip when `lastHeardMs` is null or in the future.
  - **Liveness guard:** at least one of `node.sourceIds` must have heard something within the same stale window. Otherwise skip and count it in H5, so a disconnected radio does not mark every node stale.
  - Severity warning, confidence medium.
  - Evidence: `lastHeardAgeMs`, `thresholdHours`, `roleName`, `aliveSources`, `sources`.
  - Recommendation: "Not heard for over N h. Check power and antenna; dismiss if it was retired." The MeshCore text adds: "If its flood-advert interval is longer than the stale window, raise the window." It must never advise advertising more often.
  - Why per-protocol hours: MeshCore far repeaters only refresh `lastHeard` on flood adverts (47 h firmware default). Meshtastic NodeInfo defaults to about 3 h.
- **A7 no position**
  - Fires when `reportedPosition === 'none'` and `!hasPositionOverride`.
  - Clauses:
    - `no_position`
    - `position_sharing_disabled` (Meshtastic, `positionPrecisionBits === 0`). Meshtastic-only because the concept only exists there.
    - `advert_without_position` (MeshCore, `advertHadPosition === false` with stored coordinates). MeshCore-only because the firmware keeps the old fix, #5578. This clause fires even though `reportedPosition` is 'valid'.
  - Severity info. Confidence high (medium for the advert clause).
  - Recommendation (Meshtastic): set a fixed position, or enable position sharing at reduced precision.
  - Recommendation (MeshCore): set lat/lon on the repeater (Repeater settings or CLI).
- **A8 low battery**
  - `r = batteryReading(...)` in the lookback window. Fires when `isBatteryLow(r)` and `!infraBatteryDischarging(...)`, so A3 keeps ownership of infra nodes whose battery clause already fires and the node shows once.
  - Severity warning. Confidence high when the last `BATTERY_CONFIRM_SAMPLES` samples are all low, else low.
  - Evidence: `latestBatteryPct` or `latestBatteryMv` (the other is null), `latestReadingAgeMs`, `sampleCount`, `thresholdUsed`, `unit`, `roleName`, `sources` (from samples).
  - Uses telemetry series, not node-row values, because `meshcore_nodes.batteryMv` and Meshtastic `batteryLevel` have no reading timestamp and could be weeks old.
- **A9 bad position**
  - Fires when `reportedPosition === 'bogus'` (raw reported pair; overrides ignored).
  - Evidence: `positionIssue: 'null_island' | 'out_of_range'`, `positionPrecisionBits`, `discardSettingOn: false`. **No coordinates.**
  - Severity info, confidence high.
  - Recommendation: fix the GPS or set a fixed position.
  - A7 and A9 are mutually exclusive by construction.

### Service
- Full path: map the extra fields into the H1 inputs. Meshtastic `isLocal` comes from `resolveLocalNodeSources`; MeshCore from `isLocalNode` and `lastAdvertHadPosition`.
- Compute `sourceLastHeardMs` from the already-loaded rows. No new query.
- Extend the single MeshCore telemetry query at `:711-716` to `[mc_status_uptime_secs, mc_battery_mv, mc_status_battery_volts]`.
- Meshtastic `batteryLevel` is already loaded.
- Add `tierASkips` in both paths.
- `meshIssuesScheduler` status picks up the new thresholds automatically through the shared key list.

## Mesh impact
**RF: none.**
- The rules are DB reads only.
- No telemetry requests, polls or adverts are triggered. MeshCore battery samples exist only where the operator already enabled polling.
- No timers. The scheduler cadence is unchanged.
- Notifications: none. Mesh Issues findings do not notify.
- Query cost: two extra telemetry types in one existing bounded query. A6, A7 and A9 reuse rows already loaded.

## Security / permissions
- Unchanged gates: read needs `nodes:read` per source, with `sourceIds`/`sources` intersection and MeshCore `nodeName` withholding. Thresholds and run-now need `settings:write`. Settings keys are added to both allowlists in `constants/settings.ts`.
- **No coordinates in any new evidence.** This means no `nodes:viewOnMap` gate is needed.
- A7 says nothing about overrides. Suppressing A7 when an override exists leaks only "this node has some override", including private ones. That is accepted as negligible. The alternative (ignore overrides) is in Q5.
- Battery values are already visible on node lists to `nodes:read`.

## Work packages
- **WP1 Foundations (pure)**
  - Files: `server/services/meshIssues/{types,thresholds,nodeSnapshot,meshcoreSnapshot}.ts`, new `nodeHealth.ts`.
  - Tests (`thresholds.test.ts`): new keys, defaults, clamps, garbage → default.
  - Tests (`nodeSnapshot.test.ts`): `reportedPosition` under override/bogus/none, freshest-raw-pair selection, `hasPositionOverride` OR, `isLocal`.
  - Tests (`meshcoreMeshIssues.test.ts`): mV/V normalisation into `batteryMv`, dedup, `advertHadPosition`.
  - Tests (new `nodeHealth.test.ts`): `batteryReading` (101, 0 + no voltage, ≤0 mV), `buildSourceLiveness` excludes local rows.
- **WP2 Rules**
  - Files: new `server/services/meshIssues/rulesNodeHealth.ts`; `rules.ts` (register in `ALL_RULES`, A3 uses `infraBatteryDischarging` and `t.lowBatteryPct`, export `tierASkips`).
  - Tests (new `rulesNodeHealth.test.ts`, both protocols per rule):
    - A6: stale vs fresh; future timestamp; silent-source skip; >30 d not flagged; per-protocol window; local excluded.
    - A7: three clauses; override suppresses.
    - A8: pct and mV, powered skip, A3-owned skip, confidence.
    - A9: null-island (incl. precision offset), out-of-range, override ignored, evidence has no lat/lon.
    - Companion (advType 1) and Meshtastic CLIENT not flagged.
  - Existing `rules.test.ts` must stay green, including the "no promote" cross-rule test, which must cover the new recommendations.
- **WP3 Service + settings**
  - Files: `server/services/meshIssuesAnalysisService.ts` (`buildTierAContext`, mapping, telemetry types, liveness, skips); `server/constants/settings.ts` (both lists).
  - Tests (`meshIssuesAnalysisService.meshcore.test.ts`):
    - A MeshCore-only run emits A6–A9 with `mc:` subjectKey and `nodeNum` null.
    - A mixed run pools correctly.
    - A muted A8 is not emitted and appears in `skippedRules`.
    - A silent source produces a skip, not findings.
  - Also: the Meshtastic service test.
  - Also: route test that redaction strips hidden `sourceIds` on an A8 MeshCore row.
- **WP4 Frontend**
  - Files: `components/Analysis/meshIssueRuleIds.ts` (+4 ids; update the test to 22), `meshIssueTypes.ts` (labels, blurbs, thresholds wire), `meshIssues/issueColumns.ts` (A6–A9 column sets), `components/MeshIssuesSection.tsx`.
  - Columns:
    - A6: `lastHeardAgeMs` primary.
    - A7: `clause`.
    - A8: Battery % and Battery mV as separate numeric columns, `thresholdUsed`.
    - A9: `positionIssue`.
  - `MeshIssuesSection.tsx`: four threshold inputs with help text. The mV help notes that LiFePO4 rests near 3.2–3.3 V.
  - Tests: `MeshIssuesSection.test.tsx` save patch; `issueColumns`/`IssueTable` render the A8 MeshCore row; mute list shows the 4 new ids under Tier A.
- **WP5 Docs**
  - `docs/features/mesh-issues.md`: Tier A table, thresholds provenance, MeshCore section, coverage skips, settings.
  - `docs/features/mesh-issues-test-reference.md`.
  - Epic phase log.
  - Browser check on a throwaway volume: seed a MeshCore repeater with no lat/lon, `mc_status_battery_volts` 3.1 and a 5-day-old `lastHeard`, plus a Meshtastic ROUTER at (0,0) with discard off. Run now. Expect A6, A7, A8 (MeshCore) and A9 (Meshtastic), each linking to the right node view.

## Open questions for the maintainer
1. **Scope.** Recommended: **infra only** (Meshtastic routing roles, MeshCore repeaters and room servers), no knob. Alternatives:
   - All nodes, at info severity for clients. Noisy: handhelds go stale and drain normally.
   - A `mesh_issues_node_health_scope` setting (`infra` / `all`).
2. **Stale window.** Recommended: **per protocol, Meshtastic 24 h, MeshCore 96 h** (about 2× the 47 h default flood advert, so one lost advert does not fire), both tunable. Alternative: one shared 72 h. That fires early on repeaters with a missed advert and is lax for Meshtastic.
3. **Decommissioned cut-off.** Recommended: **stop flagging after 30 days** (the finding auto-closes). Alternative: flag forever and rely on dismiss.
4. **Low-battery thresholds.** Recommended: **20 % / 3300 mV**, the same as the notification defaults. The help text warns that LiFePO4 packs sit near 3.3 V. Alternative: 3400 mV (more warning on Li-ion, worse for LiFePO4).
5. **Position override vs A7.** Recommended: **an override suppresses A7**, because MeshMonitor's maps, coverage and A4 are then satisfied. Alternative: fire anyway, because the mesh still cannot see the position.
6. **A3/A8 overlap on infra.** Recommended: **A8 skips nodes whose A3 battery clause fires** (one shared predicate, no cross-rule state). Alternatives:
   - Let both fire.
   - Retire A3's battery clause into A8. Existing A3-battery rows would auto-close and reopen as A8.
7. **Bad position under default discard.** A9 will rarely fire while `discardInvalidPositions` is on, because bogus fixes are never stored. Recommended: **accept** (A9 is the reporting surface for operators who turn discard off, plus legacy rows). Alternative: count discarded fixes per node at ingest. That needs new columns or a migration and changes ingest paths; it should be a separate issue.
8. **Ids / tier.** Recommended: **A6–A9 in Tier A**. Tier A's label is already "Node health", and `tierOfRule` and the tier toggles need no change. Alternative: a new Tier D, which needs changes to the tier toggle, grouping and wire.

## Out of scope
- Adding a battery or voltage clause to MeshCore A3.
- Position "jump" or outlier detection (e.g. a node far from all its RF neighbours).
- Ingest counters for discarded fixes.
- Deriving the MeshCore stale window from observed advert cadence (C2 data).
- Per-node battery chemistry.
- Clients and companions, unless Q1 picks "all".
- Notifications for these findings.
- Reticulum.
- Any v1 API or Prometheus surface for findings.
- Changing the override-aware position pair used by A2b, A4 and Tier B.

**Verify during WP1:** Repeater-*source* local battery rows. The poller skips the node-row write for `isRepeater` (`meshcoreTelemetryPoller.ts:288-292`). Confirm that `mc_battery_mv` rows still carry the real public key as `nodeId`; if they don't, the adapter drops them silently.

### Critical Files for Implementation
- /home/yeraze/Development/meshmonitor/src/server/services/meshIssues/nodeSnapshot.ts
- /home/yeraze/Development/meshmonitor/src/server/services/meshIssues/meshcoreSnapshot.ts
- /home/yeraze/Development/meshmonitor/src/server/services/meshIssues/rules.ts (plus new rulesNodeHealth.ts, nodeHealth.ts)
- /home/yeraze/Development/meshmonitor/src/server/services/meshIssues/thresholds.ts
- /home/yeraze/Development/meshmonitor/src/server/services/meshIssuesAnalysisService.ts
- /home/yeraze/Development/meshmonitor/src/components/MeshIssuesSection.tsx (with src/components/Analysis/meshIssueRuleIds.ts, meshIssueTypes.ts, meshIssues/issueColumns.ts)
