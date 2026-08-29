/**
 * Tier B mesh-issue rules for Mesh Issues Analysis (#4964, Phase 2 WP4).
 *
 * Pure — no `databaseService` import, no I/O. Every rule takes a
 * `TierBRuleContext` built by the service (WP5) from the RF adjacency graph
 * (`rfGraph.ts`, WP3), the pooled node snapshot (`nodeSnapshot.ts`, Phase 1),
 * the traceroute corpus (`tracerouteCorpus.ts`, Phase 1) and the hop-horizon
 * aggregate (WP2), and returns findings.
 *
 * Every numeric threshold lives in `thresholds.ts` — this file must not
 * contain a numeric literal threshold (unit-conversion factors, e.g. km->m,
 * are not thresholds and are fine, matching the precedent in `rules.ts`'s
 * `POWER_WINDOW_HOURS * 3600_000`).
 *
 * No recommendation in this file may contain the word "promote" or suggest
 * the bare ROUTER role — every recommendation steers toward CLIENT,
 * CLIENT_BASE or ROUTER_LATE. See `rulesTierB.test.ts`'s cross-rule
 * assertion (mirrors `rules.test.ts`'s Tier A guard).
 *
 * SHARED INDICES (spec §2.6): `buildParticipationIndex` (B4/B5) and
 * `findRouterClustersCore` (B1/B6) are each expensive to build (one pass over
 * `samples × path length`, respectively over the RF graph's connected
 * components) and are built exactly ONCE per `evaluateAllTierB` call, then
 * threaded into the `*Impl` helpers below — never rebuilt per node and never
 * rebuilt once per consuming rule. The public `evaluateB1`/`evaluateB4`/
 * `evaluateB5`/`evaluateB6` wrappers exist for standalone/unit-test use and
 * build a fresh index each time they're called directly; that per-call cost
 * is only paid once each when driven through `evaluateAllTierB`.
 */
import { DeviceRole, ROLE_NAMES } from '../../../constants/index.js';
import { calculateDistance } from '../../../utils/distance.js';
import { isBogusPosition } from '../../../utils/nullIsland.js';
import { isPowered } from '../../utils/poweredState.js';
import {
  MESH_ISSUE_TYPES,
  nodeSubjectKey,
  edgeSubjectKey,
  clusterSubjectKey,
  type MeshIssueFinding,
  type MeshIssueSeverity,
  type MeshIssueConfidence,
} from './types.js';
import { runRulesIsolated } from './ruleRunner.js';
import type { PooledNode } from './nodeSnapshot.js';
import type { TracerouteSample } from './tracerouteCorpus.js';
import type { RfGraph } from './rfGraph.js';
import {
  CLUSTER_ROLES,
  INFRA_ROLES,
  ROUTER_CLUSTER_WARNING_SIZE,
  ROUTER_CLUSTER_CRITICAL_SIZE,
  REDUNDANT_MIN_NEIGHBORS,
  REDUNDANT_OVERLAP_RATIO,
  ASYMMETRY_MIN_SAMPLES_PER_DIRECTION,
  IDLE_ROUTER_MIN_AREA_PATHS,
  IDLE_ROUTER_MAX_HOP_SHARE,
  IDLE_ROUTER_PEER_MIN_HOP_SHARE,
  LOAD_BEARING_MIN_TRACEROUTES,
  LOAD_BEARING_MIN_AREA_SHARE,
  HOP_HORIZON_EXHAUSTED_RATIO,
  HOP_HORIZON_MIN_PACKETS,
  COVERAGE_SHADOW_MIN_RANGE_SAMPLES,
  COVERAGE_SHADOW_MAX_RANGE_M,
  MOBILE_MIN_PRECISION_BITS,
  AREA_GRID_BIN_DEG,
  EVIDENCE_MEMBER_LIST_CAP,
  type ResolvedMeshIssueThresholds,
} from './thresholds.js';

// ---------------------------------------------------------------------------
// Context + shared small types
// ---------------------------------------------------------------------------

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
  /** User-tunable, clamp-on-read thresholds resolved once per run (#4964 Phase 3 WP1). */
  thresholds: ResolvedMeshIssueThresholds;
}

export interface RuleSkip {
  rule: string;
  reason: string;
}

/** A connected component of `CLUSTER_ROLES` nodes over the RF graph. Shared
 *  by B1 (fires on it) and B6 (checks adjacency to it) — see spec §2.6. */
