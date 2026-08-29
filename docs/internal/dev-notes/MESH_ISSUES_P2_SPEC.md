# Mesh Issues Analysis — Phase 2 Implementation Spec

**Epic:** #4964 · **Phase:** 2 — Tier B (RF adjacency graph)
**Worktree:** `../meshmonitor-mesh-issues-p2` (`feature/mesh-issues-analysis-phase2`)
**Depends on:** Phase 1, merged to main (PR #4966, commit `29049f05`)
**Binding inputs:** `MESH_ISSUES_EPIC.md` (locked decisions + Tier B table), `MESH_ISSUES_P1_SPEC.md` §5 (all 16 decisions carry forward), `CLAUDE.md`.

## 0. Scope and mesh-impact statement

Phase 2 adds an **in-memory RF adjacency graph** built from three passive evidence
classes and seven graph rules (B1–B7) on top of it. It touches no transmit path.

**Mesh impact checklist (CLAUDE.md), answered up front — copy into the PR body:**

1. **Airtime cost: zero.** No packets are sent. Every input is a row already on
   disk (`neighbor_info`, `traceroutes`, `mqtt_packet_log`, `packet_log`,
   `nodes`, `telemetry`). Epic locked decision: "Passive only."
2. **Spam risk: none, direct or indirect.** Findings are written to
   `mesh_issues` and read by one report. No `dataEventEmitter` emission (P1 §5.11
   — a Phase 3 user decision, not to be changed here). No automation fan-out,
   no Apprise, no MQTT publish.
3. **Safety timer: unchanged.** Phase 2 arms no new timer. It reuses
   `meshIssuesScheduler`, whose `mesh_issues_last_run` already lives in settings
   (restart-safe). No new scheduler, no new settings that gate a send.

New cost is **database read volume**: four additional bounded queries per run
(default one run per 24 h). Every one is a single aggregate or single scan with
an explicit row cap — no per-node loops (§3.6).

---

## 1. Reuse inventory (read before writing any code)

Searched with serena/grep across `src/utils`, `src/server/services`,
`src/server/utils`, `src/db/repositories`, `src/db/schema`, `src/components`.

### 1.1 Must reuse — parsing, geometry, pure helpers

| Symbol | File | Why it is mandatory here |
|---|---|---|
| `UNKNOWN_SNR_SENTINEL` (= `-32`), `isUnknownSnr` | `src/utils/tracerouteSegments.ts` | The sentinel is compared **after** the `/4` de-scale (`buildLegSegments` line 365–366: `scaledSnr = rawSnr / 4` then `isUnknownSnr(scaledSnr)`). The raw stored value is `-128`. Re-deriving this is the single easiest way to get the graph wrong. |
| `parseHopArray`, `hasRouteData`, `hasReturnPath`, `isValidRouteNode`, `BROADCAST_ADDR` | `src/utils/tracerouteSegments.ts` | Already used by `tracerouteCorpus.ts`. `rfGraph.ts` must not `JSON.parse` a route/SNR column itself (same rule the corpus module carries). |
| `buildLegSegments`' hop↔SNR index alignment (lines 339–352) | `src/utils/tracerouteSegments.ts` | The alignment rule is subtle and load-bearing: hops are `[start, ...intermediate, end]`; `snrRaw[i]` is the **arrival** SNR at `intermediate[i]`; `snrRaw[intermediate.length]` is the arrival SNR at the **end endpoint**; invalid intermediate hops are dropped *after* pairing so surviving segments keep the right SNR. §2.1 extracts this rather than reimplementing it — there are already four independent implementations of this pairing in the tree and a fifth would be indefensible. |
| `calculateDistance(lat1, lon1, lat2, lon2): number` (km) | `src/utils/distance.ts` | B7's only geometry. |
| `isBogusPosition(lat, lon, precisionBits)` | `src/utils/nullIsland.ts` | Already the position guard in A2b; B4/B5/B7 use the same one. |
| `djb2Hash(str): number` | `src/utils/loraFrequency.ts` | Stable, in-tree string hash for B1's `cluster:` subject key. Do not add a new hash. |
| `isPowered(batteryLevel)` | `src/server/utils/poweredState.ts` | B5's "fixed and powered" branch. Already A3's guard. |
| `DeviceRole`, `ROLE_NAMES` | `src/constants/index.ts` | `CLIENT_BASE = 12`, `ROUTER_LATE = 11`. Never literal ints (P1 rule). |
| `INFRA_ROLES`, `MOBILE_MIN_PRECISION_BITS`, `AREA_GRID_BIN_DEG` | `src/server/services/meshIssues/thresholds.ts` | Reused verbatim by B2/B4/B5/B7. |
| `nodeSubjectKey`, `areaSubjectKey`, `MeshIssueFinding` | `src/server/services/meshIssues/types.ts` | Extended, not replaced (§2.2). |
| `TracerouteSample`, `buildTracerouteCorpus` | `src/server/services/meshIssues/tracerouteCorpus.ts` | Phase 1 built this and consumed only `stats`. Phase 2 consumes `samples` — **no change to the sampler is required or permitted.** |
| `PooledNode`, `buildPooledNodeSnapshot` | `src/server/services/meshIssues/nodeSnapshot.ts` | Unchanged. |

### 1.2 Must reuse — data access

| Symbol | File | Notes |
|---|---|---|
| `AnalysisRepository.getNeighbors({ sourceIds, sinceMs }): Promise<{ items: NeighborRow[] }>` | `src/db/repositories/analysis.ts:504` | **Evidence class 1 needs no new query.** Returns `{ id, nodeNum, neighborNum, sourceId, snr, timestamp }`, unpaginated, source-scoped, time-windowed. Already normalizes BigInt. |
| `AnalysisRepository.getTraceroutes` | `src/db/repositories/analysis.ts:420` | Already paginated into the corpus by `meshIssuesAnalysisService.loadTracerouteCorpusRows`. Unchanged. |
| `packetLogService.isEnabled()` / `mqttPacketLogService.isEnabled()` | `src/server/services/packetLogService.ts:158`, `mqttPacketLogService.ts:116` | Both read a **global** (not per-source) setting: `packet_log_enabled === '1'`, `mqtt_packet_log_enabled === '1'`. Reuse; do not re-read the setting directly. |
| `isMqttSourceType(type)` | `src/db/repositories/sources.ts:33` | `mqtt_broker` \| `mqtt_bridge`. Already imported by the analysis service. |
| `BaseRepository.normalizeBigInts`, `this.tables` | `src/db/repositories/base.ts` | Every new repository method uses these. |
| `ok()` / `fail()` | `src/server/utils/apiResponse.ts` | No new routes in Phase 2, but the existing `/status` payload widens (§2.9). |

### 1.3 Considered and rejected (record these — reviewers will ask)

- **`src/server/services/rf/propagation.ts` for B7.** `evaluateLink(samples, inputs, budget)` needs a full DEM terrain profile (`TerrainSample[]` from tx to rx), a frequency, both antenna heights and a link budget. None of those exist per node in our data, and fetching a DEM profile per candidate pair is an async, network/disk-bound call inside what must be a pure synchronous batch rule over O(shadow × routers) pairs. **Rejected**; B7 uses an observed-range estimator instead (§2.6 B7, decision D7).
- **`meshtastic_heard_repeaters` (migration 152) as a fourth evidence class.** Its `relayByte` is only the **last byte** of the relaying node's nodeNum. The epic's "Excluded by design" list names `relay_node` identity assertions explicitly. **Rejected.**
- **`AnalysisRepository.getHopCounts`** for B6. It returns hop *count from the newest traceroute per node*, not hop-limit-at-arrival share. Different quantity. **Rejected.**
- **`NeighborsRepository.getDirectNeighborRssiAsync`** (which already does a `hop_start = hop_limit` direct-reception predicate over `packet_log`) as the gateway query. It is RSSI-oriented, single-source and not grouped by gateway. Its *predicate* is the precedent we copy; its query is not reusable. Cited in §3.1's JSDoc.
- **Adding a fifth hop↔SNR pairing implementation** in `rfGraph.ts`. Rejected in favour of the extraction in §2.1.

### 1.4 New code, and why nothing existing fits

| New file | Why |
|---|---|
| `src/server/services/meshIssues/rfGraph.ts` | No adjacency-graph builder exists. `routeSegmentService` builds *render* segments keyed by position and persists `route_segments`; it is not an RF-evidence union and carries no directional SNR statistics. Epic locked: "Edge graph is computed in memory per run — no persisted edge-stats table." |
| `src/server/services/meshIssues/rulesTierB.ts` | `rules.ts` is 452 lines and its context type (`RuleContext`) has no graph. Tier B needs a different context and would push one file past 950 lines. |
| `src/server/services/meshIssues/ruleRunner.ts` | The per-rule `try/catch` isolation currently lives inline in `evaluateAllTierA`. Two tiers must not have two copies of it (the prompt's explicit requirement). |
| 3 repository aggregate methods (§3) | No existing method groups `mqtt_packet_log` by `(gateway, from)` with a direct-reception predicate, and none computes a hop-limit-exhaustion ratio on either packet log. |

### 1.5 Explicitly not touched in Phase 2

`tracerouteCorpus.ts` (logic), `nodeSnapshot.ts`, `meshIssuesScheduler.ts` (logic),
migrations (**no new migration** — `mesh_issues` already holds everything),
`analysisRoutes.ts`, `meshIssuesRoutes.ts` (logic; only its test gains cases),
`BACKUP_TABLES`, `VALID_SETTINGS_KEYS` (no new settings — thresholds stay code
constants until Phase 3's settings UI, per the epic).

---

## 2. File-by-file changes

### 2.1 `src/utils/tracerouteSegments.ts` — MODIFY (behaviour-preserving extraction)

Extract the position-free half of `buildLegSegments` so the RF graph can consume
hop links without inventing positions.

```ts
/**
 * One hop of one traceroute leg, position-free.
 *
 * DIRECTION IS LOAD-BEARING: `snrDb` was measured **at `toNodeNum`** for a
 * transmission from `fromNodeNum` — the firmware records arrival SNR at the
 * receiving end of each hop. Callers doing directional statistics (Mesh Issues
 * B3) must key by receiver, not by pair order.
 */
export interface TracerouteHopLink {
  leg: 'forward' | 'return';
  fromNodeNum: number;
  toNodeNum: number;
  /** `/4`-de-scaled dB, or null when unknown (no sample, or the sentinel). */
  snrDb: number | null;
  /** True when the arrival SNR was UNKNOWN_SNR_SENTINEL (-32 after /4). */
  snrUnknown: boolean;
}

/** Pair hops with arrival SNR by index, then drop invalid intermediate hops —
 *  the exact rule `buildLegSegments` has always used (see its comment). */
export function buildLegHopLinks(
  leg: 'forward' | 'return',
  startNum: number,
  intermediateHops: number[],
  endNum: number,
  snrRaw: number[],
): TracerouteHopLink[];

/** `decomposeTraceroute` without positions. Same leg gating: forward requires
 *  `hasRouteData(route)`, return requires `hasReturnPath(routeBack, snrBack)`. */
export function decomposeTracerouteLinks(
  traceroute: TracerouteDecomposeInput,
): TracerouteHopLink[];
```

`buildLegSegments` is then re-expressed as `buildLegHopLinks(...)` mapped to
render segments, with `avgSnr = link.snrDb`, `isMqtt = link.snrUnknown`, and the
existing "skip when either endpoint has no position" filter applied afterwards.
`decomposeTraceroute` becomes `decomposeTracerouteLinks(tr)` mapped the same way.

**Acceptance:** `tracerouteSegments.test.ts` (and every other suite touching
`decomposeTraceroute`) passes **unchanged**. This is a refactor, not a behaviour
change. Do not touch `tracerouteStrip.ts`, `useTracerouteAnalysis`, or
`useTraceroutePaths` — they deliberately deviate.

### 2.2 `src/server/services/meshIssues/types.ts` — MODIFY (additive)

```ts
export const MESH_ISSUE_TYPES = {
  ...,                                        // A1..A5 unchanged
  B1_ROUTER_CLUSTER:      'B1_router_cluster',
  B2_REDUNDANT_ROUTER:    'B2_redundant_router',
  B3_ASYMMETRIC_LINK:     'B3_asymmetric_link',
  B4_IDLE_ROUTER:         'B4_idle_router',
  B5_LOAD_BEARING_CLIENT: 'B5_load_bearing_client',
  B6_HOP_HORIZON:         'B6_hop_horizon',
  B7_COVERAGE_SHADOW:     'B7_coverage_shadow',
} as const;

/** `edge:${min}-${max}` — canonical subjectKey for an edge-attributed finding.
 *  Order-independent so a run that observes the pair in the other direction
 *  updates the same row. */
export function edgeSubjectKey(a: number, b: number): string;

/** `cluster:${size}:${djb2 hex}` over the sorted member list.
 *
 *  Bounded to ~20 chars — `mesh_issues.subjectKey` is `varchar(128)` on MySQL,
 *  so a raw member list is not an option. `size` is carried outside the hash so
 *  two different-sized clusters can never collide on the 32-bit digest alone.
 *
 *  STABILITY CONTRACT: the key is stable while membership is stable. A cluster
 *  that gains or loses a member produces a NEW subjectKey; the old finding stops
 *  being re-detected and auto-closes after AUTO_CLOSE_CLEAN_RUNS. That is the
 *  honest behaviour — the old cluster genuinely no longer exists. */
export function clusterSubjectKey(members: number[]): string;
```

`MESH_ISSUE_TYPES` values must stay ≤ 64 chars (`issueType` is `varchar(64)` on
MySQL); the longest above is 22.

### 2.3 `src/server/services/meshIssues/ruleRunner.ts` — NEW, pure

```ts
/** Run a rule list with per-rule throw isolation: a rule that throws logs a
 *  warning and contributes no findings; the remaining rules still run.
 *  Extracted from evaluateAllTierA so both tiers share one implementation. */
export function runRulesIsolated<C>(
  tier: string,
  rules: ReadonlyArray<readonly [name: string, rule: (ctx: C) => MeshIssueFinding[]]>,
  ctx: C,
): MeshIssueFinding[];
```

`rules.ts`'s `evaluateAllTierA` becomes `runRulesIsolated('Tier A', ALL_RULES, ctx)`.
Log message keeps the existing shape: `` `[meshIssues] ${tier} rule ${name} threw during evaluation, skipping:` ``.
No dependency from `rulesTierB.ts` → `rules.ts` (avoids any cycle question).

### 2.4 `src/server/services/meshIssues/thresholds.ts` — MODIFY (additive)

Every constant below is `[ours]` and JSDoc'd per the file's existing convention.
`rulesTierB.ts` must contain **no numeric literal threshold** (same gate as `rules.ts`).

```ts
// ── B3 directional SNR ──────────────────────────────────────────────────────
/** Minimum SNR samples in ONE direction before B3 may fire. [ours] */
export const ASYMMETRY_MIN_SAMPLES_PER_DIRECTION = 3;
/** Directional mean-SNR delta above which a link is asymmetric, dB. [ours] */
export const ASYMMETRY_DELTA_DB = 6;

// ── Gateway evidence (class 3) ──────────────────────────────────────────────
/** Direct receptions at one gateway before a node counts as in its RF cell. [ours] */
export const GATEWAY_DIRECT_MIN_RECEPTIONS = 3;
/** Max nodes in one gateway cell before co-reception pairing is skipped for
 *  that gateway. Bounds the O(k^2) pair expansion on a metro gateway. [ours] */
export const GATEWAY_CELL_MAX_NODES = 64;
/** Max directional SNR samples one gateway-direct edge may contribute, so a
 *  chatty node cannot dominate an edge's SNR statistics. [ours] */
export const GATEWAY_SNR_SAMPLE_CAP = 25;

// ── B2 redundant router ─────────────────────────────────────────────────────
/** Minimum known direct neighbours on BOTH routers before B2 may fire. [ours] */
export const REDUNDANT_MIN_NEIGHBORS = 3;
/** Share of the smaller router's neighbour set the larger must cover. [ours] */
export const REDUNDANT_OVERLAP_RATIO = 0.9;

// ── B4 idle router ──────────────────────────────────────────────────────────
/** In-window corpus samples bracketing a router's area before B4 may fire. [ours] */
export const IDLE_ROUTER_MIN_AREA_PATHS = 20;
/** Hop share at/below which a router counts as idle. [ours] */
export const IDLE_ROUTER_MAX_HOP_SHARE = 0.01;
/** Peer hop share that must be EXCEEDED before idleness means anything. [ours] */
export const IDLE_ROUTER_PEER_MIN_HOP_SHARE = 0.10;

// ── B5 load-bearing CLIENT ──────────────────────────────────────────────────
/** Corpus samples with the node as an intermediate hop. [ours] */
export const LOAD_BEARING_MIN_TRACEROUTES = 10;
/** Share of the area's paths the node must carry. [ours] */
export const LOAD_BEARING_MIN_AREA_SHARE = 0.25;

// ── B6 hop horizon ──────────────────────────────────────────────────────────
/** Share of deduped observed packets arriving with hopLimit 0. [ours] */
export const HOP_HORIZON_EXHAUSTED_RATIO = 0.5;
/** Deduped observed packets before the ratio means anything. [ours] */
export const HOP_HORIZON_MIN_PACKETS = 20;

// ── B7 coverage shadow ──────────────────────────────────────────────────────
/** Positioned direct edges before a router's observed-range estimate is usable. [ours] */
export const COVERAGE_SHADOW_MIN_RANGE_SAMPLES = 3;
/** Hard ceiling on a router's observed-range estimate, metres — one freak
 *  tropo link must not swallow the whole mesh. [ours] */
export const COVERAGE_SHADOW_MAX_RANGE_M = 25_000;

// ── B1 router cluster ───────────────────────────────────────────────────────
/** Cluster size at/above which B1 is a warning. [ours] */
export const ROUTER_CLUSTER_WARNING_SIZE = 2;
/** Cluster size at/above which B1 is critical. [ours] */
export const ROUTER_CLUSTER_CRITICAL_SIZE = 4;

// ── Evidence hygiene ────────────────────────────────────────────────────────
/** Max entries in any evidence member/edge list. `mesh_issues.evidence` is
 *  MySQL TEXT (64 KB); a 200-router cluster with names would overflow it. [ours] */
export const EVIDENCE_MEMBER_LIST_CAP = 25;

/**
 * Roles that route at full priority and therefore form a B1 cluster.
 * ROUTER_LATE is deliberately EXCLUDED: it is the recommended remedy, so
 * counting it as a cluster member would make the fix re-raise the finding.
 */
export const CLUSTER_ROLES: ReadonlySet<number> = new Set([
  DeviceRole.ROUTER,
  DeviceRole.ROUTER_CLIENT,
  DeviceRole.REPEATER,
]);
```

### 2.5 `src/server/services/meshIssues/rfGraph.ts` — NEW, pure

No `databaseService` import, no I/O — same gate as `rules.ts`/`tracerouteCorpus.ts`.

```ts
export type RfEvidenceClass =
  | 'neighborInfo'          // DIRECT — a node reported hearing another
  | 'traceroute'            // DIRECT — an adjacent hop pair on an RF path
  | 'gatewayDirect'         // DIRECT — an MQTT gateway heard a node at 0 hops
  | 'gatewayCoReception';   // INFERRED — two nodes both direct at one gateway

/** Classes that assert an OBSERVED radio link. `gatewayCoReception` only
 *  asserts co-location in one gateway's cell, which is weaker: two nodes on
 *  opposite sides of a gateway's coverage need not hear each other. */
export const DIRECT_EVIDENCE_CLASSES: ReadonlySet<RfEvidenceClass>;

export interface DirectionalSnr {
  count: number;
  meanDb: number | null;
  minDb: number | null;
  maxDb: number | null;
}

export interface RfEdge {
  /** a < b, always. */
  a: number;
  b: number;
  /** `${a}-${b}`. */
  key: string;
  evidenceClasses: RfEvidenceClass[];   // sorted
  /** True when at least one DIRECT class is present. */
  direct: boolean;
  neighborInfoCount: number;
  /** Distinct corpus samples carrying this hop pair. */
  tracerouteSampleCount: number;
  /** Distinct `sample.pairKey`s — the epic's "distinct pairs, not raw samples". */
  tracerouteDistinctPairCount: number;
  gatewayDirectCount: number;
  /** Gateway nodeNums that witnessed co-reception of a and b. Sorted. */
  coReceptionGateways: number[];
  /** Total observation weight: neighborInfoCount + tracerouteDistinctPairCount
   *  + gatewayDirectCount + coReceptionGateways.length. */
  observationCount: number;
  /** SNR measured AT `a` (i.e. b -> a). */
  snrToA: DirectionalSnr;
  /** SNR measured AT `b` (i.e. a -> b). */
  snrToB: DirectionalSnr;
  sourceIds: string[];                  // sorted, deduped
  firstSeenMs: number | null;
  lastSeenMs: number | null;
}

export interface RfEvidenceAvailability {
  /** neighbor_info is always queried; false only when the query threw. */
  neighborInfo: boolean;
  /** Corpus had >=1 sample. */
  traceroute: boolean;
  /** mqtt_packet_log_enabled AND >=1 MQTT source resolved. */
  mqttGateway: boolean;
  /** packet_log_enabled. Not a graph input — carried for B6/coverage. */
  packetLog: boolean;
}

export interface RfGraphStats {
  availability: RfEvidenceAvailability;
  neighborInfoRowCount: number;
  neighborInfoEdgeCount: number;
  tracerouteHopLinkCount: number;
  tracerouteEdgeCount: number;
  /** Hops dropped because their arrival SNR was the unknown sentinel. */
  tracerouteSentinelHopsDropped: number;
  gatewayCount: number;
  gatewayDirectEdgeCount: number;
  gatewayCoReceptionEdgeCount: number;
  /** Gateways whose cell exceeded GATEWAY_CELL_MAX_NODES and was skipped. */
  gatewayCellsSkipped: number;
  totalEdgeCount: number;
  directEdgeCount: number;
  nodeCount: number;
  /** Directions with >= ASYMMETRY_MIN_SAMPLES_PER_DIRECTION samples (B3 fuel). */
  snrDirectionsWithMinSamples: number;
}

export interface RfGraph {
  /** key -> edge. */
  edges: Map<string, RfEdge>;
  /** nodeNum -> neighbours, DIRECT-evidence edges only. */
  directAdjacency: Map<number, Set<number>>;
  /** nodeNum -> neighbours, all edges including inferred. */
  adjacency: Map<number, Set<number>>;
  stats: RfGraphStats;
}

export interface NeighborEdgeInput {
  nodeNum: number | string;      // the REPORTING node (receiver)
  neighborNum: number | string;  // the node it heard (transmitter)
  snr: number | null;            // already dB — neighbor_info.snr is protobuf float
  timestamp: number;
  sourceId: string;
}

export interface GatewayDirectReceptionInput {
  gatewayNodeNum: number;
  fromNode: number;
  sourceId: string;
  receptionCount: number;
  meanRxSnr: number | null;      // already dB — mqtt_packet_log.rxSnr is float
  firstSeen: number;
  lastSeen: number;
}

export interface BuildRfGraphOptions {
  samples: TracerouteSample[];
  neighbors: NeighborEdgeInput[];
  gatewayReceptions: GatewayDirectReceptionInput[];
  availability: RfEvidenceAvailability;
  /** Test seam; defaults to GATEWAY_CELL_MAX_NODES. */
  maxGatewayCellSize?: number;
}

export function buildRfGraph(opts: BuildRfGraphOptions): RfGraph;
export function edgeKey(a: number, b: number): string;   // `${min}-${max}`
```

#### Build algorithm

**Evidence class 1 — `neighbor_info`.**
Dedup rows by `(nodeNum, neighborNum, timestamp)` keeping the first after sorting
`(timestamp asc, sourceId asc)` — the same cross-source collapse
`buildTelemetrySeries` uses, because one NeighborInfo packet arrives via TCP and
again via N MQTT gateways. Skip rows where `nodeNum === neighborNum` or either
fails `isValidRouteNode`. For each surviving row:
`snr` (when non-null and finite) is a **sample toward `nodeNum`** — the reporter
is the receiver. Bump `neighborInfoCount`, union `sourceId`, extend
`firstSeenMs`/`lastSeenMs` from `timestamp`.

> **Cardinality note (must be in the module JSDoc).** `neighbor_info` is
> rewritten per reporter per source on each NeighborInfo receipt, so a 7-day
> window returns roughly **one snapshot per (reporter, source)**, not a time
> series. Consequently `neighborInfo` alone almost never reaches
> `ASYMMETRY_MIN_SAMPLES_PER_DIRECTION`; B3 is fed mainly by traceroute and
> gateway-direct evidence. Legacy rows with `sourceId = NULL` are never returned
> by `inArray` and are therefore invisible to the graph.

**Evidence class 2 — traceroute hop pairs.**
For each `TracerouteSample`, build hop links with the extraction from §2.1:

```ts
if (hasRouteData(s.route))
  links.push(...buildLegHopLinks('forward', s.fromNodeNum, s.routeHops, s.toNodeNum, s.snrTowardsValues));
if (hasReturnPath(s.routeBackHops, s.snrBack))
  links.push(...buildLegHopLinks('return', s.toNodeNum, s.routeBackHops, s.fromNodeNum, s.snrBackValues));
```
The forward leg is `[fromNodeNum, ...routeHops, toNodeNum]` with `snrTowardsValues`;
the return leg is `[toNodeNum, ...routeBackHops, fromNodeNum]` with `snrBackValues` —
exactly `decomposeTraceroute`'s convention, and the reason `decomposeTracerouteLinks`
exists rather than a second gating implementation here.

For each link: drop when `fromNodeNum === toNodeNum`, when either end fails
`isValidRouteNode`, or when **`link.snrUnknown` is true**. Otherwise add
`traceroute` evidence, count the sample once per edge
(`tracerouteSampleCount`), record `sample.pairKey` in a per-edge set
(`tracerouteDistinctPairCount`), and — when `link.snrDb != null` — add one SNR
sample toward `link.toNodeNum`. Union `sample.sourceId`; extend first/last seen
from `sample.timestamp`.

**Evidence class 3 — MQTT gateway.**
Filter `gatewayReceptions` to `receptionCount >= GATEWAY_DIRECT_MIN_RECEPTIONS`,
`gatewayNodeNum !== fromNode`, both valid route nodes.
- **3a `gatewayDirect`:** edge `(gatewayNodeNum, fromNode)`, DIRECT.
  `gatewayDirectCount += receptionCount`. When `meanRxSnr != null`, add an SNR
  sample **toward the gateway** with weight `min(receptionCount, GATEWAY_SNR_SAMPLE_CAP)`.
- **3b `gatewayCoReception`:** group the surviving rows by `gatewayNodeNum`. For a
  cell of size `k`: if `k > maxGatewayCellSize`, skip the cell and bump
  `gatewayCellsSkipped`; else add an INFERRED edge for every unordered pair,
  appending the gateway to `coReceptionGateways`. No SNR.

**Accumulator.** Directional SNR is accumulated as `{ count, sum, min, max }` and
finalised to `DirectionalSnr` (`meanDb = sum / count`, or all-null at `count === 0`).

**Determinism.** `edges` is inserted in a deterministic order (neighbor → traceroute
→ gatewayDirect → gatewayCoReception, each iterated over pre-sorted input); every
array field (`evidenceClasses`, `sourceIds`, `coReceptionGateways`) is sorted before
return. Two runs over the same rows must produce byte-identical evidence JSON, or
`upsertFinding` churns `updatedAt` needlessly.

### 2.6 `src/server/services/meshIssues/rulesTierB.ts` — NEW, pure

```ts
export interface HopHorizonStats {
  totalPackets: number;
  exhaustedPackets: number;
  sourceIds: string[];
}

export interface TierBRuleContext {
  nodes: Map<number, PooledNode>;
  graph: RfGraph;
  samples: TracerouteSample[];
  /** nodeNum -> arrival stats. EMPTY when neither packet log is enabled. */
  hopHorizon: Map<number, HopHorizonStats>;
  /** Source ids whose type is an MQTT source (B7's "heard only via MQTT"). */
  mqttSourceIds: ReadonlySet<string>;
  nowMs: number;
}

export interface RuleSkip { rule: string; reason: string }

export function evaluateB1(ctx: TierBRuleContext): MeshIssueFinding[];
// ... B2..B7
export function evaluateAllTierB(ctx: TierBRuleContext): MeshIssueFinding[];

/** Coarse availability gates only — which rules could not run AT ALL for lack
 *  of an evidence class. Deliberately not per-node; Phase 3's coverage preface
 *  is the consumer. */
export function tierBSkips(ctx: TierBRuleContext): RuleSkip[];

/** Shared by B1 and B6 so neither depends on the other's execution order. */
export function findRouterClusters(ctx: TierBRuleContext): RouterCluster[];
```

**Shared indices, computed once per `evaluateAllTierB` call** (never per node):
- `participation: Map<nodeNum, { hopSamples: Set<sampleIdx>; endpointSamples: Set<sampleIdx> }>` — one pass over `samples × path length`. `tracerouteParticipationKind` (`tracerouteSegments.ts`) is the semantic reference and is used in tests to cross-check this index, but is not called per (node, sample) — that would re-parse the JSON columns O(n·m) times.
- `areaBin: Map<nodeNum, string>` from `Math.floor(lat / AREA_GRID_BIN_DEG)` /
  `lon`, skipping nodes with no position or `isBogusPosition`.
- `sampleBins: Array<Set<string>>` — the bins touched by each sample's participants.

Every finding's `sourceIds` must be **non-empty** (an empty array makes
`meshIssuesRoutes.toWireIssue` drop the row as an empty permission intersection).
Where edge/graph evidence yields nothing, fall back to the union of the subject
nodes' `PooledNode.sourceIds`. Cover this with a cross-rule test.

Every member/edge list in evidence is capped at `EVIDENCE_MEMBER_LIST_CAP` with a
sibling `<field>Truncated: boolean`.

---

**B1 — Router cluster.** *(≥2 ROUTER/REPEATER mutually audible)*

Subgraph over nodes whose `role ∈ CLUSTER_ROLES`. Connected components over
**all** edges (direct + inferred), size ≥ `ROUTER_CLUSTER_WARNING_SIZE`.
Recompute components over **direct-only** edges: if the component splits, it was
glued by inferred evidence — `inferredOnly = true`.

- severity: `inferredOnly` → `info`; else size ≥ `ROUTER_CLUSTER_CRITICAL_SIZE` → `critical`; else `warning`.
- confidence: `inferredOnly` → `low`; every internal link has `neighborInfo` or `traceroute` evidence → `high`; else `medium`.
- `subjectKey = clusterSubjectKey(members)`, `nodeNum = null`.
- **best-sited member** = highest direct-adjacency degree; ties → most positioned direct edges; ties → lowest nodeNum.
- evidence: `size`, `members[]` (`{nodeNum, name, role, roleName, directDegree}`), `edges[]` (`{a, b, evidenceClasses, observationCount}`), `inferredOnly`, `bestSitedNodeNum`, `bestSitedName`, `sources`.
- recommendation: *"N routers here hear each other, so each re-floods the same packets. Keep `<bestSitedName>` as the router and move the others to ROUTER_LATE — or CLIENT_BASE if they are fixed and powered."* (never "promote").

**B2 — Redundant router.** *(neighbour set ⊆ another router's, 90 %, both ≥3)*

Skip entirely when `graph.stats.directEdgeCount === 0` (the epic's "skip on
sparse adjacency data"). For each ordered pair `(A, B)` of nodes with
`role ∈ INFRA_ROLES`, using `directAdjacency` sets with each other removed:
require `|N(A)| >= REDUNDANT_MIN_NEIGHBORS`, `|N(B)| >= REDUNDANT_MIN_NEIGHBORS`,
`|N(A)| <= |N(B)|`, and `|N(A) ∩ N(B)| / |N(A)| >= REDUNDANT_OVERLAP_RATIO`.
Fire on **A** (`nodeSubjectKey(A)`), picking the single best covering B (largest
`|N(B)|`, ties → lowest nodeNum) and listing the rest in evidence.

- severity `warning`; confidence `medium`, or `low` when `|N(A)| === REDUNDANT_MIN_NEIGHBORS`.
- evidence: `role`, `roleName`, `neighborCount`, `coveredByNodeNum`, `coveredByName`, `coveredByNeighborCount`, `overlapRatio`, `sharedNeighbors[]` (capped), `otherCoveringRouters[]` (capped), `sources`.
- recommendation: *"This router's coverage is already carried by `<name>`. Two routers covering the same neighbours double every re-flood. Consider ROUTER_LATE, or CLIENT_BASE if it is fixed and powered."*

**B3 — Asymmetric link.** *(directional SNR delta > 6 dB, ≥3 samples/direction)*

For each edge with `snrToA.count >= ASYMMETRY_MIN_SAMPLES_PER_DIRECTION` **and**
`snrToB.count >= ...` and `Math.abs(snrToA.meanDb - snrToB.meanDb) > ASYMMETRY_DELTA_DB`:

- `subjectKey = edgeSubjectKey(a, b)`.
- `nodeNum` = the infra endpoint **only when exactly one endpoint has an infra role**; otherwise `null` (epic: "flag the EDGE; attach to endpoint only if infra role"). Two infra endpoints is ambiguous, so `null`.
- severity `warning` when an infra endpoint is involved, else `info`; confidence `medium`.
- evidence: `nodeA`/`nodeB` (`{nodeNum, name, role, roleName}`), `snrToA`, `snrToB`, `deltaDb`, `weakerDirection` (`'a->b' | 'b->a'`), `evidenceClasses`, `observationCount`, `sources`.
- recommendation: *"One end of this link hears the other much better than the reverse. That usually means an antenna, feedline or siting difference at the weaker end, not a role problem."*

`gatewayCoReception` edges carry no SNR and therefore can never fire B3 — by construction.

**B4 — Idle router.** *(INFO only; heard direct but <1 % hop share while peers >10 %)*

For each node R with `role ∈ INFRA_ROLES`, a usable position, and
`directAdjacency.get(R).size >= 1` ("heard direct"):
- `areaPaths` = samples whose `sampleBins` set contains R's bin. Require `areaPaths.length >= IDLE_ROUTER_MIN_AREA_PATHS`.
- `hopShare(R) = |areaPaths where R is an intermediate hop| / areaPaths.length`.
- peers = other `INFRA_ROLES` nodes in the same bin with ≥1 direct edge; `peerBestShare = max(hopShare(peer))`.
- fire when `hopShare < IDLE_ROUTER_MAX_HOP_SHARE` **and** `peerBestShare > IDLE_ROUTER_PEER_MIN_HOP_SHARE`.
- severity **`info` always** (epic guard); confidence `low`.
- evidence: `role`, `roleName`, `hopShare`, `areaPathCount`, `peerBestShare`, `peerBestNodeNum`, `peerBestName`, `directDegree`, `latBin`/`lonBin`, `sources`.
- recommendation: *"This router carries almost none of the traffic in its area while a neighbour carries most of it. Check siting and antenna before adding more infrastructure; ROUTER_LATE or CLIENT_BASE may fit it better."*

**B5 — Load-bearing CLIENT.** *(≥10 traceroutes as hop AND ≥25 % of area paths)*

For each node N with `role != null`, `role ∉ INFRA_ROLES`, a usable position:
- `hopCount = |samples where N is an intermediate hop| >= LOAD_BEARING_MIN_TRACEROUTES`.
- `areaPaths` as B4; require `areaPaths.length >= LOAD_BEARING_MIN_TRACEROUTES` and `areaShare = |areaPaths with N as hop| / areaPaths.length >= LOAD_BEARING_MIN_AREA_SHARE`.
- `fixedAndPowered = isPowered(node.batteryLevel) && !node.mobile`.
- severity: `warning` when **not** `fixedAndPowered` (a battery/mobile node the area depends on); else `info`. confidence `medium`.
- recommendation — **never ROUTER**:
  - `fixedAndPowered && role !== DeviceRole.CLIENT_BASE` → *"This client is carrying a quarter of the paths in its area. If it is permanently sited and powered, CLIENT_BASE fits it better than CLIENT."*
  - otherwise → *"This client is carrying a quarter of the paths in its area and is not a fixed, powered node. Deploying another CLIENT nearby is the right fix — do not give this one a routing role."*
- evidence: `role`, `roleName`, `hopCount`, `areaPathCount`, `areaShare`, `fixedAndPowered`, `batteryLevel`, `mobile`, `sources`.

**B6 — Hop horizon.** *(>50 % of deduped packets arrive with hopLimit = 0)*

When `ctx.hopHorizon.size === 0`, return `[]` (and `tierBSkips` reports
`{ rule: 'B6', reason: 'no packet log enabled' }`). Otherwise, for each entry with
`totalPackets >= HOP_HORIZON_MIN_PACKETS` and
`exhaustedPackets / totalPackets > HOP_HORIZON_EXHAUSTED_RATIO`:

- `subjectKey = nodeSubjectKey(nodeNum)`; severity `info`; confidence `medium`.
- `behindRouterCluster` = the node is adjacent (in `ctx.graph.adjacency`) to any member of a `findRouterClusters(ctx)` cluster. When true, the recommendation cites hop gobbling (epic guard).
- evidence: `totalPackets`, `exhaustedPackets`, `exhaustedRatio`, `behindRouterCluster`, `clusterMembers[]` (capped), `hopDeltaIsLowerBound: true`, `sources`.
- recommendation: *"Traffic from this node reaches us with no hops left, so anything further away cannot hear it."* + when `behindRouterCluster`: *" A router cluster between us and this node is consuming the hop budget; thinning that cluster will help more than raising hop limits."*

The `hopDeltaIsLowerBound` evidence flag exists because 2.7+ zero-cost favourite-router
hops skip the decrement, so this rule **under**-flags — acceptable per the epic.

**B7 — Coverage shadow.** *(INFO; MQTT-only node inside an RF-heard router's range)*

Candidate S: usable position, `positionPrecisionBits >= MOBILE_MIN_PRECISION_BITS`
(epic: "skip precision-truncated"), `directAdjacency.get(S)` empty or absent
(never RF-heard), and every id in `S.sourceIds` is in `ctx.mqttSourceIds`.

Router R: `role ∈ INFRA_ROLES`, usable position + precision, and at least
`COVERAGE_SHADOW_MIN_RANGE_SAMPLES` **positioned** direct neighbours.

```
observedRangeM(R) = min(
  max over positioned direct neighbours n of calculateDistance(R, n) * 1000,
  COVERAGE_SHADOW_MAX_RANGE_M)
```

Fire when `calculateDistance(S, R) * 1000 <= observedRangeM(R)` for at least one R;
report the **nearest** such R.

- severity `info`; confidence `low`.
- evidence: `nearestRouterNodeNum`, `nearestRouterName`, `distanceM`, `routerObservedRangeM`, `routerRangeSampleCount`, `rangeCappedAtCeiling: boolean`, `sources`.
- recommendation: *"This node only reaches us through MQTT even though it sits inside `<router>`'s demonstrated RF range. Check antenna and siting at one end or the other — no role change is implied."*

### 2.7 `src/db/repositories/mqttPacketLog.ts` — MODIFY (2 new aggregates)

See §3.1 and §3.2 for the exact queries.

### 2.8 `src/db/repositories/packetLog.ts` — MODIFY (1 new aggregate)

See §3.2.

### 2.9 `src/server/services/meshIssuesAnalysisService.ts` — MODIFY

`runAnalysis` gains steps 5b–5e and step 6b. Existing steps are untouched.

```ts
export interface MeshIssuesCoverage {
  evidence: RfEvidenceAvailability;
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
  skippedRules: RuleSkip[];
}

export interface MeshIssuesRunResult {
  /* ...Phase 1 fields unchanged... */
  corpusStats: TracerouteCorpusStats;
  coverage: MeshIssuesCoverage;   // NEW
}
```

Changes, in order:

1. **Step 1** already resolves `sourceIds`; also build
   `const mqttSourceIds = new Set(allSources.filter(s => enabled && isMqttSourceType(s.type)).map(s => s.id))`.
2. **Step 5** — destructure `samples` as well as `stats` (Phase 1 discarded it).
3. **Step 5b — neighbours (always):**
   `const { items: neighborRows } = await databaseService.analysis.getNeighbors({ sourceIds, sinceMs })`.
   One bounded query, no per-node loop.
4. **Step 5c — gateway receptions (conditional):** only when
   `await mqttPacketLogService.isEnabled()` **and** `mqttSourceIds.size > 0`.
   One aggregate (§3.1), capped. Otherwise `[]` and `availability.mqttGateway = false`.
5. **Step 5d — graph:** `const graph = buildRfGraph({ samples, neighbors, gatewayReceptions, availability })`.
6. **Step 5e — hop horizon:** §3.3's preference rule.
7. **Step 6b:**
   ```ts
   const tierBCtx: TierBRuleContext = { nodes, graph, samples, hopHorizon, mqttSourceIds, nowMs };
   findings.push(...evaluateAllTierB(tierBCtx));
   const skippedRules = tierBSkips(tierBCtx);
   ```
8. **Step 7** unchanged — `persistFindings` is issue-type agnostic.

Each new load is wrapped so a failure degrades rather than aborts the run:
a thrown neighbours/gateway/hop-horizon query logs a warning, sets the matching
`availability` flag to `false`, and the run continues with the remaining evidence.
(A Tier B rule failing individually is already covered by `runRulesIsolated`.)

**Bounds:** `MAX_CORPUS_PAGES` unchanged. New caps: `MQTT_DIRECT_RECEPTION_MAX_ROWS = 20_000`,
`HOP_ARRIVAL_MAX_ROWS = 20_000`, both exported for the service test.

### 2.10 `src/server/services/meshIssuesScheduler.ts` — no logic change

`MeshIssuesStatus.lastRunResult` is typed as `MeshIssuesRunResult`, so widening
that interface surfaces `coverage` on `GET /api/analysis/mesh-issues/status`
automatically. **No scheduler edit is needed** beyond the type flowing through.

### 2.11 `src/components/Analysis/meshIssueTypes.ts` — MODIFY (additive)

```ts
export const ISSUE_TYPE_LABELS: Record<string, string> = {
  ...,
  B1_router_cluster:      'Router cluster',
  B2_redundant_router:    'Redundant router',
  B3_asymmetric_link:     'Asymmetric link',
  B4_idle_router:         'Idle router',
  B5_load_bearing_client: 'Load-bearing client',
  B6_hop_horizon:         'At the hop horizon',
  B7_coverage_shadow:     'Coverage shadow',
};

export const ISSUE_TYPE_BLURBS: Record<string, string> = {
  ...,
  B1_router_cluster:      'Several routers in one spot hear each other, so each one re-floods the same packets.',
  B2_redundant_router:    'This router reaches almost the same neighbours as another one nearby.',
  B3_asymmetric_link:     'One end of this link hears the other far better than the reverse.',
  B4_idle_router:         'This router is heard directly but carries almost none of its area’s traffic.',
  B5_load_bearing_client: 'A client node is carrying a large share of the paths through its area.',
  B6_hop_horizon:         'Traffic from this node arrives with no hops left, so nodes further out cannot hear it.',
  B7_coverage_shadow:     'This node only reaches us over MQTT despite sitting inside a router’s demonstrated RF range.',
};

/** A node reference embedded in evidence (cluster members, shared neighbours). */
export interface EvidenceNodeRef {
  nodeNum: number;
  name?: string | null;
  role?: number | null;
  roleName?: string | null;
  directDegree?: number | null;
}
export function isEvidenceNodeRefArray(v: unknown): v is EvidenceNodeRef[];

export interface EvidenceDirectionalSnr {
  count: number;
  meanDb: number | null;
  minDb: number | null;
  maxDb: number | null;
}
export function isEvidenceDirectionalSnr(v: unknown): v is EvidenceDirectionalSnr;

/** `-7.5 dB (n=6)`, or an em dash when there is no usable mean. */
export function formatSnrDirection(v: EvidenceDirectionalSnr): string;

/** `!hex` fallback for a node with no name in evidence. Mirrors the server helper. */
export function hexNodeId(nodeNum: number): string;

/** Evidence keys rendered by dedicated components, excluded from the generic grid. */
export const STRUCTURED_EVIDENCE_KEYS: ReadonlySet<string>;
  // 'members', 'edges', 'sharedNeighbors', 'otherCoveringRouters',
  // 'clusterMembers', 'nodeA', 'nodeB', 'snrToA', 'snrToB'
```

### 2.12 `src/components/Analysis/MeshIssuesReport.tsx` — MODIFY

`FindingCard` currently pushes every evidence value through `formatEvidenceValue`,
which renders an object as `JSON.stringify` and an object array as
`[object Object], [object Object]`. Split the entries:

```tsx
const entries = Object.entries(issue.evidence).filter(([k]) => k !== 'recommendation');
const structured = entries.filter(([k]) => STRUCTURED_EVIDENCE_KEYS.has(k));
const plain      = entries.filter(([k]) => !STRUCTURED_EVIDENCE_KEYS.has(k));
```

Two new presentational sub-components in the same file (the report is 288 lines;
splitting the file is not warranted):

- `<MemberList label value />` — renders an `EvidenceNodeRef[]` as chips:
  `name ?? hexNodeId(nodeNum)` plus `roleName` when present. Falls back to the
  generic `Field` when `isEvidenceNodeRefArray` is false (defensive: evidence is
  parsed JSON from the database).
- `<SnrDirections issue />` — when both `snrToA` and `snrToB` pass the guard,
  renders a two-row table labelled from `nodeA`/`nodeB`:
  `"<A> → <B>"` = `formatSnrDirection(snrToB)` (SNR measured at B) and the reverse.
  The arrow direction is the part reviewers should check against §2.5's convention.

Truncation flags (`membersTruncated` etc.) render as a muted "+N more" line, not
as a raw `Yes/No` field. Everything else keeps the existing generic grid.

### 2.13 `src/components/Analysis/MeshIssuesReport.module.css` — MODIFY

Add `.memberList`, `.memberChip`, `.memberChipRole`, `.snrTable`, `.snrRow`,
`.snrLabel`, `.snrValue`, `.truncationNote`. CSS-module only (CLAUDE.md
containment rule); colours via `var(--color-*)` tokens **with no fallback**
(existing convention in this module).

---

## 3. New repository methods

All three follow the same rules: single statement, explicit `.limit()`,
`inArray` source scoping, `normalizeBigInts` on the result, no dialect branch
(plain `GROUP BY` + `CASE WHEN`, which is identical standard SQL on all three
backends — the precedent `getHopCounts` sets at `analysis.ts:659`).

### 3.1 `MqttPacketLogRepository.getDirectReceptionsByGateway` — NEW

```ts
export interface MqttDirectReceptionRow {
  gatewayNodeNum: number;
  fromNode: number;
  sourceId: string;
  receptionCount: number;
  meanRxSnr: number | null;
  firstSeen: number;
  lastSeen: number;
}

/**
 * Per-(gateway, node) DIRECT receptions in-window — the epic's third RF
 * evidence class. "Direct" is `hopLimit = hopStart AND hopStart > 0`: no hop
 * was consumed, and hopStart 0 means UNKNOWN, never direct (epic hop-delta
 * guard). Same predicate NeighborsRepository.getDirectNeighborRssiAsync uses
 * against packet_log.
 *
 * CAVEAT for the caller: hopStart - hopLimit is a LOWER bound, because 2.7+
 * zero-cost favourite-router hops skip the decrement. So a small number of
 * genuinely multi-hop packets will look direct. This over-counts adjacency
 * slightly; rules treat gateway evidence as weaker than neighbor_info for
 * exactly this reason.
 */
async getDirectReceptionsByGateway(q: {
  sourceIds: string[];
  since: number;
  limit?: number;   // default MQTT_DIRECT_RECEPTION_MAX_ROWS
}): Promise<MqttDirectReceptionRow[]>
```

WHERE `inArray(sourceId, q.sourceIds)`, `gte(timestamp, q.since)`,
`isNotNull(gatewayNodeNum)`, `isNotNull(fromNode)`,
`ne(gatewayNodeNum, fromNode)`, `eq(hopLimit, hopStart)`, `gt(hopStart, 0)`.
`GROUP BY sourceId, gatewayNodeNum, fromNode`.
SELECT `count(*)`, `avg(rxSnr)`, `min(timestamp)`, `max(timestamp)`.
`ORDER BY count(*) DESC` then `.limit(...)` — so if the cap bites, the strongest
evidence survives. Returns `[]` immediately when `sourceIds.length === 0`.

MySQL `ONLY_FULL_GROUP_BY` is satisfied: every non-aggregated selected column is
in the `GROUP BY`.

### 3.2 Hop-arrival aggregates — NEW (one per packet log)

```ts
export interface PacketHopArrivalRow {
  nodeNum: number;
  totalPackets: number;      // distinct (from, packetId) observations
  exhaustedPackets: number;  // of those, ones whose BEST observation had hopLimit 0
}
```

`PacketLogRepository.getHopArrivalCountsSince({ since, sourceIds?, limit? })`
and `MqttPacketLogRepository.getHopArrivalCountsSince({ since, sourceIds, limit? })`.

Both are a two-level aggregate — the inner level is the epic's mandated
**dedup by `(packetId, fromNode)`**, taking `MAX(hopLimit)` so a packet that
still had life at *any* vantage is not counted as exhausted:

```sql
SELECT nodeNum, COUNT(*) AS totalPackets,
       SUM(CASE WHEN maxHopLimit = 0 THEN 1 ELSE 0 END) AS exhaustedPackets
FROM (
  SELECT from_node AS nodeNum, packet_id AS pid, MAX(hop_limit) AS maxHopLimit
  FROM packet_log
  WHERE timestamp >= ?
    AND direction = 'rx'          -- packet_log only; our own TX is not an arrival
    AND packet_id IS NOT NULL
    AND hop_limit IS NOT NULL
    AND hop_start IS NOT NULL AND hop_start > 0   -- hopStart 0 = unknown
    [AND sourceId IN (...)]
  GROUP BY from_node, packet_id
) t
GROUP BY nodeNum
ORDER BY COUNT(*) DESC
LIMIT ?
```

Build with Drizzle's subquery `.as('t')` (the pattern `getHopCounts` uses for its
`newest` subquery). The MQTT variant is identical with
`mqtt_packet_log` / `fromNode` / `packetId` / `hopLimit` / `hopStart` and **no**
`direction` clause (every MQTT row is a reception).

### 3.3 Wiring: `src/db/repositories/index.ts`, `src/services/database.ts`

Export the three new row types from `index.ts` alongside their repositories.
Add three façade methods on `DatabaseService` with the `Async` suffix
(CLAUDE.md): `getMqttDirectReceptionsByGatewayAsync`,
`getPacketHopArrivalCountsAsync`, `getMqttPacketHopArrivalCountsAsync`.

**Hop-horizon preference rule (in the service, not the repository):**

```
if packetLogService.isEnabled():
    rows = getPacketHopArrivalCountsAsync(...)
    if rows.length > 0 -> source = 'packet_log'
if source is null and mqttPacketLogService.isEnabled() and mqttSourceIds.size > 0:
    rows = getMqttPacketHopArrivalCountsAsync(...)
    if rows.length > 0 -> source = 'mqtt_packet_log'
if source is null -> hopHorizon = empty map, B6 skips
```

The two logs are **never merged**: the same packet appears in both, and a
cross-table dedup by `packetId` cannot be expressed as one bounded statement.
`packet_log` wins because it is our own RF vantage, which is what "hop horizon"
means. Recorded in `coverage.hopHorizonSource`.

Note `packet_log`'s default retention is **24 h**
(`packetLogService.getMaxAgeHours()`), far shorter than the 168 h analysis
lookback. The service passes `sinceMs` regardless; the aggregate simply sees
whatever survived pruning. Surface `hopHorizonSource` so the Phase 3 preface can
say so.

---

## 4. Test plan

Standard Vitest suite only. No system tests, no new labels.

### 4.1 `src/utils/tracerouteSegments.test.ts` — EXTEND
- `buildLegHopLinks` pairs arrival SNR with the **receiving** end, including the trailing element for the final endpoint.
- An invalid intermediate hop is dropped and the surviving segments keep the correct arrival SNR (the alignment invariant).
- Raw `-128` produces `snrDb === null`, `snrUnknown === true`; raw `-30` produces `snrDb === -7.5`, `snrUnknown === false`.
- `decomposeTracerouteLinks` gates each leg independently (forward-only and return-only rows both work).
- **Regression gate:** every pre-existing assertion in this file and in the four consumer suites passes unchanged.

### 4.2 `src/server/services/meshIssues/rfGraph.test.ts` — NEW
- Each evidence class in isolation produces the expected edge, direction and counts.
- `neighbor_info` SNR is attributed to the **reporter** (`nodeNum`), not the neighbour.
- Cross-source duplicate NeighborInfo (same `(nodeNum, neighborNum, timestamp)`, two `sourceId`s) collapses to one sample but unions both `sourceIds`.
- A traceroute hop whose arrival SNR is the sentinel is **excluded** and counted in `tracerouteSentinelHopsDropped`.
- `tracerouteDistinctPairCount` counts distinct `pairKey`s, not raw samples (two samples from the same pair in different buckets ⇒ 1).
- `gatewayDirect` creates a DIRECT edge with SNR toward the gateway; `receptionCount` above `GATEWAY_SNR_SAMPLE_CAP` contributes a capped weight.
- A gateway cell of `k` nodes yields `k*(k-1)/2` inferred edges; a cell above `maxGatewayCellSize` yields none and bumps `gatewayCellsSkipped`.
- `gatewayNodeNum === fromNode` rows are dropped; `receptionCount` below `GATEWAY_DIRECT_MIN_RECEPTIONS` is dropped.
- `directAdjacency` excludes inferred-only edges; `adjacency` includes them.
- Union: an edge attested by all four classes has all four in `evidenceClasses`, sorted, with merged SNR and unioned `sourceIds`.
- **Determinism:** two `buildRfGraph` calls on shuffled input produce identical `JSON.stringify` of every edge.
- Empty/degraded inputs return an empty graph with correct `availability` flags — never throw.

### 4.3 `src/server/services/meshIssues/rulesTierB.test.ts` — NEW
Per rule: one firing case, one just-below-threshold non-firing case, and each guard.
- **B1** — 2 routers → warning; 4 → critical; inferred-only glue → info + `low`; ROUTER_LATE never counts as a member; `bestSitedNodeNum` picks the highest direct degree; `clusterSubjectKey` is identical across two runs with the same membership and differs when membership changes.
- **B2** — 90 % overlap fires on the smaller router; 89 % does not; `|N| = 2` does not; `directEdgeCount === 0` skips the whole rule.
- **B3** — 7 dB delta with 3+3 samples fires; 5 dB does not; 2 samples in one direction does not; `nodeNum` is the infra endpoint with exactly one infra end, and `null` with two; a `gatewayCoReception`-only edge never fires.
- **B4** — severity is `info` in every firing case; 19 area paths does not fire; peer share at exactly 10 % does not fire.
- **B5** — recommendation contains `CLIENT_BASE` for a fixed+powered node and "another CLIENT" otherwise; severity is `warning` for a battery node and `info` for a powered one; a node already `CLIENT_BASE` gets the "another CLIENT" wording.
- **B6** — empty `hopHorizon` returns `[]` and `tierBSkips` reports it; 19 packets does not fire; exactly 50 % does not fire (strict `>`); `behindRouterCluster` flips the recommendation text.
- **B7** — a node with any direct edge never fires; a node with a non-MQTT `sourceId` never fires; precision below `MOBILE_MIN_PRECISION_BITS` is skipped; the range ceiling clamps and sets `rangeCappedAtCeiling`.
- **Cross-rule assertions (mirroring `rules.test.ts`'s existing pattern):**
  1. No Tier B recommendation contains "promote" or suggests the `ROUTER` role.
  2. Every emitted finding has a non-empty `sourceIds`.
  3. Every `subjectKey` is ≤ 128 characters and every `issueType` ≤ 64.
  4. Every member/edge list respects `EVIDENCE_MEMBER_LIST_CAP`.
- `evaluateAllTierB` isolation: a rule stubbed to throw does not stop the others.

### 4.4 `src/server/services/meshIssues/ruleRunner.test.ts` — NEW
Throw isolation, ordering, and the log message shape.

### 4.5 Repository tests — EXTEND
`src/db/repositories/mqttPacketLog.test.ts` and `packetLog.test.ts`:
- The direct-reception predicate accepts `hopLimit === hopStart > 0` and rejects `hopStart = 0`, `hopLimit < hopStart`, and `gatewayNodeNum === fromNode`.
- Grouping and `avg(rxSnr)` are correct; the `limit` keeps the highest-count rows.
- Hop-arrival dedup: the same `(packetId, fromNode)` seen at two vantages with hopLimit 0 and 2 counts as **one** non-exhausted packet.
- Source scoping: a row on an unlisted source never appears.
- These suites already run against SQLite, PostgreSQL and MySQL — **bring the containers up** before claiming the aggregates are verified (CLAUDE.md multi-database section); confirm coverage via `numPendingTests`, not `success`.

### 4.6 `src/server/services/meshIssuesAnalysisService.test.ts` — EXTEND
Mock `evaluateAllTierB` and `buildRfGraph` the way `evaluateAllTierA` is already mocked.
- `samples` from the corpus reach `buildRfGraph` (Phase 1 discarded them).
- `getNeighbors` is called exactly **once** with the resolved `sourceIds` and `sinceMs` — no per-node loop.
- Gateway aggregate is **not** called when `mqttPacketLogService.isEnabled()` is false, or when no MQTT source is enabled; `availability.mqttGateway` is `false` in both cases.
- Hop-horizon preference: packet_log wins when non-empty; falls back to MQTT when packet_log is enabled but empty; `hopHorizonSource` is `null` when neither is available.
- A throwing neighbours/gateway/hop-horizon query degrades (flag false, run completes) instead of aborting.
- `coverage` is populated on the result and `findingCount` includes Tier B findings.
- Zero-mesh-impact assertions from Phase 1 still hold (no packets, no `dataEventEmitter`).

### 4.7 `src/server/routes/meshIssuesRoutes.test.ts` — EXTEND
Use the existing harness. Add:
- An edge finding (`nodeNum: null`, `subjectKey: 'edge:1-2'`) and a cluster finding round-trip through `toWireIssue` with `nodeName: null`.
- The per-source intersection still drops a Tier B finding whose `sourceIds` the caller cannot read.

### 4.8 `src/components/Analysis/MeshIssuesReport.test.tsx` — EXTEND
- A B1 finding renders member names (and `!hex` for a member with no name), not `[object Object]`.
- A B3 finding renders both SNR directions with the correct endpoint labels and arrow direction.
- Truncation renders as "+N more", not `Yes`.
- Malformed structured evidence (a string where an array is expected) falls back to the generic field instead of throwing.

---

## 5. Work packages

Five packages for Sonnet implementers. WP1 and WP2 have no dependencies and can
run in parallel.

### WP1 — Shared primitives *(no dependencies)*
`src/utils/tracerouteSegments.ts` (§2.1), `meshIssues/types.ts` (§2.2),
`meshIssues/ruleRunner.ts` (§2.3) + `rules.ts` delegating to it,
`meshIssues/thresholds.ts` (§2.4). Tests §4.1, §4.4.

**Acceptance:** every pre-existing traceroute-segment/renderer suite passes
unchanged (this is a refactor); `evaluateAllTierA` behaviour is byte-identical;
`clusterSubjectKey` output is ≤ 128 chars and stable across calls; `npm run lint:ci`
clean (in-repo failures only).

### WP2 — Data layer *(no dependencies; parallel with WP1)*
Three repository aggregates (§3.1, §3.2), `index.ts` exports, three
`DatabaseService` `Async` façade methods (§3.3). Tests §4.5.

**Acceptance:** all three aggregates return correct results on SQLite,
PostgreSQL **and** MySQL with the test containers up (verify via
`numPendingTests`); every query has an explicit `.limit()`; no raw SQL outside
the repository; no dialect branch.

### WP3 — RF adjacency graph *(depends: WP1)*
`src/server/services/meshIssues/rfGraph.ts` (§2.5). Tests §4.2.

**Acceptance:** zero `databaseService` import in the module's import list; the
determinism test passes on shuffled input; all four evidence classes and their
union behave per §4.2; degraded inputs never throw.

### WP4 — Tier B rules *(depends: WP1, WP3)*
`src/server/services/meshIssues/rulesTierB.ts` (§2.6). Tests §4.3.

**Acceptance:** no numeric literal threshold in the file; the four cross-rule
assertions pass; shared indices are built once per `evaluateAllTierB` call (assert
by spying on the index builder, or by a complexity comment plus a 500-sample
timing sanity test); `tierBSkips` reports every coarse gate.

### WP5 — Service integration + report *(depends: WP2, WP3, WP4)*
Two independent halves; the wire contract is frozen in §2.9/§2.11, so they may be
implemented by two agents in parallel.
- **5a backend:** `meshIssuesAnalysisService.ts` (§2.9), coverage plumbing. Tests §4.6, §4.7.
- **5b frontend:** `meshIssueTypes.ts` (§2.11), `MeshIssuesReport.tsx` (§2.12), CSS module (§2.13). Tests §4.8.

**Acceptance:** full Vitest suite green (0 failures) with PG + MySQL containers up;
`GET /api/analysis/mesh-issues/status` returns `lastRunResult.coverage` after a run;
a run against the live dev DB produces at least one Tier B finding **or** a
`coverage` payload that explains why not; the report renders member lists and SNR
directions correctly (screenshot attached to the PR per the UI-PR rule).

### Phase exit
Full suite green including PG/MySQL; graph rules validated against the live dev
DB in the Docker dev container (deploy with `-f docker-compose.dev.local.yml`);
UI screenshot on the PR; `/ci-monitor` green; PR merged; the Phase log in
`MESH_ISSUES_EPIC.md` updated.

---

## 6. Spec-level decisions and refinements

Each either resolves an open question in the epic or goes beyond it. **Veto
candidates are marked.** All new thresholds are `[ours]` and Phase-3-tunable.

**D1. A fourth evidence sub-class, `gatewayDirect`, is added.** The epic names
three classes and describes the MQTT one only as *co*-reception. But its own
locked decision says "MQTT *gateway receptions* count as RF observations at the
gateway's antenna" — which means a gateway that heard a node at
`hopLimit === hopStart > 0` has itself observed a real RF link, with a real
measured `rxSnr`. Splitting the class into `gatewayDirect` (DIRECT, with SNR) and
`gatewayCoReception` (INFERRED, no SNR) is strictly more information for no extra
query, and it is what makes B3 viable on MQTT-heavy installs. **Veto candidate.**

**D2. Direct vs inferred evidence is a first-class distinction, and inferred-only
B1 clusters are downgraded, not suppressed.** Two nodes both audible at one
gateway need not hear each other — they can sit on opposite edges of its
coverage. Treating that as equal to a NeighborInfo edge would let a single metro
gateway cluster every router in a city. Rules therefore compute their primary
determination on `directAdjacency`; a B1 component held together only by inferred
edges drops to `info` / `low` confidence rather than vanishing (the epic does put
co-reception in the adjacency *union*, so suppressing it entirely would
contradict the epic). **Veto candidate** — the alternative is to exclude inferred
edges from B1/B2 outright.

**D3. Traceroute hops whose arrival SNR is `UNKNOWN_SNR_SENTINEL` are dropped
from the graph.** The epic locks "RF topology comes only from RF observations.
MQTT-transport hops are excluded", and the `-32` sentinel is the marker the
codebase already uses for an MQTT-injected hop (#2931). *Investigation:* the
sentinel is not strictly MQTT-only — a relay-role hop or older firmware can also
produce it — so dropping it also discards some genuine RF adjacency. That is an
**under**-count, which is the safe direction for rules whose recommendations are
demotions. Counted in `stats.tracerouteSentinelHopsDropped` so the Phase 3
preface can report it. **Veto candidate** (the alternative is to keep the hop as
adjacency with no SNR contribution).

**D4. `CLUSTER_ROLES` excludes `ROUTER_LATE`.** B1's recommendation is to move
all but the best-sited node to ROUTER_LATE. If ROUTER_LATE counted as a cluster
member, applying the fix would re-raise the finding forever. `ROUTER_CLIENT` is
included (it routes at full priority) even though A1 already flags it as
deprecated — the two findings are about different problems.

**D5. B1's subject key is `cluster:${size}:${djb2 hex}`, and a membership change
is a new finding.** `mesh_issues.subjectKey` is `varchar(128)` on MySQL, so a raw
sorted member list is not storable for a large cluster. Carrying `size` outside
the digest prevents two different-sized clusters colliding on a 32-bit hash.
Consequence, deliberate: a cluster that gains a router opens a new finding and
the old one auto-closes after `AUTO_CLOSE_CLEAN_RUNS` — which is honest, because
the old cluster no longer exists. `djb2Hash` is reused rather than adding a hash.

**D6. B3 attaches `nodeNum = null` when BOTH endpoints have infra roles.** The
epic says "attach to endpoint only if infra role"; with two infra ends there is
no principled choice, and picking one would put the finding on an arbitrary node.
The edge `subjectKey` still makes the finding stable and addressable.

**D7. B7 uses an observed-range estimator instead of `rf/propagation.ts`.
[Heuristic weakened — see §7.]**

**D8. B6 reads one packet log, never both merged.** Merging `packet_log` and
`mqtt_packet_log` would double-count every packet observed by both, and
de-duplicating across two tables by `packetId` cannot be expressed as one bounded
statement. `packet_log` is preferred (our own RF vantage is what "hop horizon"
means), with MQTT as a fallback when packet_log is enabled but empty.
`coverage.hopHorizonSource` records which fed the rule. **Veto candidate.**

**D9. B6's dedup takes `MAX(hopLimit)` per `(packetId, fromNode)`.** The epic
mandates dedup by `(packetId, fromNode)` but not the tie-break. Taking the
maximum means a packet that still had hops left at *any* vantage is not counted
as exhausted — the conservative reading, which keeps B6 from firing on a single
unlucky gateway.

**D10. B5 severity is conditional on power, and a node already in `CLIENT_BASE`
gets the "another CLIENT nearby" wording.** The epic gives B5 no severity. A
load-bearing client running on a battery is a real fragility (`warning`); one that
is already fixed and powered is informational (`info`). Recommending CLIENT_BASE
to a node that already has it would be noise.

**D11. B4 is `info` in every case, unconditionally.** The epic's guard says "INFO
severity only". Implemented as a hard-coded severity with a test asserting it,
not as a default that a future edit could raise.

**D12. Tier B evidence embeds node names pooled across all Meshtastic sources,
and the GET route does not redact names *inside* evidence.** This exposure
already exists in Phase 1 (A2b embeds `longName` per binned node) and Phase 2
widens it. The route's `sourceIds` intersection still drops any finding the
caller cannot read at all. Deliberately **not** fixed here — evidence-level name
redaction is a cross-cutting change to `toWireIssue` that belongs with Phase 3's
dismiss/acknowledge work. **Added to the Phase 3 backlog in the epic's Phase log.**

**D13. Coarse skip reporting only.** `tierBSkips` reports "this rule could not run
at all for lack of an evidence class", not per-node degradation. Per-node reasons
would need every rule to emit a parallel diagnostic stream; the Phase 3 coverage
preface (C3) only needs the coarse form.

**D14. Evidence lists are capped at 25 entries.** `mesh_issues.evidence` is MySQL
`TEXT` (64 KB). A 200-router cluster with names would overflow it and fail the
insert on MySQL only — a bug that would never reproduce on the SQLite default.

**D15. No new settings keys, no new migration.** Tier B thresholds stay code
constants until Phase 3's settings UI (the epic assigns threshold settings to
Phase 3), and `mesh_issues` already stores everything Tier B needs.

---

## 7. Epic heuristics weakened or deferred

Only one, plus one clarification.

### 7.1 B7 — "via `rf/propagation.ts`" replaced by an observed-range estimator

**Epic text:** *"B7 Coverage shadow: node heard only via MQTT within estimated RF
range of an RF-heard router — via `rf/propagation.ts` `[ours]`."*

**Investigation.** `src/server/services/rf/propagation.ts` exports
`wavelengthM`, `fresnelRadiusM`, `earthBulgeM`, `freeSpaceLossDb`,
`knifeEdgeLossDb`, `sphericalEarthDiffractionLossDb` and `evaluateLink`. The only
one that answers "is this link plausible" is `evaluateLink(samples, inputs,
budget)`, and it requires:
- `samples: TerrainSample[]` — a full DEM elevation profile from tx to rx. Every
  sample is an elevation lookup; the module explicitly handles DEM gaps
  (`hasDataGaps`), so a gap-free profile is not guaranteed either.
- `inputs: { frequencyHz, txHeightM, rxHeightM, kFactor? }` — we store none of
  these per node. Antenna height in particular is not in `nodes`.
- `budget: { txPowerDbm, txGainDbi, rxGainDbi, lossesDb, sensitivityDbm }` — also
  not per node.

So calling it would mean (a) inventing three or four unmeasured RF parameters per
node, and (b) an async DEM fetch per candidate pair inside what §2.6 requires to
be a pure synchronous rule, over O(shadow candidates × positioned routers) pairs.
The result would look authoritative while resting entirely on invented inputs.

**Replacement.** Each router's range estimate is derived from **its own observed
links**: the greatest great-circle distance to any node it has a *direct*-evidence
edge with (both positioned), clamped to `COVERAGE_SHADOW_MAX_RANGE_M` and
requiring `COVERAGE_SHADOW_MIN_RANGE_SAMPLES` positioned neighbours. This needs
no DEM, no frequency, no antenna height and no invented link budget; it
self-calibrates per mesh and per router; and it degrades to "no finding" rather
than to a confident wrong answer when a router has too few positioned neighbours.

**What is lost.** Terrain is ignored, so a node behind a ridge inside the
router's *radial* range will be flagged. That is why B7 stays `info` / `low`
confidence with a recommendation that only says "check antenna and siting" and
explicitly implies no role change. `rangeCappedAtCeiling` is surfaced in evidence
so a finding resting on the clamp is visible as such.

**Decision needed from the user.** Three options, in increasing cost:
1. **(proposed)** observed-range estimator as above;
2. observed range **plus** a radio-horizon ceiling from
   `4.12·(√h₁+√h₂)` km — needs a single assumed antenna height constant, adding
   one more `[ours]` number;
3. defer B7 to Phase 3 and do it properly with the terrain/DEM path the Site
   Planner already uses (async, per-pair, and a much larger piece of work).

### 7.2 B3 clarification — the epic's "≥3 samples per direction" is rarely reachable from `neighbor_info` alone

Not a weakening, but it changes what B3 will actually fire on and should be
recorded. `neighbor_info` is rewritten per reporter per source on each NeighborInfo
receipt, so a 7-day window yields roughly **one row per (reporter, source)** — not
a time series. Directional SNR therefore comes overwhelmingly from traceroute hop
links and gateway-direct receptions. On an install with traceroutes off *and* MQTT
packet logging off, B3 will effectively never fire. This is surfaced through
`coverage.snrDirectionsWithMinSamples`, so the Phase 3 preface can say so plainly
rather than leaving the user wondering why a rule is silent.

### 7.3 Not weakened, but worth restating

- **B6 under-flags** because `hopStart − hopLimit` is a lower bound (2.7+
  zero-cost favourite-router hops). The epic already accepts this; the evidence
  carries `hopDeltaIsLowerBound: true` so the report can say it.
- **Gateway direct-reception over-counts slightly** for the same reason — a
  zero-cost hop can make a multi-hop packet look direct. Mitigated by
  `GATEWAY_DIRECT_MIN_RECEPTIONS` and by gateway evidence never being the sole
  basis for a `warning`-or-above finding (D2).
