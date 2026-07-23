import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { ALL_SOURCES } from '../../db/repositories/index.js';
import { calculateDistance } from '../../utils/distance.js';
import { resolveSourceManager } from '../utils/resolveSourceManager.js';
import { getEffectiveDbNodePosition } from '../utils/nodeEnhancer.js';

type DistanceAction = 'delete' | 'ignore';

interface ProcessedNodeInfo {
  nodeId: string;
  nodeName: string;
  distanceKm: number;
  action: DistanceAction;
}

/**
 * Resolved per-source config for the inline (per-packet) distance check
 * (issue #3900). Cached briefly so a busy MQTT broker doesn't issue a handful
 * of settings queries for every position packet — see {@link AutoDeleteByDistanceService.getInlineConfig}.
 */
interface InlineDistanceConfig {
  enabled: boolean;
  homeLat: number;
  homeLon: number;
  thresholdKm: number;
  action: DistanceAction;
  localNodeNum: number | null;
}

/** Outcome of {@link AutoDeleteByDistanceService.applyInlineDistanceCheck}. */
export type InlineDistanceOutcome = 'kept' | 'deleted' | 'ignored';

/**
 * Core auto-delete-by-distance logic (issue #3901).
 *
 * This service holds NO scheduling state — the periodic timers live on the
 * per-source {@link DistanceDeleteScheduler} owned by each source manager, so
 * every scheduled run is scoped to a single source. `runDeleteCycle(sourceId)`
 * and `runNow(sourceId)` are the only entry points; the old global
 * `start()`/`stop()` all-sources singleton was removed.
 */
class AutoDeleteByDistanceService {
  private lastRunAt: number | null = null;
  // Per-source re-entrancy guard: a source's cycle skips only if that SAME
  // source already has one in flight, so concurrent per-source schedulers
  // don't spuriously block each other (a global boolean used to).
  private readonly runningSources = new Set<string>();

  // Short-TTL per-source cache of the resolved inline-check config (#3900).
  // Keyed by sourceId. Invalidated on TTL expiry and eagerly whenever a
  // source's DistanceDeleteScheduler (re)starts on a settings change.
  private readonly inlineConfigCache = new Map<string, { cfg: InlineDistanceConfig; expiresAt: number }>();
  private readonly INLINE_CONFIG_TTL_MS = 60_000;

  /**
   * Drop the cached inline config for a source (or all sources when omitted),
   * so the next {@link applyInlineDistanceCheck} re-reads settings. Called by
   * {@link DistanceDeleteScheduler} on start/stop — i.e. whenever the source's
   * auto-delete-by-distance settings change.
   */
  public clearInlineConfigCache(sourceId?: string): void {
    if (sourceId) {
      this.inlineConfigCache.delete(sourceId);
    } else {
      this.inlineConfigCache.clear();
    }
  }

  /**
   * Read (and briefly cache) the per-source inline-check config. The feature is
   * only considered `enabled` when the source has it toggled on AND has valid
   * home coordinates — mirroring the guard in {@link runDeleteCycle}.
   */
  private async getInlineConfig(sourceId: string): Promise<InlineDistanceConfig> {
    const now = Date.now();
    const cached = this.inlineConfigCache.get(sourceId);
    if (cached && cached.expiresAt > now) {
      return cached.cfg;
    }

    const s = databaseService.settings;
    const enabledStr = await s.getSettingForSource(sourceId, 'autoDeleteByDistanceEnabled');
    const homeLat = parseFloat((await s.getSettingForSource(sourceId, 'autoDeleteByDistanceLat')) || '');
    const homeLon = parseFloat((await s.getSettingForSource(sourceId, 'autoDeleteByDistanceLon')) || '');
    const thresholdRaw = parseFloat((await s.getSettingForSource(sourceId, 'autoDeleteByDistanceThresholdKm')) || '100');
    const actionRaw = (await s.getSettingForSource(sourceId, 'autoDeleteByDistanceAction')) || 'delete';
    const localNodeNumStr = await s.getSettingForSource(sourceId, 'localNodeNum');

    const cfg: InlineDistanceConfig = {
      enabled: enabledStr === 'true' && !isNaN(homeLat) && !isNaN(homeLon),
      homeLat,
      homeLon,
      thresholdKm: isNaN(thresholdRaw) ? 100 : thresholdRaw,
      action: actionRaw === 'ignore' ? 'ignore' : 'delete',
      localNodeNum: localNodeNumStr ? Number(localNodeNumStr) : null,
    };
    this.inlineConfigCache.set(sourceId, { cfg, expiresAt: now + this.INLINE_CONFIG_TTL_MS });
    return cfg;
  }

