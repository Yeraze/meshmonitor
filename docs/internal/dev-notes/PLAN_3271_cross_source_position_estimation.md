# Plan — #3271 Cross-source + MQTT position estimation (global, multilateration)

**Issue:** Use multi-source and MQTT traceroute data to produce a single, more
accurate estimated position per physical node, shared across all sources. Add a
map counter for known-but-unmapped nodes.

**Decisions locked in:**
- **Global estimator** — one estimate per physical `nodeNum`, pooled from every
  Meshtastic source + MQTT, stored once, displayed identically everywhere. This is
  a deliberate global-by-design carve-out, mirroring the existing `channel_database`
  exception documented in `CLAUDE.md`.
- **Multilateration solve** — replace the pairwise SNR-weighted midpoint with a
  weighted least-squares / constraint solve over *all* observations, emitting a
  confidence/uncertainty radius.
- **Batch / scheduled, not realtime** — estimation runs as a single global
  scheduled job (configurable frequency + lookback window), analyzing data in
  bulk. The realtime per-traceroute hooks are removed. Bulk analysis sees the
  whole constraint set at once → better-conditioned solve.
- **Meshtastic-only** — observations are pulled only from non-MeshCore sources
  (`meshtastic_tcp`, `mqtt_broker`, `mqtt_bridge`); `meshcore` sources are
  excluded for now.
- **Richer MQTT signals** — beyond traceroutes, the batch job ingests NeighborInfo
  (incl. MQTT, which realtime currently drops — now persisted normally) and
  MQTT-relayed real positions as anchors, with direct-reception SNR/RSSI as an
  optional later signal. **MQTT observations carry full weight** (no down-weight).

---

## 1. Current state (baseline, for reference)

| Concern | Where | Behaviour today |
|---|---|---|
| Algorithm | `meshtasticManager.ts:7142` `estimateIntermediatePositions` | SNR-weighted **midpoint of the two immediate path-neighbors**, requires both to have positions; blended with prior estimates via 24h half-life time decay. |
| Trigger | `:6893` (live traceroute), `:962` (historical recalc) | Runs **once per source** that hears a traceroute. |
| Write | `:7274`/`:7284` `insertTelemetry(..., this.sourceId)` | Estimates stored as `estimated_latitude`/`estimated_longitude` telemetry rows, **tagged per-source**. |
| Read (aggregation) | `getRecentEstimatedPositions` → `getTelemetryByNode` (no sourceId) | Already **cross-source** by accident (`withSourceScope` returns `undefined` when sourceId omitted — `base.ts:229`). |
| Anchor lookup | `getNode(nodeNum)` no sourceId (`:7155`) | Cross-source (returns first matching row). |
| Display | `getAllNodesEstimatedPositionsAsync` (`database.ts:3985`) | Keyed by `nodeId`, surfaces latest estimate; **each source's node row shows its own dot** → the "different estimate per source" complaint. |
| Map "uncertainty" set | `server.ts:4783`, `:5222` | Computes `nodesWithEstimatedPosition` (estimate present + no real pos). |
| MQTT | traceroutes flow through the same handler (NOT skipped, unlike NeighborInfo at `:7398`) | MQTT data is already partly feeding estimation, but per-source and uncoordinated. |

**Root cause of the bug in the issue:** writes/triggers are per-source while
reads are accidentally cross-source — incoherent. We will make the whole pipeline
coherently global.

---

## 2. Target architecture

A new **global position-estimation service** that:
1. Collects all geometric *observations* for a node across every source + MQTT.
2. Solves a single best-estimate position + uncertainty radius via weighted
   least-squares.
3. Persists one global estimate per `nodeNum`.
4. Is consumed identically by every source's node-enhancement/display path.

### 2.1 Observation model

We unify every signal into a single **proximity/range constraint**: "node `X` is
within ~`range(SNR/RSSI)` of a *positioned* anchor `A`." Both traceroute hops and
neighbor reports collapse to this shape.

```ts
interface PositionObservation {
  nodeNum: number;          // node being estimated (no real position)
  anchorLat: number;        // a node WITH a known position
  anchorLon: number;
  snrDb?: number;           // raw/4 if available; biases range estimate
  rssiDbm?: number;         // optional, from direct reception
  timestamp: number;        // for time-decay weighting
  kind: 'traceroute' | 'neighbor' | 'reception';
  sourceId: string;         // provenance only (NOT a filter)
  viaMqtt: boolean;         // provenance; may down-weight (see open Q)
}
```

**Observation sources (all Meshtastic-only, pooled across sources):**

