# NodeInfo Enrichment Report — Epic Plan (#3837)

**Issue:** #3837 — Auto-push NodeInfo to nodes with missing fields from best available source
**Status:** In progress (started 2026-07-22)
**Surface:** New option under "Analysis & Reports" (`/reports` card grid, `AnalysisTab.tsx`)

## Goal

Automate the manual Copy NodeInfo workflow across all nodes: an interactive analysis
report that scans every physical node (distinct `nodeNum`) across all sources, finds
rows with blank NodeInfo fields that another source row can fill, and lets the user
apply the enrichment ("Fix") per node or in bulk.

## Interview decisions (2026-07-22)

- **No scheduler.** The issue's "configurable schedule" is explicitly deferred. This is
  an interactive Analysis report with a **Fix button** that performs the updates.
- **Fill blanks only.** Automation never overwrites a non-empty differing field; the
  report may surface conflicts informationally but the apply path writes only empty
  target fields.
- **Device push is an optional toggle, default OFF.** When enabled, each enriched node
  also gets the existing `pushNodeInfoToDevice` nudge (`sendNodeInfoRequest` on the
  node's channel — NOT an admin write; same semantics as the manual dialog).
- **Targets = all incomplete sources.** For each nodeNum, the richest source row donates
  to every other source row with blank fields (full cross-source convergence).
- Two phases, each its own merged PR (confirmed by user).

## Reuse anchors (from code survey)

- `src/server/services/nodeInfoCopyService.ts` — `NODE_INFO_FIELDS` (8 fields:
  longName, shortName, hwModel, role, macaddr, publicKey, hasPKC, firmwareVersion),
  candidate ranking (fieldsFilled desc, updatedAt desc), copy + `pushNodeInfoToDevice`.
- `src/db/repositories/nodes.ts` — per-source rows keyed `(nodeNum, sourceId)`.
- Routes pattern: `src/server/routes/nodesRoutes.ts` + `src/server/routes/v1/nodes.ts`
  (copy-candidates / copy-nodeinfo), `ok`/`fail` envelope, `requirePermission`.
- UI: `src/components/Analysis/AnalysisTab.tsx` card grid (`AnalysisType` union +
  `reports[]` + selected-branch), `SolarMonitoringReport.tsx` as structural template
  (TanStack useQuery). No `VALID_TABS` change needed (router route, not app tab).
- Route tests: `createRouteTestApp()` harness (`src/server/test-helpers/routeTestApp.ts`).

## Phases

### Phase 1 — Backend: enrichment analysis + apply API
**Branch:** `feature/nodeinfo-enrichment-backend`

- [ ] `src/server/services/nodeInfoEnrichmentService.ts` reusing `nodeInfoCopyService`
      primitives: `analyzeEnrichment()` (per distinct nodeNum: target rows with blank
      fields, best donor row, fillable fields per target) and
      `applyEnrichment(items, pushToNodeDb)` (fill-blanks-only writes via nodes
      repository; optional device push per enriched node).
- [ ] Routes (unversioned + v1): `GET .../enrichment/analysis` (nodes:read,
      permission-filtered per source) and `POST .../enrichment/apply` (nodes:write on
      every target source; donor source needs nodes:read). Envelope helpers.
- [ ] Tests: service unit tests, route-harness permission tests, `*.perSource.test.ts`
      isolation coverage.
- **Exit criteria:** typecheck + full Vitest suite green; PR merged to main.

### Phase 2 — Frontend: Analysis & Reports card
**Branch:** `feature/nodeinfo-enrichment-report`

- [ ] Extend `AnalysisType` + `reports[]` with a "NodeInfo Enrichment" card; new
      `src/components/Analysis/NodeInfoEnrichmentReport.tsx` (TanStack useQuery +
      `ApiService` — raw fetch is banned in new components; `UiIcon` for icons).
- [ ] Table of enrichable nodes (node, target source(s), missing fields, donor source),
      per-row **Fix** + **Fix All**, push-to-NodeDB toggle default off, empty/loading/
      unauthorized states.
- [ ] Component tests; browser validation in the dev container (screenshots, console
      clean, gauntlet-channel only for any test traffic).
- **Exit criteria:** report usable end-to-end against the dev container; suite green;
  PR merged to main; issue #3837 closed.

## Deviations / notes

(Recorded per phase as they occur.)