  /**
   * Inline (per-packet) distance check for a single node position (issue #3900).
   *
   * Called synchronously from MQTT ingestion as each POSITION packet arrives so
   * a node beyond the source's configured radius never touches the nodeDB / map
   * even momentarily — instead of being cleaned up on the next periodic
   * {@link runDeleteCycle}. Returns:
   *   - `'kept'`    → feature off, within range, or protected → caller ingests
   *   - `'deleted'` → beyond range, action=delete → any existing row is removed;
   *                   caller must NOT upsert
   *   - `'ignored'` → beyond range, action=ignore → node marked ignored (so the
   *                   MQTT ignore gate drops its later traffic); caller skips upsert
   *
   * Protections mirror {@link runDeleteCycle}: the local node and favorited nodes
   * are never touched. `lat`/`lon` must be a trustworthy fix (callers gate on
   * their bogus-position check first).
   */
  public async applyInlineDistanceCheck(
    sourceId: string,
    nodeNum: number,
    lat: number,
    lon: number,
  ): Promise<InlineDistanceOutcome> {
    const cfg = await this.getInlineConfig(sourceId);
    if (!cfg.enabled) return 'kept';

    // Protect the local node.
    if (cfg.localNodeNum != null && Number(nodeNum) === cfg.localNodeNum) return 'kept';

    const distance = calculateDistance(cfg.homeLat, cfg.homeLon, lat, lon);
    if (distance <= cfg.thresholdKm) return 'kept';

    // Beyond threshold — but never touch a favorite (parity with runDeleteCycle).
    const existing = await databaseService.nodes.getNode(nodeNum, sourceId);
    if (existing?.isFavorite) return 'kept';

    try {
      if (cfg.action === 'ignore') {
        // Skip the write if it's already ignored (either mechanism) — the
        // ignore gate will keep dropping its traffic regardless.
        if (!existing?.isIgnored && !databaseService.ignoredNodes.isIgnoredCached(nodeNum, sourceId)) {
          await databaseService.setNodeIgnoredAsync(nodeNum, true, sourceId);
        }
        return 'ignored';
      }
      // action === 'delete'
      if (existing) {
        await databaseService.deleteNodeAsync(nodeNum, sourceId);
      }
      return 'deleted';
    } catch (error) {
      logger.error(
        `❌ Auto-delete-by-distance (inline): failed to ${cfg.action} node ${nodeNum}@${sourceId}:`,
        error,
      );
      // The node is beyond range either way — tell the caller to skip ingest so
      // a transient DB error can't let an out-of-range node persist.
      return cfg.action === 'ignore' ? 'ignored' : 'deleted';
    }
  }

  /**
   * Run now (manual trigger from API)
   */
  public async runNow(sourceId?: string): Promise<{ deletedCount: number }> {
    return this.runDeleteCycle(sourceId);
  }

  /**
   * Get service status
   */
  public getStatus(): { running: boolean; lastRunAt?: number } {
    return {
      running: this.runningSources.size > 0,
      lastRunAt: this.lastRunAt ?? undefined,
    };
  }

