/**
 * Mesh Issues Analysis Service (global, batch, passive — #4964, Phase 1 WP3)
 *
 * Reads only rows already on disk (nodes, telemetry, traceroutes) and writes
 * only to the GLOBAL `mesh_issues` table (WP1). Sends ZERO packets and emits
 * ZERO `dataEventEmitter` events — the mesh-impact checklist §1/§2 are
 * satisfied by construction (see MESH_ISSUES_P1_SPEC.md header comment).
 * Whether findings should notify at all is a Phase 3 user decision (spec
 * §5.11) — do not add an event emission here without that decision.
 *
 * Runs as a scheduled batch job (meshIssuesScheduler.ts), not in realtime, so
 * the whole Tier A rule set is evaluated against one consistent snapshot.
 */
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { ALL_SOURCES } from '../../db/repositories/base.js';
import { isMqttSourceType } from '../../db/repositories/sources.js';
import type { DbNode, DbTelemetry } from '../../db/types.js';
import type { TracerouteRow, NeighborRow } from '../../db/repositories/analysis.js';
import packetLogService from './packetLogService.js';
import mqttPacketLogService from './mqttPacketLogService.js';
import {
  buildPooledNodeSnapshot,
  buildTelemetrySeries,
  MESH_ISSUE_TELEMETRY_TYPES,
  type PooledNode,
  type PooledNodeInput,
  type TelemetryRowInput,
} from './meshIssues/nodeSnapshot.js';
import { evaluateAllTierA, type RuleContext } from './meshIssues/rules.js';
import {
  evaluateAllTierB,
  tierBSkips,
  type TierBRuleContext,
  type HopHorizonStats,
  type RuleSkip,
} from './meshIssues/rulesTierB.js';
import {
  buildRfGraph,
  type RfEvidenceAvailability,
  type NeighborEdgeInput,
  type GatewayDirectReceptionInput,
} from './meshIssues/rfGraph.js';
import { buildTracerouteCorpus, type TracerouteCorpusStats } from './meshIssues/tracerouteCorpus.js';
import { INFRA_ROLES, AUTO_CLOSE_CLEAN_RUNS } from './meshIssues/thresholds.js';
import { positionSpanKm } from './nodeMobilityService.js';
import type { MeshIssueFinding } from './meshIssues/types.js';

/**
 * `getAllNodes(ALL_SOURCES)` rows carry a real `sourceId` column at runtime,
 * but it is deliberately absent from the narrower `DbNode` interface — same
 * precedent as `nodeInfoEnrichmentService.ts`'s local `NodeRow` type.
 */
type NodeRow = DbNode & { sourceId: string };

/** Telemetry rows likewise carry `sourceId` at runtime though `DbTelemetry` omits it (nullable column). */
type TelemetryRow = DbTelemetry & { sourceId: string | null };

/**
 * Cap on traceroute pages pulled into the corpus sampler per run (50,000
 * rows at `TRACEROUTE_PAGE_SIZE`) — bounds memory on a large mesh. Exported
 * so `meshIssuesAnalysisService.test.ts` can assert the cap directly (spec
 * §5.15).
 */
export const MAX_CORPUS_PAGES = 25;
const TRACEROUTE_PAGE_SIZE = 2000;

/** Position-span lookups (A4 input) run in bounded chunks, not one giant Promise.all. */
const POSITION_SPAN_CHUNK_SIZE = 25;
/** Same sample cap `nodeMobilityService` uses, so the two classifications can never disagree about the underlying data. */
const POSITION_SPAN_SAMPLE_LIMIT = 500;

export interface MeshIssuesRunOptions {
  /** Hours of history to pull for telemetry + traceroutes. Clamped by the scheduler. */
  lookbackHours: number;
  /** Traceroute stratification bucket width, hours. Clamped by the scheduler. */
  pairBucketHours: number;
  /** Test seam; defaults to Date.now(). */
  nowMs?: number;
}

/**
 * Phase 2 RF-evidence coverage summary — surfaced on the run result and, via
 * `meshIssuesScheduler`'s widened `lastRunResult` type, on
 * `GET /api/analysis/mesh-issues/status` with no scheduler edit required
 * (spec §2.9/§2.10).
 */
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
  durationMs: number;
  sourceCount: number;
  nodeCount: number;
  findingCount: number;
  newCount: number;
  reopenedCount: number;
  updatedCount: number;
  closedCount: number;
  byType: Record<string, number>;
  corpusStats: TracerouteCorpusStats;
  coverage: MeshIssuesCoverage;
}