export interface RouterCluster {
  /** Sorted, deduped. Size >= ROUTER_CLUSTER_WARNING_SIZE. */
  members: number[];
  /** True when the component only stays connected via inferred
   *  (co-reception) edges — direct-only recomputation splits it (D2). */
  inferredOnly: boolean;
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function roleName(role: number | null): string {
  if (role == null) return 'Unknown';
  return ROLE_NAMES[role] ?? `Role ${role}`;
}

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function sortNumbers(values: Iterable<number>): number[] {
  return Array.from(values).sort((a, b) => a - b);
}

/** `name`, falling back to the hex node id (`!xxxxxxxx`) — the same fallback
 *  the frontend uses for a nameless member, but baked into recommendation
 *  TEXT here since that string is displayed verbatim (only structured
 *  evidence fields go through the frontend's per-field renderer). Takes a
 *  bare `(name, nodeNum)` pair rather than `PooledNode` so it also works for
 *  B7's `RouterRangeInfo`, which isn't a full PooledNode. */
function displayName(name: string | null, nodeNum: number): string {
  return name ?? `!${(nodeNum >>> 0).toString(16).padStart(8, '0')}`;
}

/** Caps an evidence list at EVIDENCE_MEMBER_LIST_CAP, returning a sibling
 *  truncated flag per spec §2.6 ("every member/edge list ... capped ... with
 *  a sibling `<field>Truncated: boolean`"), plus the pre-cap `total` length
 *  (Phase 3 WP3 §4.2 — the "+N more" backlog item; each call site also emits
 *  a sibling `<field>Total: n`). */
function capList<T>(items: T[]): { items: T[]; truncated: boolean; total: number } {
  const total = items.length;
  if (total <= EVIDENCE_MEMBER_LIST_CAP) return { items, truncated: false, total };
  return { items: items.slice(0, EVIDENCE_MEMBER_LIST_CAP), truncated: true, total };
}

/** "Where edge/graph evidence yields nothing, fall back to the union of the
 *  subject nodes' PooledNode.sourceIds" (spec §2.6) — every finding's
 *  `sourceIds` must be non-empty. */
function sourceIdsWithFallback(primary: Iterable<string>, fallbackNodes: Array<PooledNode | null | undefined>): string[] {
  const primaryList = sortedUnique(Array.from(primary));
  if (primaryList.length > 0) return primaryList;
  return sortedUnique(fallbackNodes.flatMap((n) => n?.sourceIds ?? []));
}

function countPositionedDirectNeighbors(ctx: TierBRuleContext, nodeNum: number): number {
  const neighbors = ctx.graph.directAdjacency.get(nodeNum);
  if (!neighbors) return 0;
  let count = 0;
  for (const nb of neighbors) {
    const n = ctx.nodes.get(nb);
    if (n && n.latitude != null && n.longitude != null && !isBogusPosition(n.latitude, n.longitude, n.positionPrecisionBits)) {
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Router-cluster components (shared by B1 and B6)
// ---------------------------------------------------------------------------

/** BFS connected components of `nodeSet`, following only edges in
 *  `adjacency` whose OTHER endpoint is also in `nodeSet`. Deterministic:
 *  both the start-node order and each node's neighbour order are irrelevant
 *  to the final (sorted) membership of each component. */
function computeComponents(nodeSet: ReadonlySet<number>, adjacency: Map<number, Set<number>>): number[][] {
  const visited = new Set<number>();
  const components: number[][] = [];
  const startNodes = sortNumbers(nodeSet);

  for (const start of startNodes) {
    if (visited.has(start)) continue;
    const comp: number[] = [];
    const queue: number[] = [start];
    visited.add(start);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      comp.push(cur);
      const neighbors = adjacency.get(cur);
      if (!neighbors) continue;
      for (const nb of neighbors) {
        if (nodeSet.has(nb) && !visited.has(nb)) {
          visited.add(nb);
          queue.push(nb);
        }
      }
    }
    components.push(comp);
  }
  return components;
}

function findRouterClustersCore(ctx: TierBRuleContext): RouterCluster[] {
  const clusterNodeNums = new Set<number>();
  for (const node of ctx.nodes.values()) {
    if (node.role != null && CLUSTER_ROLES.has(node.role)) clusterNodeNums.add(node.nodeNum);
  }
  if (clusterNodeNums.size === 0) return [];

  const allComponents = computeComponents(clusterNodeNums, ctx.graph.adjacency);
  const clusters: RouterCluster[] = [];

  for (const comp of allComponents) {
    if (comp.length < ROUTER_CLUSTER_WARNING_SIZE) continue;
    const memberSet = new Set(comp);
    // Recompute over DIRECT-only edges (D2): if this same member set no
    // longer forms a single connected component, it was glued together by
    // inferred (co-reception) evidence alone.
    const directComponents = computeComponents(memberSet, ctx.graph.directAdjacency);
    const inferredOnly = !(directComponents.length === 1 && directComponents[0].length === memberSet.size);
    clusters.push({ members: sortNumbers(memberSet), inferredOnly });
  }

  clusters.sort((a, b) => a.members[0] - b.members[0]);
  return clusters;
}

/** Shared by B1 and B6 so neither depends on the other's execution order. */
export function findRouterClusters(ctx: TierBRuleContext): RouterCluster[] {
  return findRouterClustersCore(ctx);
}

// ---------------------------------------------------------------------------
// Participation index (shared by B4 and B5)
// ---------------------------------------------------------------------------

interface ParticipationEntry {
  hopSamples: Set<number>;
  endpointSamples: Set<number>;
}

interface AreaBinInfo {
  key: string;
  latBin: number;
  lonBin: number;
}

interface ParticipationIndex {
  participation: Map<number, ParticipationEntry>;
  areaBin: Map<number, AreaBinInfo>;
  /** Aligned by index with `ctx.samples`. */
  sampleBins: Array<Set<string>>;
  /** bin key -> sample indices touching that bin. Derived from `sampleBins`
   *  in the same single pass so B4/B5 never rescan every sample per
   *  candidate node (that pass would be O(nodes * samples)). */
  areaPathsByBin: Map<string, number[]>;
}

function getParticipationEntry(map: Map<number, ParticipationEntry>, nodeNum: number): ParticipationEntry {
  let entry = map.get(nodeNum);
  if (!entry) {
    entry = { hopSamples: new Set(), endpointSamples: new Set() };
    map.set(nodeNum, entry);
  }
  return entry;
}

/**
 * Built ONCE per `evaluateAllTierB` call (never per node): a single pass
 * over `samples × path length` computes, per node, which samples it
 * participated in as an intermediate hop vs. as an endpoint, each positioned
 * node's geographic bin (skipping nodes with no position or
 * `isBogusPosition`, same guard A2b uses), and the reverse bin -> sample
 * index B4/B5 need for their "area paths" computation.
 *
 * `tracerouteParticipationKind` (`tracerouteSegments.ts`) is the semantic
 * reference for hop vs. endpoint classification and is used by the test
 * suite to cross-check this index — it is deliberately NOT called here,
 * since calling it per (node, sample) would re-derive membership in a loop
 * this function already computes in one pass.
 */
function buildParticipationIndex(ctx: TierBRuleContext): ParticipationIndex {
  const participation = new Map<number, ParticipationEntry>();
  const areaBin = new Map<number, AreaBinInfo>();

  for (const node of ctx.nodes.values()) {
    if (node.latitude == null || node.longitude == null) continue;
    if (isBogusPosition(node.latitude, node.longitude, node.positionPrecisionBits)) continue;
    const latBin = Math.floor(node.latitude / AREA_GRID_BIN_DEG);
    const lonBin = Math.floor(node.longitude / AREA_GRID_BIN_DEG);
    areaBin.set(node.nodeNum, { key: `${latBin}:${lonBin}`, latBin, lonBin });
  }

  const sampleBins: Array<Set<string>> = new Array(ctx.samples.length);

  ctx.samples.forEach((sample, idx) => {
    const bins = new Set<string>();
    const touch = (nodeNum: number, kind: 'hop' | 'endpoint') => {
      const entry = getParticipationEntry(participation, nodeNum);
      if (kind === 'hop') entry.hopSamples.add(idx);
      else entry.endpointSamples.add(idx);
      const bin = areaBin.get(nodeNum);
      if (bin) bins.add(bin.key);
    };
    touch(sample.fromNodeNum, 'endpoint');
    touch(sample.toNodeNum, 'endpoint');
    for (const hop of sample.routeHops) touch(hop, 'hop');
    for (const hop of sample.routeBackHops) touch(hop, 'hop');
    sampleBins[idx] = bins;
  });

  const areaPathsByBin = new Map<string, number[]>();
  sampleBins.forEach((bins, idx) => {
    for (const key of bins) {
      let list = areaPathsByBin.get(key);
      if (!list) {
        list = [];
        areaPathsByBin.set(key, list);
      }
      list.push(idx);
    }
  });

  return { participation, areaBin, sampleBins, areaPathsByBin };
}

// ---------------------------------------------------------------------------
// B1 — Router cluster
// ---------------------------------------------------------------------------

function evaluateB1Impl(ctx: TierBRuleContext, clusters: RouterCluster[]): MeshIssueFinding[] {
  const findings: MeshIssueFinding[] = [];

  for (const cluster of clusters) {
    const { members, inferredOnly } = cluster;
    const memberSet = new Set(members);
    const memberNodes = members
      .map((n) => ctx.nodes.get(n))
      .filter((n): n is PooledNode => n != null);

    const internalEdges = Array.from(ctx.graph.edges.values()).filter(
      (e) => memberSet.has(e.a) && memberSet.has(e.b),
    );

    let confidence: MeshIssueConfidence;
    if (inferredOnly) {
      confidence = 'low';
    } else {
      const allHighQuality =
        internalEdges.length > 0 &&
        internalEdges.every((e) => e.evidenceClasses.includes('neighborInfo') || e.evidenceClasses.includes('traceroute'));
      confidence = allHighQuality ? 'high' : 'medium';
    }

    const severity: MeshIssueSeverity = inferredOnly
      ? 'info'
      : members.length >= ROUTER_CLUSTER_CRITICAL_SIZE
        ? 'critical'
        : 'warning';

    // Best-sited member: highest direct-adjacency degree; ties -> most
    // positioned direct edges; ties -> lowest nodeNum.
    let best: PooledNode | null = null;
    let bestDegree = -1;
    let bestPositionedDegree = -1;
    for (const node of memberNodes) {
      const degree = ctx.graph.directAdjacency.get(node.nodeNum)?.size ?? 0;
      const positionedDegree = countPositionedDirectNeighbors(ctx, node.nodeNum);
      const better =
        degree > bestDegree ||
        (degree === bestDegree && positionedDegree > bestPositionedDegree) ||
        (degree === bestDegree && positionedDegree === bestPositionedDegree && (best === null || node.nodeNum < best.nodeNum));
      if (better) {
        best = node;
        bestDegree = degree;
        bestPositionedDegree = positionedDegree;
      }
    }
    // Every cluster member is, by construction, a node in ctx.nodes (cluster
    // membership is seeded from ctx.nodes.values()), so `best` is never null
    // for a non-empty member list.
    const bestSited = best!;

    const membersCapped = capList(
      members.map((n) => {
        const node = ctx.nodes.get(n)!;
        return {
          nodeNum: n,
          name: node.longName,
          role: node.role,
          roleName: roleName(node.role),
          directDegree: ctx.graph.directAdjacency.get(n)?.size ?? 0,
          // Effective position from the pooled snapshot so the report can
          // draw the cluster on a map (#4974). Null when unpositioned.
          latitude: node.latitude,
          longitude: node.longitude,
        };
      }),
    );
    const edgesCapped = capList(
      internalEdges.map((e) => ({
        a: e.a,
        b: e.b,
        evidenceClasses: e.evidenceClasses,
        observationCount: e.observationCount,
      })),
    );

    const sourceIds = sourceIdsWithFallback(
      internalEdges.flatMap((e) => e.sourceIds),
      memberNodes,
    );

    findings.push({
      issueType: MESH_ISSUE_TYPES.B1_ROUTER_CLUSTER,
      subjectKey: clusterSubjectKey(members),
      nodeNum: null,
      severity,
      confidence,
      evidence: {
        size: members.length,
        members: membersCapped.items,
        membersTruncated: membersCapped.truncated,
        membersTotal: membersCapped.total,
        edges: edgesCapped.items,
        edgesTruncated: edgesCapped.truncated,
        edgesTotal: edgesCapped.total,
        inferredOnly,
        bestSitedNodeNum: bestSited.nodeNum,
        bestSitedName: bestSited.longName,
        sources: sourceIds,
      },
      sourceIds,
      recommendation: `${members.length} routers here hear each other, so each re-floods the same packets. Keep ${displayName(bestSited.longName, bestSited.nodeNum)} as the router and move the others to ROUTER_LATE — or CLIENT_BASE if they are fixed and powered.`,
    });
  }

  return findings;
}

export function evaluateB1(ctx: TierBRuleContext): MeshIssueFinding[] {
  return evaluateB1Impl(ctx, findRouterClustersCore(ctx));
}

// ---------------------------------------------------------------------------
// B2 — Redundant router
// ---------------------------------------------------------------------------

export function evaluateB2(ctx: TierBRuleContext): MeshIssueFinding[] {
  // "Skip on sparse adjacency data" (epic) — no direct RF evidence at all.
  if (ctx.graph.stats.directEdgeCount === 0) return [];

  const findings: MeshIssueFinding[] = [];
  const infraNodes = Array.from(ctx.nodes.values())
    .filter((n) => n.role != null && INFRA_ROLES.has(n.role))
    .sort((a, b) => a.nodeNum - b.nodeNum);

  interface Candidate {
    nodeB: PooledNode;
    nA: Set<number>;
    nB: Set<number>;
    overlap: number[];
    ratio: number;
  }

  for (const nodeA of infraNodes) {
    const rawA = ctx.graph.directAdjacency.get(nodeA.nodeNum);
    if (!rawA || rawA.size === 0) continue;

    const candidates: Candidate[] = [];
    for (const nodeB of infraNodes) {
      if (nodeB.nodeNum === nodeA.nodeNum) continue;
      const rawB = ctx.graph.directAdjacency.get(nodeB.nodeNum);
      if (!rawB) continue;

      const nA = new Set(rawA);
      nA.delete(nodeB.nodeNum);
      const nB = new Set(rawB);
      nB.delete(nodeA.nodeNum);

      if (nA.size < REDUNDANT_MIN_NEIGHBORS) continue;
      if (nB.size < REDUNDANT_MIN_NEIGHBORS) continue;
      if (!(nA.size <= nB.size)) continue;

      const overlap: number[] = [];
      for (const x of nA) if (nB.has(x)) overlap.push(x);
      const ratio = overlap.length / nA.size;
      if (!(ratio >= REDUNDANT_OVERLAP_RATIO)) continue;

      candidates.push({ nodeB, nA, nB, overlap: sortNumbers(overlap), ratio });
    }

    if (candidates.length === 0) continue;
    candidates.sort((x, y) => y.nB.size - x.nB.size || x.nodeB.nodeNum - y.nodeB.nodeNum);
    const [best, ...rest] = candidates;

    const sharedCapped = capList(best.overlap);
    const othersCapped = capList(
      rest.map((c) => ({ nodeNum: c.nodeB.nodeNum, name: c.nodeB.longName, neighborCount: c.nB.size })),
    );
    const sourceIds = sourceIdsWithFallback([], [nodeA, best.nodeB]);

    findings.push({
      issueType: MESH_ISSUE_TYPES.B2_REDUNDANT_ROUTER,
      subjectKey: nodeSubjectKey(nodeA.nodeNum),
      nodeNum: nodeA.nodeNum,
      severity: 'warning',
      confidence: best.nA.size === REDUNDANT_MIN_NEIGHBORS ? 'low' : 'medium',
      evidence: {
        role: nodeA.role,
        roleName: roleName(nodeA.role),
        neighborCount: best.nA.size,
        coveredByNodeNum: best.nodeB.nodeNum,
        coveredByName: best.nodeB.longName,
        coveredByNeighborCount: best.nB.size,
        overlapRatio: best.ratio,
        sharedNeighbors: sharedCapped.items,
        sharedNeighborsTruncated: sharedCapped.truncated,
        sharedNeighborsTotal: sharedCapped.total,
        otherCoveringRouters: othersCapped.items,
        otherCoveringRoutersTruncated: othersCapped.truncated,
        otherCoveringRoutersTotal: othersCapped.total,
        sources: sourceIds,
      },
      sourceIds,
      recommendation: `This router's coverage is already carried by ${displayName(best.nodeB.longName, best.nodeB.nodeNum)}. Two routers covering the same neighbours double every re-flood. Consider ROUTER_LATE, or CLIENT_BASE if it is fixed and powered.`,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// B3 — Asymmetric link
// ---------------------------------------------------------------------------

export function evaluateB3(ctx: TierBRuleContext): MeshIssueFinding[] {
  const findings: MeshIssueFinding[] = [];

  for (const edge of ctx.graph.edges.values()) {
    if (edge.snrToA.count < ASYMMETRY_MIN_SAMPLES_PER_DIRECTION) continue;
    if (edge.snrToB.count < ASYMMETRY_MIN_SAMPLES_PER_DIRECTION) continue;
    if (edge.snrToA.meanDb == null || edge.snrToB.meanDb == null) continue;

    const deltaDb = edge.snrToA.meanDb - edge.snrToB.meanDb;
    if (!(Math.abs(deltaDb) > ctx.thresholds.snrAsymmetryDb)) continue;

    const nodeA = ctx.nodes.get(edge.a) ?? null;
    const nodeB = ctx.nodes.get(edge.b) ?? null;
    const roleA = nodeA?.role ?? null;
    const roleB = nodeB?.role ?? null;
    const infraA = roleA != null && INFRA_ROLES.has(roleA);
    const infraB = roleB != null && INFRA_ROLES.has(roleB);
    // Attach to the infra endpoint only when EXACTLY one end is infra (D6);
    // two infra ends is ambiguous, so nodeNum stays null.
    const nodeNum = infraA !== infraB ? (infraA ? edge.a : edge.b) : null;

    const weakerDirection: 'a->b' | 'b->a' = edge.snrToB.meanDb < edge.snrToA.meanDb ? 'a->b' : 'b->a';
    const sourceIds = sourceIdsWithFallback(edge.sourceIds, [nodeA, nodeB]);

    findings.push({
      issueType: MESH_ISSUE_TYPES.B3_ASYMMETRIC_LINK,
      subjectKey: edgeSubjectKey(edge.a, edge.b),
      nodeNum,
      severity: infraA || infraB ? 'warning' : 'info',
      confidence: 'medium',
      evidence: {
        nodeA: { nodeNum: edge.a, name: nodeA?.longName ?? null, role: roleA, roleName: roleName(roleA) },
        nodeB: { nodeNum: edge.b, name: nodeB?.longName ?? null, role: roleB, roleName: roleName(roleB) },
        snrToA: edge.snrToA,
        snrToB: edge.snrToB,
        deltaDb,
        weakerDirection,
        evidenceClasses: edge.evidenceClasses,
        observationCount: edge.observationCount,
        thresholdUsed: ctx.thresholds.snrAsymmetryDb,
        sources: sourceIds,
      },
      sourceIds,
      recommendation:
        'One end of this link hears the other much better than the reverse. That usually means an antenna, feedline or siting difference at the weaker end, not a role problem.',
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// B4 — Idle router
// ---------------------------------------------------------------------------

function evaluateB4Impl(ctx: TierBRuleContext, index: ParticipationIndex): MeshIssueFinding[] {
  const findings: MeshIssueFinding[] = [];

  const hopShareOf = (nodeNum: number, areaPaths: number[]): number => {
    const entry = index.participation.get(nodeNum);
    if (!entry || areaPaths.length === 0) return 0;
    let count = 0;
    for (const idx of areaPaths) if (entry.hopSamples.has(idx)) count++;
    return count / areaPaths.length;
  };

  for (const node of ctx.nodes.values()) {
    if (node.role == null || !INFRA_ROLES.has(node.role)) continue;
    const bin = index.areaBin.get(node.nodeNum);
    if (!bin) continue; // no usable position

    const directDegree = ctx.graph.directAdjacency.get(node.nodeNum)?.size ?? 0;
    if (directDegree < 1) continue; // "heard direct"

    const areaPaths = index.areaPathsByBin.get(bin.key) ?? [];
    if (areaPaths.length < IDLE_ROUTER_MIN_AREA_PATHS) continue;

    const hopShare = hopShareOf(node.nodeNum, areaPaths);

    let peerBestShare = 0;
    let peerBestNodeNum: number | null = null;
    let peerBestName: string | null = null;
    for (const peer of ctx.nodes.values()) {
      if (peer.nodeNum === node.nodeNum) continue;
      if (peer.role == null || !INFRA_ROLES.has(peer.role)) continue;
      const peerBin = index.areaBin.get(peer.nodeNum);
      if (!peerBin || peerBin.key !== bin.key) continue;
      const peerDegree = ctx.graph.directAdjacency.get(peer.nodeNum)?.size ?? 0;
      if (peerDegree < 1) continue;
      const share = hopShareOf(peer.nodeNum, areaPaths);
      if (share > peerBestShare) {
        peerBestShare = share;
        peerBestNodeNum = peer.nodeNum;
        peerBestName = peer.longName;
      }
    }

    if (!(hopShare < IDLE_ROUTER_MAX_HOP_SHARE)) continue;
    if (!(peerBestShare > IDLE_ROUTER_PEER_MIN_HOP_SHARE)) continue;

    findings.push({
      issueType: MESH_ISSUE_TYPES.B4_IDLE_ROUTER,
      subjectKey: nodeSubjectKey(node.nodeNum),
      nodeNum: node.nodeNum,
      // Hard-coded — D11: B4 is info in every case, never a default a future
      // edit could accidentally raise. See rulesTierB.test.ts's assertion.
      severity: 'info',
      confidence: 'low',
      evidence: {
        role: node.role,
        roleName: roleName(node.role),
        hopShare,
        areaPathCount: areaPaths.length,
        peerBestShare,
        peerBestNodeNum,
        peerBestName,
        directDegree,
        latBin: bin.latBin,
        lonBin: bin.lonBin,
        sources: node.sourceIds,
      },
      sourceIds: node.sourceIds,
      recommendation:
        'This router carries almost none of the traffic in its area while a neighbour carries most of it. Check siting and antenna before adding more infrastructure; ROUTER_LATE or CLIENT_BASE may fit it better.',
    });
  }

  return findings;
}

export function evaluateB4(ctx: TierBRuleContext): MeshIssueFinding[] {
  return evaluateB4Impl(ctx, buildParticipationIndex(ctx));
}

// ---------------------------------------------------------------------------
// B5 — Load-bearing CLIENT
// ---------------------------------------------------------------------------

function evaluateB5Impl(ctx: TierBRuleContext, index: ParticipationIndex): MeshIssueFinding[] {
  const findings: MeshIssueFinding[] = [];

  for (const node of ctx.nodes.values()) {
    if (node.role == null) continue;
    if (INFRA_ROLES.has(node.role)) continue;
    const bin = index.areaBin.get(node.nodeNum);
    if (!bin) continue;

    const entry = index.participation.get(node.nodeNum);
    const hopCount = entry ? entry.hopSamples.size : 0;
    if (hopCount < LOAD_BEARING_MIN_TRACEROUTES) continue;

    const areaPaths = index.areaPathsByBin.get(bin.key) ?? [];
    if (areaPaths.length < LOAD_BEARING_MIN_TRACEROUTES) continue;

    let areaHopCount = 0;
    if (entry) {
      for (const idx of areaPaths) if (entry.hopSamples.has(idx)) areaHopCount++;
    }
    const areaShare = areaHopCount / areaPaths.length;
    if (!(areaShare >= LOAD_BEARING_MIN_AREA_SHARE)) continue;

    const fixedAndPowered = isPowered(node.batteryLevel) && !node.mobile;
    // D10 — severity conditional on power; a load-bearing battery/mobile
    // node is a real fragility (warning), an already-fixed-and-powered one
    // is informational only.
    const severity: MeshIssueSeverity = fixedAndPowered ? 'info' : 'warning';

    // D10 — never recommend CLIENT_BASE to a node that already has it.
    const recommendation =
      fixedAndPowered && node.role !== DeviceRole.CLIENT_BASE
        ? 'This client is carrying a quarter of the paths in its area. If it is permanently sited and powered, CLIENT_BASE fits it better than CLIENT.'
        : 'This client is carrying a quarter of the paths in its area and is not a fixed, powered node. Deploying another CLIENT nearby is the right fix — do not give this one a routing role.';

    findings.push({
      issueType: MESH_ISSUE_TYPES.B5_LOAD_BEARING_CLIENT,
      subjectKey: nodeSubjectKey(node.nodeNum),
      nodeNum: node.nodeNum,
      severity,
      confidence: 'medium',
      evidence: {
        role: node.role,
        roleName: roleName(node.role),
        hopCount,
        areaPathCount: areaPaths.length,
        areaShare,
        fixedAndPowered,
        batteryLevel: node.batteryLevel,
        mobile: node.mobile,
        sources: node.sourceIds,
      },
      sourceIds: node.sourceIds,
      recommendation,
    });
  }

  return findings;
}

export function evaluateB5(ctx: TierBRuleContext): MeshIssueFinding[] {
  return evaluateB5Impl(ctx, buildParticipationIndex(ctx));
}

// ---------------------------------------------------------------------------
// B6 — Hop horizon
// ---------------------------------------------------------------------------

function evaluateB6Impl(ctx: TierBRuleContext, clusters: RouterCluster[]): MeshIssueFinding[] {
  if (ctx.hopHorizon.size === 0) return [];

  const findings: MeshIssueFinding[] = [];

  for (const [nodeNum, stats] of ctx.hopHorizon.entries()) {
    if (stats.totalPackets < HOP_HORIZON_MIN_PACKETS) continue;
    const exhaustedRatio = stats.exhaustedPackets / stats.totalPackets;
    if (!(exhaustedRatio > HOP_HORIZON_EXHAUSTED_RATIO)) continue;

    const neighbors = ctx.graph.adjacency.get(nodeNum);
    let behindRouterCluster = false;
    const clusterMembersHit = new Set<number>();
    if (neighbors) {
      for (const cluster of clusters) {
        for (const m of cluster.members) {
          if (neighbors.has(m)) {
            behindRouterCluster = true;
            clusterMembersHit.add(m);
          }
        }
      }
    }
    const clusterMembersCapped = capList(sortNumbers(clusterMembersHit));

    const sourceIds = sourceIdsWithFallback(stats.sourceIds, [ctx.nodes.get(nodeNum)]);

    let recommendation = 'Traffic from this node reaches us with no hops left, so anything further away cannot hear it.';
    if (behindRouterCluster) {
      recommendation +=
        ' A router cluster between us and this node is consuming the hop budget; thinning that cluster will help more than raising hop limits.';
    }

    findings.push({
      issueType: MESH_ISSUE_TYPES.B6_HOP_HORIZON,
      subjectKey: nodeSubjectKey(nodeNum),
      nodeNum,
      severity: 'info',
      confidence: 'medium',
      evidence: {
        totalPackets: stats.totalPackets,
        exhaustedPackets: stats.exhaustedPackets,
        exhaustedRatio,
        behindRouterCluster,
        clusterMembers: clusterMembersCapped.items,
        clusterMembersTruncated: clusterMembersCapped.truncated,
        clusterMembersTotal: clusterMembersCapped.total,
        // 2.7+ zero-cost favourite-router hops skip the decrement, so
        // hopStart - hopLimit under-counts real hop consumption (D9/§7.3).
        hopDeltaIsLowerBound: true,
        sources: sourceIds,
      },
      sourceIds,
      recommendation,
    });
  }

  return findings;
}

export function evaluateB6(ctx: TierBRuleContext): MeshIssueFinding[] {
  return evaluateB6Impl(ctx, findRouterClustersCore(ctx));
}

// ---------------------------------------------------------------------------
// B7 — Coverage shadow
// ---------------------------------------------------------------------------

interface RouterRangeInfo {
  nodeNum: number;
  name: string | null;
  lat: number;
  lon: number;
  observedRangeM: number;
  sampleCount: number;
  cappedAtCeiling: boolean;
}

function hasUsablePrecisePosition(node: PooledNode): boolean {
  if (node.latitude == null || node.longitude == null) return false;
  if (isBogusPosition(node.latitude, node.longitude, node.positionPrecisionBits)) return false;
  // Skip precision-truncated positions (epic guard) — a truncated fix could
  // fabricate range/shadow geometry. Unknown precision (null) passes, same
  // convention A4/B1 use elsewhere in this tier.
  if (node.positionPrecisionBits != null && node.positionPrecisionBits < MOBILE_MIN_PRECISION_BITS) return false;
  return true;
}

function buildRouterRanges(ctx: TierBRuleContext): RouterRangeInfo[] {
  const routers: RouterRangeInfo[] = [];

  for (const router of ctx.nodes.values()) {
    if (router.role == null || !INFRA_ROLES.has(router.role)) continue;
    if (!hasUsablePrecisePosition(router)) continue;
    // Non-null by hasUsablePrecisePosition's own check.
    const lat = router.latitude!;
    const lon = router.longitude!;

    const neighbors = ctx.graph.directAdjacency.get(router.nodeNum);
    if (!neighbors) continue;

    let maxDistKm = 0;
    let sampleCount = 0;
    for (const neighborNum of neighbors) {
      const neighbor = ctx.nodes.get(neighborNum);
      if (!neighbor || neighbor.latitude == null || neighbor.longitude == null) continue;
      if (isBogusPosition(neighbor.latitude, neighbor.longitude, neighbor.positionPrecisionBits)) continue;
      const distKm = calculateDistance(lat, lon, neighbor.latitude, neighbor.longitude);
      sampleCount++;
      if (distKm > maxDistKm) maxDistKm = distKm;
    }

    if (sampleCount < COVERAGE_SHADOW_MIN_RANGE_SAMPLES) continue;

    const rawRangeM = maxDistKm * 1000;
    const cappedAtCeiling = rawRangeM > COVERAGE_SHADOW_MAX_RANGE_M;
    const observedRangeM = Math.min(rawRangeM, COVERAGE_SHADOW_MAX_RANGE_M);

    routers.push({ nodeNum: router.nodeNum, name: router.longName, lat, lon, observedRangeM, sampleCount, cappedAtCeiling });
  }

  return routers;
}

export function evaluateB7(ctx: TierBRuleContext): MeshIssueFinding[] {
  const routers = buildRouterRanges(ctx);
  if (routers.length === 0) return [];

  const findings: MeshIssueFinding[] = [];

  for (const candidate of ctx.nodes.values()) {
    if (!hasUsablePrecisePosition(candidate)) continue;

    // "Never RF-heard" — no direct-evidence edge at all.
    const directNeighbors = ctx.graph.directAdjacency.get(candidate.nodeNum);
    if (directNeighbors && directNeighbors.size > 0) continue;

    if (candidate.sourceIds.length === 0) continue;
    if (!candidate.sourceIds.every((sid) => ctx.mqttSourceIds.has(sid))) continue;

    let nearest: { router: RouterRangeInfo; distanceM: number } | null = null;
    for (const router of routers) {
      if (router.nodeNum === candidate.nodeNum) continue;
      const distM = calculateDistance(candidate.latitude!, candidate.longitude!, router.lat, router.lon) * 1000;
      if (distM <= router.observedRangeM && (!nearest || distM < nearest.distanceM)) {
        nearest = { router, distanceM: distM };
      }
    }
    if (!nearest) continue;

    findings.push({
      issueType: MESH_ISSUE_TYPES.B7_COVERAGE_SHADOW,
      subjectKey: nodeSubjectKey(candidate.nodeNum),
      nodeNum: candidate.nodeNum,
      severity: 'info',
      confidence: 'low',
      evidence: {
        nearestRouterNodeNum: nearest.router.nodeNum,
        nearestRouterName: nearest.router.name,
        distanceM: nearest.distanceM,
        routerObservedRangeM: nearest.router.observedRangeM,
        routerRangeSampleCount: nearest.router.sampleCount,
        rangeCappedAtCeiling: nearest.router.cappedAtCeiling,
        sources: candidate.sourceIds,
      },
      sourceIds: candidate.sourceIds,
      recommendation: `This node only reaches us through MQTT even though it sits inside ${displayName(nearest.router.name, nearest.router.nodeNum)}'s demonstrated RF range. Check antenna and siting at one end or the other — no role change is implied.`,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Combined evaluation
// ---------------------------------------------------------------------------

interface TierBRunState {
  ctx: TierBRuleContext;
  clusters: RouterCluster[];
  index: ParticipationIndex;
}

const ALL_RULES_WITH_B7: Array<[string, (state: TierBRunState) => MeshIssueFinding[]]> = [
  ['B1', (s) => evaluateB1Impl(s.ctx, s.clusters)],
  ['B2', (s) => evaluateB2(s.ctx)],
  ['B3', (s) => evaluateB3(s.ctx)],
  ['B4', (s) => evaluateB4Impl(s.ctx, s.index)],
  ['B5', (s) => evaluateB5Impl(s.ctx, s.index)],
  ['B6', (s) => evaluateB6Impl(s.ctx, s.clusters)],
  ['B7', (s) => evaluateB7(s.ctx)],
];

/** Same as {@link ALL_RULES_WITH_B7} minus B7 — used when
 *  `ctx.thresholds.b7Enabled` is false (#4964 Phase 3 WP1, spec §2.1: B7 is
 *  the one rule observed firing at pathological volume on a real mesh). A
 *  disabled B7 contributes no findings this run; its existing open findings
 *  auto-close naturally after AUTO_CLOSE_CLEAN_RUNS clean runs — the service
 *  must not delete rows to honour this toggle. */
const ALL_RULES_WITHOUT_B7: Array<[string, (state: TierBRunState) => MeshIssueFinding[]]> = [
  ['B1', (s) => evaluateB1Impl(s.ctx, s.clusters)],
  ['B2', (s) => evaluateB2(s.ctx)],
  ['B3', (s) => evaluateB3(s.ctx)],
  ['B4', (s) => evaluateB4Impl(s.ctx, s.index)],
  ['B5', (s) => evaluateB5Impl(s.ctx, s.index)],
  ['B6', (s) => evaluateB6Impl(s.ctx, s.clusters)],
];

/** B1..B7 in order (B7 governed by `ctx.thresholds.b7Enabled`). Never throws —
 *  a rule that cannot evaluate returns []. Builds the shared
 *  cluster/participation indices exactly once (see the module header) and
 *  threads them into the rules that need them. */
export function evaluateAllTierB(ctx: TierBRuleContext): MeshIssueFinding[] {
  const state: TierBRunState = {
    ctx,
    clusters: findRouterClustersCore(ctx),
    index: buildParticipationIndex(ctx),
  };
  const rules = ctx.thresholds.b7Enabled ? ALL_RULES_WITH_B7 : ALL_RULES_WITHOUT_B7;
  return runRulesIsolated('Tier B', rules, state);
}

/**
 * Coarse availability gates only (D13) — which rules could not run AT ALL
 * for lack of an evidence class, not per-node degradation. The Phase 3
 * coverage preface is the consumer.
 */
export function tierBSkips(ctx: TierBRuleContext): RuleSkip[] {
  const skips: RuleSkip[] = [];
  if (ctx.graph.stats.directEdgeCount === 0) {
    skips.push({ rule: 'B2', reason: 'no direct RF adjacency data' });
  }
  if (ctx.hopHorizon.size === 0) {
    skips.push({ rule: 'B6', reason: 'no packet log enabled' });
  }
  return skips;
}
