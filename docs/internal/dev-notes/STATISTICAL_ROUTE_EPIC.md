# Statistical Route Visualization — Epic Plan

**Status:** In progress (started 2026-07-30)
**Orchestrator:** Epic harness session
**Related:** TRACEROUTE_STRIP_INTERACTIVITY_EPIC.md (PRs #4424/#4427/#4429/#4430), TRACEROUTE_VISUAL_STRIP_SPEC.md (#4381)

## Goal

For a Meshtastic source, many traceroutes accumulate for the same fixed node pair
(local node ↔ conversation partner). In addition to showing each individual route,
add a **"Statistical route"** view: a merged union graph of all historical routes
for the pair, where each node glyph's and edge's opacity maps to how often that
node/adjacency occurred across the history. The user can then see at a glance which
relays are the most frequent and reliable on the path.

## Interview decisions

| Question | Decision |
|----------|----------|
| Surface | New "Statistical" entry in the existing `TracerouteParticipationPicker` dropdown in the Node Details box (Messages tab). Map overlays unchanged. |
| Data window | All stored pair history (per-pair retention already caps rows). No time filter, no window UI. |
| Pair scope | Only traceroutes whose endpoints are the local node and the selected conversation node, either direction — via the existing `GET /api/traceroutes/history/:from/:to` (bidirectional, source-scoped, `requirePermission('traceroute','read')`). Relay-only participation entries stay individually pickable but do NOT feed the aggregate. |
| Direction counting | **Combined undirected.** An adjacency counts whenever the two nodes were adjacent in any leg (forward or return) of any traceroute. The statistical strip renders a single neutral lane — no forward/return split, no dashed return styling. |
| Encoding | Opacity by occurrence share, plus hover tooltip percentages ("seen in 12 of 15 routes (80%)"). No permanent numeric labels, no stroke-width scaling. |
| Phasing | Two phases, each its own merged PR. |

## Standing constraints (from CLAUDE.md / survey)

- Aggregation is a pure frontend/util concern; **no schema change, no new endpoint** —
  `/history/:from/:to` already returns full pair history with `route`/`routeBack` JSON.
- Rows with no parseable `route` AND no parseable `routeBack` (failed traceroutes) are
  excluded from the aggregate, matching the map's skip rule.
- Reuse `tracerouteSegments.ts` parsers (`parseHopArray`, `isValidRouteNode`,
  `BROADCAST_ADDR` handling) — do not re-implement route parsing.
- Layout work extends `src/utils/tracerouteStrip.ts` conventions (pure, deterministic,
  no Date.now/random); rendering extends `TracerouteStrip.tsx` + CSS module.
- Unknown hops (`BROADCAST_ADDR`) are position-anonymous; the union graph must not
  merge distinct unknown hops across traceroutes into one node blindly — architect
  decides the identity rule and documents it in the Phase 1 spec.
- Apply an opacity floor (rare nodes/edges must stay visible/hoverable).
- New UI strings go through i18n; icons via UiIcon; CSS module additions only.

## Phases

### Phase 1 — Aggregation core + union-graph layout engine
- [x] Complete (2026-07-30)

Pure utilities, no visible product change:
- Aggregation: given `DbTraceroute[]` pair history + the two endpoint nodeNums,
  produce a union graph: nodes (nodeNum or anonymous-hop identity) and undirected
  edges, each with occurrence count and share (count / total included traceroutes).
- Layout: extend the strip layout engine (or a parallel pure module following its
  conventions) to lay out a multi-path union graph between two fixed endpoints —
  handling nodes that appear at different hop depths in different routes, and
  reusing/extending the glyph-collision routing where applicable.
- Exhaustive Vitest coverage in the standard suite: aggregation counting rules,
  direction combining, failed-row exclusion, unknown-hop identity, layout
  determinism/collision cases.

**Exit criteria:** typecheck + full suite green; pure modules exported and tested;
no UI/behavior change shipped; spec decisions recorded in this doc.

**Phase 1 record (2026-07-30):**
- Shipped `src/utils/tracerouteAggregate.ts` (counting model, 44 tests) and
  `src/utils/tracerouteUnionLayout.ts` (cells+pixels, 30 tests);
  `tracerouteStrip.ts` got export-only changes (+6 tests) so both layouts share
  one set of geometry helpers. Full design: `SR_PHASE1_SPEC.md` decisions D1–D11.
- Key decisions: anon hops merge by hop depth (`u:<depth>`); once-per-traceroute
  counting so shares stay in (0,1]; lower-median column assignment with endpoints
  pinned; alternating row offsets make the dominant path a straight line; edges
  branch on column (not row) to avoid the vertical-chord divide-by-zero; opacity
  floor `MIN_STAT_OPACITY = 0.28`; `UnionStripGraph` extends the strip types with
  `mode: 'statistical'`.
- Phase 2 seam: `buildStatisticalStrip(rows, localNodeNum, peerNodeNum, opts?)`.
- Deviation from spec §5: work packages ran sequentially (WP1→WP2→WP3) instead of
  WP1∥WP2, so WP2 imported `filterHops` directly and the tolerated temporary
  hop-filter duplication never existed.

### Phase 2 — UI integration
- [x] Complete (2026-07-30)

- `TracerouteParticipationPicker`: add a "Statistical (N routes)" option, shown only
  when the pair history has ≥ 2 aggregatable routes.
- Fetch pair history via existing `ApiService.getTracerouteHistory` behind a TanStack
  hook (mirroring `useNodeTraceroutes` conventions).
- `TracerouteStrip`: statistical render mode — neutral single-lane edges, per-node and
  per-edge opacity from occurrence share, hover tooltips with "seen in X of N routes
  (P%)", keyboard/aria parity with the existing strip.
- MessagesTab wiring: statistical pick interacts with the displayed-traceroute rules
  (a statistical pick suppresses the single-route strip; new poll rows / partner
  change reset per existing rules).
- Copy links behavior in statistical mode: hidden (a statistical aggregate has no
  single forward/return text form).
- i18n strings, CSS module additions, component + MessagesTab tests.
- Browser validation on the dev container (chrome-devtools), docs pass.

**Exit criteria:** all Phase-2 UI behaviors verified in the live app; full suite +
lint:ci green; docs updated; PR merged.

**Phase 2 record (2026-07-30):**
- Shipped per `SR_PHASE2_SPEC.md` (D12–D18): `useTraceroutePairHistory` hook +
  `TracerouteHistoryEntry` type (WP1), strip statistical render mode + CSS +
  i18n (WP2), picker `Statistical (N routes)` option (WP3), MessagesTab wiring
  with the discriminated `TraceroutePick` state and rules S1–S6 (WP4).
- Live-validated on the dev rig: option on real pairs (25 and 16 routes),
  opacity grading exact to `statOpacity()` (100%→1.0, 63%→0.73, 31%→0.505,
  6%→0.325), node popup = NodeCard + Occurrence row, edge tooltip = endpoints ↔
  + distance + seen-in with no direction/SNR, copy links/age/badges hidden,
  pick reset on partner change, no new console errors.
- Follow-ups logged, not fixed here: (1) `/history/:from/:to` does not
  channel-mask (pre-existing, shared with TracerouteHistoryModal); (2) a pair
  with stored history but zero traceroute activity in the participation window
  and no poll row renders no Node Details traceroute box at all (rule 7), so
  the statistical option is unreachable there — widening the box's render
  guard is a product decision for a future issue.

## Deviations log

- 2026-07-30 (Phase 2, WP4): first implementation worked around the
  provider-less MessagesTab test harnesses with a mount-gated loader
  component; rejected in review for the house convention — top-level hook +
  a one-line `vi.mock` in the two provider-less test files (same as their
  existing `useNodeTraceroutes` mocks). S5 stayed purely derived.
- 2026-07-30 (Phase 2, S1 amendment): the spec's fetch gate required ≥ 2
  endpoint entries in the 7-day participation list. Live validation showed
  the rig's richest pairs (25 and 16 stored routes) were all 35–83 days old —
  the gate made the feature unreachable exactly where it mattered, and
  contradicted the binding "all stored pair history" interview decision. Gate
  reduced to validity-only (permission + valid distinct pair); spec D14/S1
  rewritten with the evidence.
- Phase 1 WPs ran sequentially (recorded under Phase 1).