interface PersistOutcome {
  newCount: number;
  reopenedCount: number;
  updatedCount: number;
  closedCount: number;
  byType: Record<string, number>;
}

function zeroCorpusStats(): TracerouteCorpusStats {
  return {
    rawCount: 0,
    validCount: 0,
    dedupedCount: 0,
    sampledCount: 0,
    distinctPairCount: 0,
    truncated: false,
  };
}

function zeroCoverage(): MeshIssuesCoverage {
  return {
    evidence: { neighborInfo: false, traceroute: false, mqttGateway: false, packetLog: false },
    neighborInfoRowCount: 0,
    neighborInfoEdgeCount: 0,
    tracerouteEdgeCount: 0,
    tracerouteSentinelHopsDropped: 0,
    gatewayCount: 0,
    gatewayDirectEdgeCount: 0,
    gatewayCoReceptionEdgeCount: 0,
    gatewayCellsSkipped: 0,
    directEdgeCount: 0,
    totalEdgeCount: 0,
    graphNodeCount: 0,
    snrDirectionsWithMinSamples: 0,
    hopHorizonSource: null,
    hopHorizonNodeCount: 0,
    skippedRules: [],
  };
}

function zeroResult(durationMs: number): MeshIssuesRunResult {
  return {
    durationMs,
    sourceCount: 0,
    nodeCount: 0,
    findingCount: 0,
    newCount: 0,
    reopenedCount: 0,
    updatedCount: 0,
    closedCount: 0,
    byType: {},
    corpusStats: zeroCorpusStats(),
    coverage: zeroCoverage(),
  };
}

/** Stable identity key for a finding/issue, matching the (issueType, subjectKey) UNIQUE index. */
function identityKey(issueType: string, subjectKey: string): string {
  return JSON.stringify([issueType, subjectKey]);
}