  /**
   * Core deletion logic
   */
  public async runDeleteCycle(sourceId?: string): Promise<{ deletedCount: number }> {
    const runKey = sourceId ?? 'default';
    if (this.runningSources.has(runKey)) {
      logger.debug(`⏭️ Auto-delete-by-distance: skipping source ${runKey}, already running`);
      return { deletedCount: 0 };
    }

    this.runningSources.add(runKey);
    const processedNodes: ProcessedNodeInfo[] = [];

    try {
      // Read settings scoped to this source (no global fallback — an unset
      // per-source key reads empty and the cycle no-ops on missing coords).
      const homeLat = parseFloat(await databaseService.settings.getSettingForSource(sourceId, 'autoDeleteByDistanceLat') || '');
      const homeLon = parseFloat(await databaseService.settings.getSettingForSource(sourceId, 'autoDeleteByDistanceLon') || '');
      const thresholdKm = parseFloat(await databaseService.settings.getSettingForSource(sourceId, 'autoDeleteByDistanceThresholdKm') || '100');
      const actionRaw = (await databaseService.settings.getSettingForSource(sourceId, 'autoDeleteByDistanceAction')) || 'delete';
      const action: DistanceAction = actionRaw === 'ignore' ? 'ignore' : 'delete';

      if (isNaN(homeLat) || isNaN(homeLon)) {
        logger.debug('⏭️ Auto-delete-by-distance: no home coordinate configured, skipping');
        return { deletedCount: 0 };
      }

      // Get local node number to protect it (per-source with global fallback)
      const localNodeNumStr = await databaseService.settings.getSettingForSource(sourceId, 'localNodeNum');
      const localNodeNum = localNodeNumStr ? Number(localNodeNumStr) : null;

      // Get all nodes (must use async for PostgreSQL/MySQL)
      // intentional cross-source: when sourceId is omitted, scan all sources
      const allNodes = await databaseService.nodes.getAllNodes(sourceId ?? ALL_SOURCES);

      // Throttle device syncs so firmware admin queue doesn't back up on
      // large MQTT meshes with hundreds of nodes to ignore per cycle.
      const SYNC_DELAY_MS = 5000;
      let firmwareUnsupported = false;
      let pendingSyncDelay = false;

      for (const node of allNodes) {
        // Protect local node
        if (localNodeNum != null && Number(node.nodeNum) === localNodeNum) {
          continue;
        }

        // Protect favorited nodes
        if (node.isFavorite) {
          continue;
        }

        // Skip nodes without position. Use effective position so a user-set
        // override is what the distance check sees (issue #2847).
        const eff = getEffectiveDbNodePosition(node);
        if (eff.latitude == null || eff.longitude == null) {
          continue;
        }

        // Calculate distance
        const distance = calculateDistance(homeLat, homeLon, eff.latitude, eff.longitude);

        if (distance > thresholdKm) {
          const nodeSourceId = (node as any).sourceId || sourceId || 'default';
          const nodeNum = Number(node.nodeNum);
          const nodeInfo: ProcessedNodeInfo = {
            nodeId: node.nodeId || `!${nodeNum.toString(16)}`,
            nodeName: node.longName || node.shortName || `Node ${node.nodeNum}`,
            distanceKm: Math.round(distance * 10) / 10,
            action,
          };

          try {
            if (action === 'ignore') {
              // Skip nodes already marked ignored — nothing to do in DB,
              // and the device already knows (or tried once this session).
              if (node.isIgnored) {
                continue;
              }

              await databaseService.setNodeIgnoredAsync(nodeNum, true, nodeSourceId);
              processedNodes.push(nodeInfo);

              // Device sync: throttled + short-circuit on unsupported firmware
              if (!firmwareUnsupported) {
                if (pendingSyncDelay) {
                  await new Promise((resolve) => setTimeout(resolve, SYNC_DELAY_MS));
                }
                const manager = resolveSourceManager(nodeSourceId);
                try {
                  await manager.sendIgnoredNode(nodeNum);
                  pendingSyncDelay = true;
                } catch (syncError) {
                  if (syncError instanceof Error && syncError.message === 'FIRMWARE_NOT_SUPPORTED') {
                    logger.debug(`ℹ️ Auto-delete-by-distance: firmware does not support ignored nodes; skipping device sync for remaining nodes this cycle`);
                    firmwareUnsupported = true;
                  } else {
                    logger.warn(`⚠️ Auto-delete-by-distance: failed to sync ignored status to device for node ${nodeNum}:`, syncError);
                    // Still throttle after a failed send — firmware may be busy
                    pendingSyncDelay = true;
                  }
                }
              }
            } else {
              await databaseService.deleteNodeAsync(nodeNum, nodeSourceId);
              processedNodes.push(nodeInfo);
            }
          } catch (error) {
            logger.error(`❌ Auto-delete-by-distance: failed to ${action} node ${node.nodeNum}:`, error);
          }
        }
      }

      // Log results
      const now = Date.now();
      this.lastRunAt = now;

      await this.logRunAsync(now, processedNodes.length, thresholdKm, processedNodes, sourceId);

      if (processedNodes.length > 0) {
        const verb = action === 'ignore' ? 'ignored' : 'deleted';
        logger.info(`🗑️ Auto-delete-by-distance: ${verb} ${processedNodes.length} node(s) beyond ${thresholdKm} km`);
      } else {
        logger.debug('✅ Auto-delete-by-distance: no nodes beyond threshold');
      }

      return { deletedCount: processedNodes.length };
    } catch (error) {
      logger.error('❌ Auto-delete-by-distance: error during run:', error);
      return { deletedCount: 0 };
    } finally {
      this.runningSources.delete(runKey);
    }
  }

  /**
   * Log a run to the auto_distance_delete_log table via DatabaseService
   */
  private async logRunAsync(
    timestamp: number,
    nodesDeleted: number,
    thresholdKm: number,
    details: ProcessedNodeInfo[],
    sourceId?: string
  ): Promise<void> {
    try {
      await databaseService.distanceDeleteLog.addDistanceDeleteLogEntry({
        timestamp,
        nodesDeleted,
        thresholdKm,
        details: JSON.stringify(details),
        sourceId,
      });
    } catch (error) {
      logger.error('❌ Auto-delete-by-distance: failed to log run:', error);
    }
  }
}

export const autoDeleteByDistanceService = new AutoDeleteByDistanceService();