1. **Traceroutes** (`traceroutes` table — `route` + `snrTowards`/`snrBack`).
   For each segment `A – X – B`, both positioned endpoints become anchor
   observations for `X`. (This is the only signal used today, and only pairwise.)
2. **NeighborInfo** (`neighbor_info` table — `nodeNum ↔ neighborNodeNum` + `snr`).
   Each row is a direct-RF-range proximity constraint between two nodes; whenever
   one side is positioned it anchors the other. **High value, currently unused
   for estimation** — and realtime ingest *drops* the MQTT variant
   (`meshtasticManager.ts:7398`). We stop dropping it and persist MQTT
   NeighborInfo exactly like local NeighborInfo (see §4a).
3. **MQTT-relayed real positions** — remote nodes broadcasting GPS over MQTT are
   *anchors*, not targets; they massively enrich the anchor set. Already stored.
4. **Direct reception (0-hop) SNR/RSSI** — *optional, later phase*. When a
   positioned node directly hears another (`hopStart == hopLimit`), rx metadata
   gives a range constraint. Huge volume over MQTT but only persisted today in the
   opt-in, pruned `packet_log`. Defer until a durable capture exists.

Pooling all of these, a node accumulates constraints from many directions →
well-conditioned multilateration.

### 2.2 The solve

Per node, compute the position minimizing weighted squared distance to its
anchor constraints. Two acceptable implementations (pick in implementation,
default to the simpler first and unit-test against synthetic geometry):

- **Weighted centroid of constraint midpoints** (incremental, cheap): each
  traceroute contributes its SNR-weighted midpoint as today, but we keep *all*
  of them and take the weight-combined centroid. Weight = `snrWeight * timeDecay`.
  Emit uncertainty = weighted stddev / spread of contributing midpoints.
- **Iterative least-squares multilateration** (better): treat SNR→approx range,
  solve for `(lat,lon)` via Gauss–Newton / gradient descent over the anchor set
  in a local ENU tangent plane (small-area flat-earth approximation is fine for
  mesh ranges). Emit uncertainty from the residual covariance.

> Recommendation: ship the **weighted-centroid** version first (it's a clean
> generalization of the existing math and easy to test), structure the service so
> the solve function is swappable, then add the LSQ solver behind the same
> interface. Both must emit an uncertainty radius.

### 2.3 Storage (global)

The cleanest store is a dedicated global table rather than continuing to abuse
per-source telemetry rows.

**New table `estimated_positions` (global — no `sourceId`):**

| col | type | notes |
|---|---|---|
| `nodeNum` | BIGINT (PG/MySQL) / INTEGER (sqlite), PK | physical node |
| `nodeId` | text | `!xxxxxxxx` convenience |
| `latitude` | real | solved estimate |
| `longitude` | real | solved estimate |
| `uncertaintyKm` | real | confidence radius for accuracy region |
| `observationCount` | integer | how many constraints fed it |
| `updatedAt` | bigint | ms |

- Schema in `src/db/schema/` (three backend definitions, **no `sourceId`** — this
  is the documented global carve-out). Add a one-line note to `CLAUDE.md` next to
  the `channel_database` exception.
- New repository `src/db/repositories/estimatedPositions.ts` (all Drizzle, async).
- Expose via `DatabaseService` with `Async` suffix:
  `upsertEstimatedPositionAsync`, `getAllEstimatedPositionsAsync`,
  `getEstimatedPositionAsync(nodeNum)`, `deleteAllEstimatedPositionsAsync`.

> Alternative (lower-migration-risk) considered & rejected: keep telemetry rows
> but write them with a sentinel global `sourceId`. Rejected — it perpetuates the
> "estimate is telemetry" conflation, breaks the per-source invariant scanners,
> and makes the uncertainty radius awkward to store. A dedicated table is cleaner.

### 2.4 Service (batch)

New `src/server/services/positionEstimationService.ts` — pure compute, no timers:
- `gatherObservations({ lookbackMs })` — query the Meshtastic-only observation
  sources (§2.1) for rows within the lookback window, across all non-MeshCore
  sources, and flatten into `PositionObservation[]` grouped by target `nodeNum`.
  Anchors = nodes with an effective real position (`getEffectiveDbNodePosition`).
- `solve(observations)` — run the solver (§2.2) per node → `{lat, lon,
  uncertaintyKm, observationCount}`.
- `recomputeAll({ lookbackMs })` — gather → solve → bulk-upsert into the global
  `estimated_positions` table; delete estimates for nodes that now have a real
  position or no longer have enough observations. This is the single entry point
  the scheduler and the manual trigger both call.