class MeshIssuesAnalysisService {
  /**
   * Run the full Tier A analysis once: pool physical nodes across every
   * resolved source, build telemetry series and infra-node position spans,
   * evaluate the rules, and persist findings. Throws on unexpected failure —
   * the scheduler owns logging and last-run bookkeeping (mesh-impact
   * checklist §3: a rejected run still must not look like a trigger).
   */
  async runAnalysis(opts: MeshIssuesRunOptions): Promise<MeshIssuesRunResult> {
    const start = Date.now();
    const nowMs = opts.nowMs ?? Date.now();
    const sinceMs = nowMs - opts.lookbackHours * 3600_000;

    // 1. Sources — Meshtastic TCP + MQTT only. MeshCore/Reticulum are
    // excluded: neither writes nodes/telemetry (MeshCore lives in
    // meshcore_nodes and is evaluated separately in a later phase).
    const allSources = await databaseService.sources.getAllSources();
    const sourceIds = allSources
      .filter((s) => s.enabled !== false)
      .filter((s) => s.type === 'meshtastic_tcp' || isMqttSourceType(s.type))
      .map((s) => s.id);

    if (sourceIds.length === 0) {
      return zeroResult(Date.now() - start);
    }
    const sourceIdSet = new Set(sourceIds);
    // MQTT-type sources among the resolved set — feeds gateway-receptions
    // evidence (5c) and B7's "heard only via MQTT" guard.
    const mqttSourceIds = new Set(
      allSources
        .filter((s) => s.enabled !== false)
        .filter((s) => isMqttSourceType(s.type))
        .map((s) => s.id),
    );

    // 2. Nodes — pool physical nodes across every resolved source.
    // intentional cross-source: findings pool physical nodes across every Meshtastic source
    const allNodes = (await databaseService.nodes.getAllNodes(ALL_SOURCES)) as unknown as NodeRow[];
    const nodeInputs: PooledNodeInput[] = allNodes
      .filter((n) => sourceIdSet.has(n.sourceId))
      .map((n) => ({
        nodeNum: n.nodeNum,
        nodeId: n.nodeId,
        sourceId: n.sourceId,
        longName: n.longName,
        shortName: n.shortName,
        hwModel: n.hwModel,
        role: n.role ?? null,
        isUnmessagable: n.isUnmessagable ?? null,
        firmwareVersion: n.firmwareVersion ?? null,
        batteryLevel: n.batteryLevel ?? null,
        voltage: n.voltage ?? null,
        channelUtilization: n.channelUtilization ?? null,
        airUtilTx: n.airUtilTx ?? null,
        latitude: n.latitude ?? null,
        longitude: n.longitude ?? null,
        positionOverrideEnabled: n.positionOverrideEnabled ?? null,
        latitudeOverride: n.latitudeOverride ?? null,
        longitudeOverride: n.longitudeOverride ?? null,
        positionPrecisionBits: n.positionPrecisionBits ?? null,
        mobile: n.mobile ?? null,
        lastHeard: n.lastHeard ?? null,
        updatedAt: n.updatedAt ?? null,
      }));
    const nodes = buildPooledNodeSnapshot(nodeInputs);

    // 3. Telemetry — one query across every metric Tier A needs; no per-node loop.
    const telemetryRows = (await databaseService.telemetry.getTelemetryByTypesSince(
      [...MESH_ISSUE_TELEMETRY_TYPES],
      sinceMs,
      sourceIds,
    )) as unknown as TelemetryRow[];
    const telemetryInputs: TelemetryRowInput[] = telemetryRows.map((r) => ({
      nodeNum: r.nodeNum,
      telemetryType: r.telemetryType,
      timestamp: r.timestamp,
      value: r.value,
      sourceId: r.sourceId,
    }));
    const telemetry = buildTelemetrySeries(telemetryInputs);

    // 4. Position spans (A4 input) — infra-role nodes only, bounded chunks.
    const positionSpanMeters = await this.buildPositionSpans(nodes);

    // 5. Traceroute corpus — paginate up to MAX_CORPUS_PAGES, capped.
    const { rows: traceroutes, truncated } = await this.loadTracerouteCorpusRows(sourceIds, sinceMs);
    const { samples, stats: corpusStats } = buildTracerouteCorpus(traceroutes, {
      pairBucketHours: opts.pairBucketHours,
      truncated,
    });

    // 5b. Neighbours (RF evidence class 1) — always queried, one bounded
    // call, no per-node loop. A throw degrades rather than aborts the run.
    let neighborRows: NeighborRow[] = [];
    let neighborInfoAvailable = true;
    try {
      const result = await databaseService.analysis.getNeighbors({ sourceIds, sinceMs });
      neighborRows = result.items;
    } catch (err) {
      logger.warn(`[meshIssues] neighbors query failed, degrading: ${(err as Error)?.message ?? err}`);
      neighborInfoAvailable = false;
    }
    const neighbors: NeighborEdgeInput[] = neighborRows.map((r) => ({
      nodeNum: r.nodeNum,
      neighborNum: r.neighborNum,
      snr: r.snr,
      timestamp: r.timestamp,
      sourceId: r.sourceId,
    }));

    // 5c. MQTT gateway receptions (RF evidence class 3) — conditional on the
    // global mqtt_packet_log_enabled setting AND at least one resolved MQTT
    // source. Otherwise [] and availability.mqttGateway stays false.
    let gatewayReceptions: GatewayDirectReceptionInput[] = [];
    let mqttGatewayAvailable = false;
    let mqttPacketLogEnabled: boolean;
    try {
      mqttPacketLogEnabled = await mqttPacketLogService.isEnabled();
    } catch (err) {
      logger.warn(`[meshIssues] mqttPacketLogService.isEnabled() failed, degrading: ${(err as Error)?.message ?? err}`);
      mqttPacketLogEnabled = false;
    }
    if (mqttPacketLogEnabled && mqttSourceIds.size > 0) {
      try {
        const rows = await databaseService.getMqttDirectReceptionsByGatewayAsync({
          sourceIds: [...mqttSourceIds],
          since: sinceMs,
        });
        gatewayReceptions = rows;
        mqttGatewayAvailable = true;
      } catch (err) {
        logger.warn(`[meshIssues] gateway-receptions query failed, degrading: ${(err as Error)?.message ?? err}`);
        mqttGatewayAvailable = false;
        gatewayReceptions = [];
      }
    }

    // 5d. RF adjacency graph — pure, synchronous, no I/O.
    const availability: RfEvidenceAvailability = {
      neighborInfo: neighborInfoAvailable,
      traceroute: samples.length > 0,
      mqttGateway: mqttGatewayAvailable,
      packetLog: false, // set below in 5e once packetLogService.isEnabled() is known
    };
    const graph = buildRfGraph({ samples, neighbors, gatewayReceptions, availability });

    // 5e. Hop horizon (B6 evidence) — preference rule (spec §3.3, D8):
    // packet_log (our own RF vantage) wins when non-empty; mqtt_packet_log
    // is only a fallback when packet_log is enabled but returned nothing, or
    // is not enabled at all. The two logs are never merged.
    const hopHorizon = new Map<number, HopHorizonStats>();
    let hopHorizonSource: 'packet_log' | 'mqtt_packet_log' | null = null;
    let packetLogEnabled: boolean;
    try {
      packetLogEnabled = await packetLogService.isEnabled();
    } catch (err) {
      logger.warn(`[meshIssues] packetLogService.isEnabled() failed, degrading: ${(err as Error)?.message ?? err}`);
      packetLogEnabled = false;
    }
    if (packetLogEnabled) {
      try {
        const rows = await databaseService.getPacketHopArrivalCountsAsync({ since: sinceMs, sourceIds });
        if (rows.length > 0) {
          hopHorizonSource = 'packet_log';
          for (const r of rows) {
            hopHorizon.set(r.nodeNum, {
              totalPackets: r.totalPackets,
              exhaustedPackets: r.exhaustedPackets,
              sourceIds: [...sourceIds],
            });
          }
        }
      } catch (err) {
        logger.warn(`[meshIssues] packet_log hop-arrival query failed, degrading: ${(err as Error)?.message ?? err}`);
        packetLogEnabled = false;
      }
    }
    if (hopHorizonSource === null && mqttPacketLogEnabled && mqttSourceIds.size > 0) {
      try {
        const rows = await databaseService.getMqttPacketHopArrivalCountsAsync({
          since: sinceMs,
          sourceIds: [...mqttSourceIds],
        });
        if (rows.length > 0) {
          hopHorizonSource = 'mqtt_packet_log';
          for (const r of rows) {
            hopHorizon.set(r.nodeNum, {
              totalPackets: r.totalPackets,
              exhaustedPackets: r.exhaustedPackets,
              sourceIds: [...mqttSourceIds],
            });
          }
        }
      } catch (err) {
        logger.warn(`[meshIssues] mqtt_packet_log hop-arrival query failed, degrading: ${(err as Error)?.message ?? err}`);
      }
    }
    graph.stats.availability.packetLog = packetLogEnabled;

    // 6. Evaluate Tier A — never throws; a rule that can't evaluate contributes no findings.
    const ctx: RuleContext = { nodes, telemetry, positionSpanMeters, nowMs };
    const findings = evaluateAllTierA(ctx);

    // 6b. Evaluate Tier B — graph-based rules layered on top of Tier A.
    const tierBCtx: TierBRuleContext = { nodes, graph, samples, hopHorizon, mqttSourceIds, nowMs };
    findings.push(...evaluateAllTierB(tierBCtx));
    const skippedRules = tierBSkips(tierBCtx);

    // 7. Persist — issue-type agnostic; Tier B findings flow through the
    // same upsert/clean-run bookkeeping as Tier A.
    const persistResult = await this.persistFindings(findings, nowMs);

    const durationMs = Date.now() - start;
    logger.debug(
      `[meshIssues] Analysis run: ${findings.length} finding(s) from ${nodes.size} node(s) ` +
      `across ${sourceIds.length} source(s) (${persistResult.newCount} new, ` +
      `${persistResult.reopenedCount} reopened, ${persistResult.updatedCount} updated, ` +
      `${persistResult.closedCount} auto-closed), in ${durationMs}ms`
    );

    const coverage: MeshIssuesCoverage = {
      evidence: graph.stats.availability,
      neighborInfoRowCount: graph.stats.neighborInfoRowCount,
      neighborInfoEdgeCount: graph.stats.neighborInfoEdgeCount,
      tracerouteEdgeCount: graph.stats.tracerouteEdgeCount,
      tracerouteSentinelHopsDropped: graph.stats.tracerouteSentinelHopsDropped,
      gatewayCount: graph.stats.gatewayCount,
      gatewayDirectEdgeCount: graph.stats.gatewayDirectEdgeCount,
      gatewayCoReceptionEdgeCount: graph.stats.gatewayCoReceptionEdgeCount,
      gatewayCellsSkipped: graph.stats.gatewayCellsSkipped,
      directEdgeCount: graph.stats.directEdgeCount,
      totalEdgeCount: graph.stats.totalEdgeCount,
      graphNodeCount: graph.stats.nodeCount,
      snrDirectionsWithMinSamples: graph.stats.snrDirectionsWithMinSamples,
      hopHorizonSource,
      hopHorizonNodeCount: hopHorizon.size,
      skippedRules,
    };

    return {
      durationMs,
      sourceCount: sourceIds.length,
      nodeCount: nodes.size,
      findingCount: findings.length,
      ...persistResult,
      corpusStats,
      coverage,
    };
  }

