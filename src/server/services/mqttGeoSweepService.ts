import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { getEffectiveDbNodePosition } from '../utils/nodeEnhancer.js';
import { MqttPacketFilter, type MqttFilterConfig } from '../mqttPacketFilter.js';

export interface GeoSweepStats {
  sourceId: string;
  timestamp: number; // Date.now() at completion
  scanned: number; // position-bearing, not-already-ignored node rows evaluated
  ignored: number; // addGeoIgnoreAsync returned true (new geo rows)
  purged: number; // deleteNodeAsync calls that succeeded
  lifted: number; // geo entries lifted (lift pass); 0 when lift:false
  durationMs: number;
}

export interface GeoSweepStatsSink {
  recordGeoSweepStats(stats: GeoSweepStats): void;
}

export interface RunSweepOptions {
  lift: boolean;
  sink?: GeoSweepStatsSink;
}

/**
 * Retroactive geo sweep (MQTT Geo-Ignore epic, Phase 3, WP1).
 *
 * The realtime geo filter (`mqttIngestion.ts` POSITION_APP branch) is
 * fail-open by design: it only classifies a node against the configured bbox
 * when a fresh POSITION packet arrives for that node. A node that already has
 * a stored position (from before the bbox was configured, or from before this
 * bridge started) sits in the database unclassified until its next POSITION
 * update — which may be minutes or hours away, or may never come again if the
 * node is dead. This service closes that gap by retroactively classifying
 * every stored node against the current bbox in one pass.
 *
 * Two call sites, two different sweep shapes:
 *   - **Bridge/source start**: there is no "old bbox" to diff against, so the
 *     sweep only ever needs to ADD new geo-ignores (`lift: false`) — any node
 *     that was previously lifted is already un-ignored and stays that way.
 *   - **Config save**: the bbox may have grown, shrunk, or moved, so the
 *     sweep runs a LIFT pass first (nodes geo-ignored under the old bbox that
 *     the new bbox would no longer exclude become un-ignored and reappear)
 *     followed by the ADD pass (nodes newly outside the new bbox get
 *     geo-ignored and purged).
 *
 * Lifted nodes are not actively re-verified against live position data here
 * — they simply become eligible again, and the realtime POSITION path
 * (`mqttIngestion.ts`) self-corrects them on their next packet: a lifted node
 * still outside the (possibly changed) bbox gets re-ignored the moment it
 * reports a position, exactly like any other node. This keeps the sweep itself
 * simple and side-effect-free beyond the ignore-list and node-purge state.
 *
 * The sweep does a single unpaginated `getAllNodes(sourceId)` scan. This is
 * deliberate: per-source node counts are expected to stay in the low
 * thousands, and sweeps are rare (source start, config save) rather than a
 * hot/frequent path — the simplicity of one full scan outweighs the
 * complexity of pagination for this access pattern.
 */
class MqttGeoSweepService {
  /**
   * Per-source serialization. A second `runSweep` call for a source already
   * in flight is chained onto the tail of the first via `.then`, so sweeps
   * for the same source never run concurrently (which could double-count
   * stats or race the ignore-list cache). `.catch(() => undefined)` isolates
   * a prior sweep's failure from the chain — one failed sweep must not sink
   * every subsequent sweep for that source. The map entry is cleared in
   * `.finally` only when this call is still the tail, mirroring the
   * `cliCommandLocks` pattern in `meshcoreManager.ts`.
   */
  private readonly inFlight = new Map<string, Promise<GeoSweepStats>>();

  async runSweep(
    sourceId: string,
    geo: MqttFilterConfig['geo'] | undefined,
    opts: RunSweepOptions,
  ): Promise<GeoSweepStats> {
    const prior = this.inFlight.get(sourceId) ?? Promise.resolve();
    const runNext = prior.catch(() => undefined).then(() => this.runSweepLocked(sourceId, geo, opts));
    this.inFlight.set(sourceId, runNext);
    try {
      return await runNext;
    } finally {
      if (this.inFlight.get(sourceId) === runNext) {
        this.inFlight.delete(sourceId);
      }
    }
  }

  private async runSweepLocked(
    sourceId: string,
    geo: MqttFilterConfig['geo'] | undefined,
    opts: RunSweepOptions,
  ): Promise<GeoSweepStats> {
    const start = Date.now();
    let scanned = 0;
    let ignored = 0;
    let purged = 0;
    let lifted = 0;

    // LIFT PASS — only when requested (config-save sweeps). Manual entries
    // are never touched: liftGeoIgnoreAsync itself is reason='geo'-guarded,
    // but we also pre-filter here so we never even attempt a lift on a
    // manual row.
    if (opts.lift) {
      const ignoredEntries = await databaseService.ignoredNodes.getIgnoredNodesAsync(sourceId);
      for (const entry of ignoredEntries) {
        if (entry.reason !== 'geo') continue;
        const didLift = await databaseService.ignoredNodes.liftGeoIgnoreAsync(Number(entry.nodeNum), sourceId);
        if (didLift) lifted++;
      }
    }

    // ADD PASS — always runs. With no bbox configured, classifyPosition
    // returns 'no-geo' for every node, so this naturally no-ops.
    const filter = new MqttPacketFilter({ geo });
    const allNodes = await databaseService.nodes.getAllNodes(sourceId);

    for (const node of allNodes) {
      const nodeNum = Number(node.nodeNum); // BIGINT coercion (PostgreSQL/MySQL)

      // Already-ignored nodes (geo or manual) are skipped — nothing to do.
      if (databaseService.ignoredNodes.isIgnoredCached(nodeNum, sourceId)) continue;

      // Effective position honors a user-set override (issue #2847), same as
      // autoDeleteByDistanceService.
      const eff = getEffectiveDbNodePosition(node);
      if (eff.latitude == null || eff.longitude == null) continue; // fail-open: no position, no opinion

      scanned++;

      const classification = filter.classifyPosition({
        latitudeI: Math.round(eff.latitude * 1e7),
        longitudeI: Math.round(eff.longitude * 1e7),
      });

      if (classification !== 'out') continue;

      const nodeId = node.nodeId || `!${nodeNum.toString(16).padStart(8, '0')}`;
      const inserted = await databaseService.ignoredNodes.addGeoIgnoreAsync(
        nodeNum,
        sourceId,
        nodeId,
        node.longName ?? undefined,
        node.shortName ?? undefined,
      );

      if (inserted) {
        ignored++;
        // Purge-once: only the true→false transition (a NEW geo-ignore row)
        // purges. If addGeoIgnoreAsync returned false the node was already
        // ignored (e.g. a manual row raced in) and must not be purged again.
        try {
          await databaseService.deleteNodeAsync(nodeNum, sourceId);
          purged++;
        } catch (err) {
          logger.warn(`⚠️ geo sweep [${sourceId}]: failed to purge node ${nodeNum} after geo-ignore:`, err);
        }
      }
    }

    const durationMs = Date.now() - start;
    const stats: GeoSweepStats = {
      sourceId,
      timestamp: Date.now(),
      scanned,
      ignored,
      purged,
      lifted,
      durationMs,
    };

    if (ignored > 0 || purged > 0 || lifted > 0) {
      logger.info(`geo sweep [${sourceId}]: ignored ${ignored}, purged ${purged}, lifted ${lifted}, scanned ${scanned}`);
    } else {
      logger.debug(`geo sweep [${sourceId}]: no changes (scanned ${scanned})`);
    }

    opts.sink?.recordGeoSweepStats(stats);
    return stats;
  }
}

export const mqttGeoSweepService = new MqttGeoSweepService();