Observations are **derived on-the-fly** from already-stored traceroutes +
neighbor_info each run (no new observations table) — they're already queryable
cross-source, and batch cadence makes recompute cost a non-issue.

`meshtasticManager` no longer does estimation inline: remove the
`estimateIntermediatePositions` calls (`:6893`, `:6898`) and the
`checkAndRecalculatePositions` recompute loop. The manager keeps writing
traceroutes/neighbor_info as it does today (that's the raw data the batch reads).

### 2.5 Scheduler (global singleton)

New `src/server/services/positionEstimationScheduler.ts`, modeled on
`backupSchedulerService` / `databaseMaintenanceService`:
- Single instance started once at server boot (NOT per-source).
- `setInterval` tick (±drift window) that checks whether a run is due based on
  configured frequency; calls `positionEstimationService.recomputeAll({
  lookbackMs })`.
- Guards against overlapping runs (skip if a run is in flight).
- A manual "recalculate now" path (API endpoint / settings button) calls the same
  `recomputeAll`; repurpose the existing `recalculate_estimated_positions` flag as
  the force-run signal instead of a boot-time loop.

**Configurable settings** (add all to `VALID_SETTINGS_KEYS` in
`src/server/constants/settings.ts`, plus `SettingsContext`/`SettingsTab` wiring):
- `position_estimation_enabled` (default true)
- `position_estimation_frequency_hours` (default 6 — "a few times a day")
- `position_estimation_lookback_hours` (default 168 = 7 days)

(No MQTT-weight setting — MQTT observations carry full weight.)

---

## 3. Display / consumption changes

- `enhanceNodeForClient` (`nodeEnhancer.ts:81`) already takes an
  `estimatedPositions` map keyed by `node.user.id`. Swap its data source from
  `getAllNodesEstimatedPositionsAsync()` (per-source telemetry) to
  `getAllEstimatedPositionsAsync()` (global table). Because the map is keyed by
  nodeId and the estimate is now global, **every source shows the same dot** —
  fixes the issue's core complaint.
- Accuracy region: feed `uncertaintyKm` through so `showAccuracyRegions` draws a
  real confidence circle instead of a fixed radius (check current radius source
  in `MapStyleManager.tsx` / popup).
- `nodesWithEstimatedPosition` computation (`server.ts:4783`, `:5222`): source it
  from the global estimate table (has-estimate AND no-real-position) instead of
  scanning telemetry types.

---

## 4. Map counter for known-but-unmapped nodes

- Backend: extend the telemetry-availability endpoint (the one returning
  `estimatedPosition` at `server.ts:4841`) to also return `unmappedCount` /
  `unmappedNodeIds` = nodes known to the source(s) with **neither** a real nor an
  estimated position. (Cheap: we already iterate all nodes there.)
- Frontend: surface the count in `MapLegend.tsx` (e.g. "12 nodes without
  location"). Main map render lives in `NodesTab.tsx`.

---

## 4a. Stop dropping MQTT NeighborInfo

Realtime ingest currently early-returns on MQTT-sourced NeighborInfo
(`meshtasticManager.ts:7398`, "remote mesh topology, not local connections").
That rationale is about the *local-topology* view, but for a global batch
estimator the MQTT neighbor graph is exactly the extra resolution we want.

**Decision:** drop the early-return and persist MQTT NeighborInfo exactly like
local NeighborInfo — same `neighbor_info` table, tagged with its `sourceId`, no
extra flag column. Local-topology views that consume `neighbor_info` should be
spot-checked, but since the rows already carry `sourceId` and these are Meshtastic
sources, treating them uniformly is acceptable.

This is the single highest-leverage "additional MQTT data" item.

## 4b. Meshtastic-only enforcement

`gatherObservations` resolves the set of eligible sources via the sources repo and
**excludes `type === 'meshcore'`** (keeps `meshtastic_tcp`, `mqtt_broker`,
`mqtt_bridge`). Traceroute/neighbor queries are restricted to those source IDs.
MeshCore nodes live in separate tables (`meshcore_nodes`) and never enter the
`nodes`/`traceroutes`/`neighbor_info` tables, so they're excluded by construction;
the explicit source filter is belt-and-suspenders + future-proofing.

## 5. Migration

`src/server/migrations/082_add_estimated_positions_table.ts`:
- `up` for SQLite (CREATE TABLE IF NOT EXISTS), `runMigration082Postgres`,
  `runMigration082Mysql` (idempotent via `IF NOT EXISTS` / information_schema).
- Register in `src/db/migrations.ts`; bump count + last-name in
  `src/db/migrations.test.ts` (current count 81 → 82).
- Delete the old `estimated_latitude`/`estimated_longitude` telemetry rows (dead
  data once the global table exists — prefer deleting to avoid confusion).
- The first scheduler tick after boot performs the historical backfill from stored
  traceroutes/neighbor_info within the lookback window — no separate boot-time
  recalc loop needed (it's removed from the manager).

No `neighbor_info` schema change — MQTT NeighborInfo reuses the existing table
(§4a).

---

## 6. Tests (TDD — write first)

1. `positionEstimationService.test.ts`:
   - Synthetic geometry: node equidistant between 4 anchors → estimate ≈ centroid;
     uncertainty small. Skewed SNR → estimate biased toward stronger anchor.
   - Single observation → estimate = midpoint, large uncertainty.
   - **Mixed signal kinds**: traceroute + neighbor observations for the same node
     both contribute.
   - **Pooling across multiple `sourceId`s + a `viaMqtt` observation** → all
     contribute to ONE estimate (regression guard for the issue).
   - **Meshtastic-only**: observations from a `meshcore` source are excluded.
   - **Lookback window**: observations older than the window are dropped.
2. `positionEstimationScheduler.test.ts`: due/not-due logic against
   frequency setting; overlap guard (no concurrent runs); disabled flag skips;
   manual force-run path triggers a run. (Use fake timers as the other scheduler
   tests do.)
3. `estimatedPositions` repository test — round-trip upsert/get on SQLite.
4. `*.perSource.test.ts` — assert the estimate table is global: an estimate
   produced from source-A data is readable identically for a source-B view.
5. Migration 082 test (CREATE idempotency + neighbor `viaMqtt` add-column if
   included) + update `migrations.test.ts` (count, last name).
6. Map-counter endpoint test: known node with no position counted; node with
   estimate NOT counted as unmapped.
7. Settings test: new keys persist (in `VALID_SETTINGS_KEYS`).
8. Update/replace existing `server.estimatedposition.test.ts` and the
   `telemetry.extra.test.ts` `getRecentEstimatedPositions` cases that assume the
   telemetry-row model (and any test asserting realtime per-traceroute estimation).

Run the **full** Vitest suite (migration/refactor rule) before PR. SQLite first.

---

## 7. Rollout / file checklist

- [ ] `src/db/schema/<estimatedPositions>.ts` (3 backends, no sourceId)
- [ ] `src/db/repositories/estimatedPositions.ts`
- [ ] `DatabaseService` async wrappers
- [ ] `src/server/services/positionEstimationService.ts` (gather/solve/recomputeAll;
      solver swappable; Meshtastic-only source filter; lookback window)
- [ ] `src/server/services/positionEstimationScheduler.ts` (global singleton,
      configurable frequency, overlap guard, manual force-run)
- [ ] start scheduler at server boot (alongside other schedulers)
- [ ] `meshtasticManager.ts`: remove `estimateIntermediatePositions` calls +
      `checkAndRecalculatePositions` recompute loop; stop writing estimate telemetry
- [ ] §4a: stop dropping MQTT NeighborInfo (remove early-return at
      `meshtasticManager.ts:7398`; persist normally, no schema change)
- [ ] settings: `position_estimation_enabled`, `_frequency_hours`,
      `_lookback_hours` → `VALID_SETTINGS_KEYS` + `SettingsContext` +
      `SettingsTab` (mind the handleSave dep array)
- [ ] `nodeEnhancer` / display path → global estimate map + uncertaintyKm
- [ ] `server.ts` availability endpoint: global estimate set + unmappedCount
- [ ] `MapLegend.tsx` unmapped counter; accuracy-region radius from uncertainty
- [ ] migration 082 + registry + migrations.test.ts
- [ ] tests (section 6)
- [ ] `CLAUDE.md`: document `estimated_positions` as a global-by-design table
      alongside `channel_database`; note estimation is Meshtastic-only + batch
- [ ] branch (never push to main), `/create-pr`, `/ci-monitor`

---

## 8. Decisions (resolved)

1. **MQTT weighting:** ✅ full weight, no multiplier / no setting.
2. **MQTT NeighborInfo (§4a):** ✅ persist normally in `neighbor_info`, no schema
   change, no `viaMqtt` column.
3. **Schedule shape:** ✅ simple fixed interval `every N hours`. Defaults:
   frequency 6h, lookback 7d.
4. **Solver depth for v1:** weighted-centroid first, swappable interface to add
   LSQ later. (Default — flag if you want LSQ from the start.)
5. **Direct-reception signal:** deferred to a later phase (no durable capture
   today).
6. **Old telemetry rows:** deleted in migration 082.