  /**
   * Position-span lookups (meters) for infra-role nodes only, in bounded
   * chunks of `POSITION_SPAN_CHUNK_SIZE`. Infra nodes are a small fraction of
   * the DB; a full-mesh per-node loop is not what this does.
   */
  private async buildPositionSpans(nodes: Map<number, PooledNode>): Promise<Map<number, number>> {
    const infraNodes = [...nodes.values()].filter((n) => n.role != null && INFRA_ROLES.has(n.role));
    const result = new Map<number, number>();

    for (let i = 0; i < infraNodes.length; i += POSITION_SPAN_CHUNK_SIZE) {
      const chunk = infraNodes.slice(i, i + POSITION_SPAN_CHUNK_SIZE);
      const chunkResults = await Promise.all(
        chunk.map(async (node) => {
          // intentional cross-source: A4's span measurement pools all sources'
          // positions, matching nodeMobilityService's own accessor + sample cap
          // so the two classifications can never disagree about the geometry.
          const rows = await databaseService.telemetry.getPositionTelemetryByNode(
            node.nodeId,
            POSITION_SPAN_SAMPLE_LIMIT,
            undefined,
            ALL_SOURCES,
          );
          const lats = rows.filter((r) => r.telemetryType === 'latitude').map((r) => r.value);
          const lons = rows.filter((r) => r.telemetryType === 'longitude').map((r) => r.value);
          const spanKm = positionSpanKm(lats, lons);
          return { nodeNum: node.nodeNum, spanKm };
        }),
      );
      for (const { nodeNum, spanKm } of chunkResults) {
        if (spanKm != null) result.set(nodeNum, spanKm * 1000);
      }
    }

    return result;
  }

  /**
   * Paginate `analysis.getTraceroutes` until exhausted or `MAX_CORPUS_PAGES`
   * is reached. `truncated` is set only when the page cap — not the natural
   * end of the result set — is what stopped the loop.
   */
  private async loadTracerouteCorpusRows(
    sourceIds: string[],
    sinceMs: number,
  ): Promise<{ rows: TracerouteRow[]; truncated: boolean }> {
    const rows: TracerouteRow[] = [];
    let cursor: string | null = null;
    let truncated = false;

    for (let page = 0; page < MAX_CORPUS_PAGES; page++) {
      const result = await databaseService.analysis.getTraceroutes({
        sourceIds,
        sinceMs,
        pageSize: TRACEROUTE_PAGE_SIZE,
        cursor,
      });
      rows.push(...result.items);
      if (!result.hasMore) break;
      cursor = result.nextCursor;
      if (page === MAX_CORPUS_PAGES - 1) truncated = true;
    }

    return { rows, truncated };
  }

  /**
   * Upsert every finding from this run, then bump `cleanRuns` for every open
   * (including dismissed) issue that was NOT re-detected — the auto-close
   * bookkeeping. `upsertFinding` never clears `dismissed` on re-detection, so
   * a dismissed issue is never un-dismissed here; it still accumulates clean
   * runs toward auto-close when it stops recurring.
   */
  private async persistFindings(findings: MeshIssueFinding[], nowMs: number): Promise<PersistOutcome> {
    let newCount = 0;
    let reopenedCount = 0;
    let updatedCount = 0;
    let closedCount = 0;
    const byType: Record<string, number> = {};
    const detectedKeys = new Set<string>();

    for (const finding of findings) {
      byType[finding.issueType] = (byType[finding.issueType] ?? 0) + 1;
      detectedKeys.add(identityKey(finding.issueType, finding.subjectKey));

      const { outcome } = await databaseService.upsertMeshIssueFindingAsync(finding, nowMs);
      if (outcome === 'created') newCount++;
      else if (outcome === 'reopened') reopenedCount++;
      else updatedCount++;
    }

    const openIssues = await databaseService.getMeshIssuesAsync({ includeClosed: false, includeDismissed: true });
    for (const issue of openIssues) {
      const key = identityKey(issue.issueType, issue.subjectKey);
      if (detectedKeys.has(key)) continue;
      const { closed } = await databaseService.bumpMeshIssueCleanRunAsync(issue.id, AUTO_CLOSE_CLEAN_RUNS, nowMs);
      if (closed) closedCount++;
    }

    return { newCount, reopenedCount, updatedCount, closedCount, byType };
  }
}

export const meshIssuesAnalysisService = new MeshIssuesAnalysisService();
