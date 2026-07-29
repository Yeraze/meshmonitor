import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { notificationService } from './notificationService.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { HourlyLogLimiter } from '../utils/hourlyLogLimiter.js';
import { parseMonitoredUnion, countMonitoredNodes, formatSourceIdForLog, logZeroEligiblePrefRows } from '../utils/notificationCheckHelpers.js';
import { getInactiveNodeConfig } from './nodeDisplaySettings.js';

interface InactiveNodeCheck {
  nodeId: string;
  nodeNum: number;
  longName: string;
  shortName: string;
  lastHeard: number;
  inactiveHours: number;
  sourceId: string;
  sourceName: string;
}

/** One flagged (userId, sourceId) preferences row as returned by the repository. */
interface InactiveNodePrefRow {
  userId: number;
  sourceId: string;
  notifyOnInactiveNode: boolean;
  notifyOnMessage: boolean;
  appriseEnabled: boolean;
  monitoredNodes: string | null;
  appriseUrlCount: number;
}

/**
 * #4020: `user_notification_preferences` is one row per (userId, sourceId). A
 * user's flag/monitored-nodes/channel-config can be split across several rows
 * (e.g. the flag was saved on the '' row before a source existed, then
 * monitored nodes were saved on a per-source row later). The repository now
 * returns ALL of a user's rows once ANY row has the flag set, and this
 * service merges them per §1 Rule A of the #4020 design: eligibility = any
 * row true, monitored nodes = union across rows.
 *
 * Split-row fix: https://github.com/Yeraze/meshmonitor/issues/4020
 *
 * #4412 Phase 2 WP4: restructured from one timer-per-restart-call (threshold/
 * interval/cooldown captured as instance fields at start() time) to a single
 * scheduler tick that resolves each registered source's own threshold/
 * interval/cooldown from `getInactiveNodeConfig()` on every pass. A
 * per-source `nextRunAt` map makes each source honour its own check
 * interval without needing a timer per source (timer-per-source was
 * explicitly rejected — lifecycle coupling + cleanup failure modes).
 */
class InactiveNodeNotificationService {
  private tickTimer: NodeJS.Timeout | null = null;
  private initialTimeout: NodeJS.Timeout | null = null;
  private running = false;
  /** sourceId -> epoch ms of next eligible run for that source. */
  private nextRunAt: Map<string, number> = new Map();
  private lastNotifiedNodes: Map<string, number> = new Map(); // "userId:sourceId:nodeId" -> last notification timestamp
  // Diagnostics: at most once per key per hour — see HourlyLogLimiter/#4020.
  private readonly hourlyLog = new HourlyLogLimiter();

  private static readonly TICK_INTERVAL_MS = 60_000; // 1 min == the minimum legal check interval
  private static readonly INITIAL_DELAY_MS = 60_000; // preserves the historical 1-min warm-up

  /**
   * Start the single scheduler tick. Threshold/interval/cooldown are no
   * longer instance state — each tick resolves them per source via
   * `getInactiveNodeConfig()`.
   */
  public start(): void {
    if (this.running) {
      logger.warn('⚠️  Inactive node notification service is already running');
      return;
    }

    this.running = true;
    logger.info('🔔 Starting inactive node notification service (per-source config, resolved per tick)');

    // Run an initial check after a short warm-up delay, then install the
    // recurring tick timer. Only one `setInterval` exists regardless of how
    // many sources are registered — due-ness is resolved per source inside
    // each tick via `nextRunAt`.
    this.initialTimeout = setTimeout(() => {
      this.initialTimeout = null;
      void this.tick();
      this.tickTimer = setInterval(() => {
        void this.tick();
      }, InactiveNodeNotificationService.TICK_INTERVAL_MS);
    }, InactiveNodeNotificationService.INITIAL_DELAY_MS);
  }

  /**
   * Stop the inactive node monitoring service
   */
  public stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }

    if (this.initialTimeout) {
      clearTimeout(this.initialTimeout);
      this.initialTimeout = null;
    }

    this.running = false;
    // A restart is a clean slate — every source becomes immediately due again.
    this.nextRunAt.clear();

    logger.info('⏹️  Inactive node notification service stopped');
  }

  /**
   * Force a source (or all sources, when null/omitted) to re-read its config
   * and run on the next tick. Does not tear down or recreate any timer, so a
   * reschedule can never leak or double-schedule one — the failure mode the
   * old stop()+start() restart pair had.
   */
  public reschedule(sourceId?: string | null): void {
    if (sourceId) {
      this.nextRunAt.delete(sourceId);
      logger.debug(`🔔 Inactive-node check rescheduled for source ${sourceId}`);
    } else {
      this.nextRunAt.clear();
      logger.debug('🔔 Inactive-node check rescheduled for all sources');
    }
  }

  /**
   * One scheduler pass. Ordering is load-bearing:
   *  1. Resolve registered managers; prune `nextRunAt` of any id no longer
   *     registered (unbounded-map discipline, same class as PR #4413's
   *     geofenceState/autoAckCooldowns bound).
   *  2. Compute due-ness BEFORE the users query, and bail out before it when
   *     nothing is due — otherwise the 60s tick would turn the (typically
   *     hourly) getUsersWithInactiveNodeNotifications() query into a
   *     per-minute query regardless of any source's configured interval.
   *  3. Per due source, set `nextRunAt` BEFORE doing the work, so a throw
   *     mid-source can't hot-loop that source every 60s.
   */
  private async tick(): Promise<void> {
    try {
      const managers = sourceManagerRegistry.getAllManagers();

      const activeIds = new Set(managers.map((m) => m.sourceId));
      for (const id of this.nextRunAt.keys()) {
        if (!activeIds.has(id)) this.nextRunAt.delete(id);
      }

      if (managers.length === 0) {
        logger.debug('No source managers registered — skipping inactive node check');
        return;
      }

      const now = Date.now();

      const due = managers.filter((m) => (this.nextRunAt.get(m.sourceId) ?? 0) <= now);
      if (due.length === 0) return;

      // Get all preference rows for users who have inactive-node notifications
      // enabled on at least one (userId, sourceId) row (#4020 — see class doc).
      const rows = await databaseService.notifications.getUsersWithInactiveNodeNotifications();

      if (rows.length === 0) {
        this.hourlyLog.log('no-users', 'info', '✅ No users have inactive node notifications enabled');
        await this.logZeroEligibleDiagnostic();
        // Nothing was actually checked — do not advance nextRunAt for the due
        // sources, so they remain due (and get retried) on the next tick.
        return;
      }

      // Group rows by userId (rows already ordered userId, sourceId ASC by the repository)
      const rowsByUser = new Map<number, InactiveNodePrefRow[]>();
      for (const row of rows) {
        const list = rowsByUser.get(row.userId);
        if (list) {
          list.push(row);
        } else {
          rowsByUser.set(row.userId, [row]);
        }
      }

      // Rule A: monitored-node union across all of a user's rows (dedup).
      // Computed once per tick, hoisted out of the (now outer) source loop.
      const monitoredUnionByUser = new Map<number, string[]>();
      for (const [userId, userRows] of rowsByUser.entries()) {
        monitoredUnionByUser.set(userId, parseMonitoredUnion(userId, userRows));
      }

      logger.debug(
        `🔍 Checking inactive nodes for ${rowsByUser.size} user(s) (${rows.length} preference row(s)) across ${due.length} due source(s)`
      );

      // Source-outer / user-inner: per-source due-ness (checked above) forces
      // this inversion from the historical user-outer / source-inner loop.
      for (const manager of due) {
        const sourceId = manager.sourceId;
        try {
          const cfg = await getInactiveNodeConfig(databaseService.settings, sourceId);
          // Set BEFORE doing any work for this source — a throw below must
          // not cause this source to be retried every 60s.
          this.nextRunAt.set(sourceId, now + cfg.checkIntervalMinutes * 60_000);

          let sourceName: string = sourceId;
          try {
            const source = await databaseService.sources.getSource(sourceId);
            if (source?.name) sourceName = source.name;
          } catch (err) {
            logger.debug(`Could not resolve source name for ${sourceId}:`, err);
          }

          const cutoffSeconds = Math.floor(now / 1000) - cfg.thresholdHours * 60 * 60;
          const cooldownMs = cfg.cooldownHours * 60 * 60 * 1000;

          for (const [userId, userRows] of rowsByUser.entries()) {
            const monitoredUnion = monitoredUnionByUser.get(userId) ?? [];
            if (monitoredUnion.length === 0) {
              this.hourlyLog.log(
                `empty-monitored:${userId}`,
                'info',
                `⚠️ [inactive-node] user=${userId} has no monitored nodes across any row — skipping. rows: ${this.formatRowsSummary(userRows)}`
              );
              continue;
            }

            // Permission check — skip user if they lack nodes:read on this source
            try {
              const allowed = await databaseService.checkPermissionAsync(userId, 'nodes', 'read', sourceId);
              if (!allowed) {
                this.hourlyLog.log(
                  `perm:${userId}:${sourceId}`,
                  'info',
                  `🔒 [inactive-node] user=${userId} lacks nodes:read on source ${sourceId} — skipping`
                );
                continue;
              }
            } catch (err) {
              logger.error(`Permission check failed for user ${userId} on source ${sourceId}:`, err);
              continue;
            }

            // MeshCore nodes live in a separate table and report lastHeard in
            // milliseconds; Meshtastic nodes report seconds. Collect a
            // protocol-appropriate, already-formatted list of inactive alerts.
            const alerts = manager.sourceType === 'meshcore'
              ? await this.collectMeshCoreInactiveAlerts(monitoredUnion, sourceId, cfg.thresholdHours, now)
              : await this.collectMeshtasticInactiveAlerts(monitoredUnion, sourceId, cutoffSeconds, now);

            if (alerts.length === 0) continue;

            logger.debug(`🔍 Found ${alerts.length} inactive monitored node(s) for user ${userId} on source ${sourceId}`);

            for (const alert of alerts) {
              // Source-scoped cooldown key prevents collisions across sources
              const notificationKey = `${userId}:${sourceId}:${alert.nodeId}`;
              const lastNotification = this.lastNotifiedNodes.get(notificationKey);

              if (lastNotification && now - lastNotification < cooldownMs) {
                logger.debug(
                  `⏭️  Skipping notification for user ${userId}, node ${alert.nodeId} on ${sourceId} (already notified recently)`
                );
                continue;
              }

              await this.sendInactiveNodeNotification(userId, { ...alert, sourceId, sourceName });

              this.lastNotifiedNodes.set(notificationKey, now);
            }
          }
        } catch (error) {
          // One bad source must not abort the tick for the others.
          logger.error(`❌ Error checking inactive nodes for source ${sourceId}:`, error);
        }
      }

      // Clean up old entries from lastNotifiedNodes map (keep only last 7 days)
      const cleanupCutoff = now - 7 * 24 * 60 * 60 * 1000;
      for (const [key, timestamp] of this.lastNotifiedNodes.entries()) {
        if (timestamp < cleanupCutoff) {
          this.lastNotifiedNodes.delete(key);
        }
      }
      this.hourlyLog.prune();
    } catch (error) {
      logger.error('❌ Error checking inactive nodes:', error);
    }
  }

  /**
   * Compact, count-only summary of a user's preference rows for diagnostics.
   * Never includes URL contents or node identifiers — only booleans/counts.
   */
  private formatRowsSummary(rows: InactiveNodePrefRow[]): string {
    return rows
      .map((r) => {
        const src = formatSourceIdForLog(r.sourceId);
        const monitoredCount = countMonitoredNodes(r.monitoredNodes);
        return `[src=${src} inactive=${r.notifyOnInactiveNode ? '✓' : '✗'} webPush=${r.notifyOnMessage ? '✓' : '✗'} apprise=${r.appriseEnabled ? '✓' : '✗'} monitored=${monitoredCount} urls=${r.appriseUrlCount}]`;
      })
      .join(' ');
  }

  /**
   * When no users are currently eligible, dump every known user's full row
   * set (counts only) so an operator can see WHY — e.g. the flag is on one
   * row but the channel/URLs are on another (the exact #4020 failure mode).
   */
  private async logZeroEligibleDiagnostic(): Promise<void> {
    await logZeroEligiblePrefRows(this.hourlyLog, '⚠️ [inactive-node]', (sourceId, prefs) => {
      const src = formatSourceIdForLog(sourceId);
      return `[src=${src} inactive=${prefs.notifyOnInactiveNode ? '✓' : '✗'} webPush=${prefs.enableWebPush ? '✓' : '✗'} apprise=${prefs.enableApprise ? '✓' : '✗'} monitored=${prefs.monitoredNodes.length} urls=${prefs.appriseUrls.length}]`;
    });
  }

  /**
   * Collect inactive-node alerts for a Meshtastic source. The Meshtastic
   * `nodes.lastHeard` column is in seconds, so the cutoff is a unix-seconds
   * value and inactiveHours is derived from `lastHeard * 1000`.
   */
  private async collectMeshtasticInactiveAlerts(
    monitoredNodeIds: string[],
    sourceId: string,
    cutoffSeconds: number,
    now: number
  ): Promise<Array<Omit<InactiveNodeCheck, 'sourceId' | 'sourceName'>>> {
    const inactiveNodes = await databaseService.nodes.getInactiveMonitoredNodes(
      monitoredNodeIds,
      cutoffSeconds,
      sourceId
    );

    const alerts: Array<Omit<InactiveNodeCheck, 'sourceId' | 'sourceName'>> = [];
    for (const node of inactiveNodes) {
      if (node.lastHeard == null) continue;
      const lastHeardMs = node.lastHeard * 1000;
      alerts.push({
        nodeId: node.nodeId,
        nodeNum: node.nodeNum,
        longName: node.longName || node.shortName || `Node ${node.nodeNum}`,
        shortName: node.shortName || '????',
        lastHeard: node.lastHeard,
        inactiveHours: Math.floor((now - lastHeardMs) / (60 * 60 * 1000)),
      });
    }
    return alerts;
  }

  /**
   * Collect inactive-node alerts for a MeshCore source. MeshCore stores nodes
   * in a separate table keyed by public key and records `lastHeard` in
   * milliseconds, so the cutoff is a millisecond value and inactiveHours is
   * derived directly from `lastHeard`. Monitored-node ids for MeshCore use the
   * `mc:<sourceId>:<pubkey12>` form emitted by GET /api/nodes, so we
   * reconstruct that id from each node's public key and only alert on nodes the
   * user actually monitors.
   */
  private async collectMeshCoreInactiveAlerts(
    monitoredNodeIds: string[],
    sourceId: string,
    thresholdHours: number,
    now: number
  ): Promise<Array<Omit<InactiveNodeCheck, 'sourceId' | 'sourceName'>>> {
    const cutoffMs = now - thresholdHours * 60 * 60 * 1000;
    const monitoredSet = new Set(monitoredNodeIds);
    const inactiveNodes = await databaseService.meshcore.getInactiveMeshcoreNodes(sourceId, cutoffMs);

    const alerts: Array<Omit<InactiveNodeCheck, 'sourceId' | 'sourceName'>> = [];
    for (const node of inactiveNodes) {
      if (node.lastHeard == null) continue;
      const pubKey = node.publicKey || '';
      const nodeId = `mc:${sourceId}:${pubKey.substring(0, 12)}`;
      if (!monitoredSet.has(nodeId)) continue;
      alerts.push({
        nodeId,
        nodeNum: 0,
        longName: node.name || nodeId,
        shortName: (node.name || '????').substring(0, 4),
        lastHeard: node.lastHeard,
        // MeshCore lastHeard is already in milliseconds.
        inactiveHours: Math.floor((now - node.lastHeard) / (60 * 60 * 1000)),
      });
    }
    return alerts;
  }

  /**
   * Send notification for an inactive node to a specific user
   */
  private async sendInactiveNodeNotification(userId: number, node: InactiveNodeCheck): Promise<void> {
    try {
      const hoursText = node.inactiveHours === 1 ? 'hour' : 'hours';
      const payload = {
        title: `[${node.sourceName}] ⚠️ Node Inactive: ${node.longName}`,
        body: `[${node.sourceName}] ${node.shortName} (${node.nodeId}) has been inactive for ${node.inactiveHours} ${hoursText}`,
        type: 'warning' as const,
        sourceId: node.sourceId,
        sourceName: node.sourceName,
      };

      // Send to this specific user (they have the preference enabled and node is in their list)
      const result = await notificationService.broadcastToPreferenceUsers('notifyOnInactiveNode', payload, userId);

      logger.info(
        `📤 Inactive node notification for user ${userId} node ${node.nodeId} (${node.inactiveHours} hours inactive): sent=${result.sent} filtered=${result.filtered}`
      );

      if (result.sent === 0) {
        // notificationService.broadcastToPreferenceUsers returns a flat
        // aggregate (sent/failed/filtered) across push+apprise+desktop, not a
        // per-service breakdown, so this WARN reports the aggregate counts
        // rather than a push-vs-apprise split.
        this.hourlyLog.log(
          `zero-delivery:${userId}:${node.sourceId}`,
          'warn',
          `⚠️ inactive-node alert for user ${userId} node ${node.nodeId} matched but 0 notifications delivered ` +
          `(filtered=${result.filtered}, failed=${result.failed}) — no usable delivery channel on any prefs row`
        );
      }
    } catch (error) {
      logger.error(`❌ Error sending inactive node notification to user ${userId} for ${node.nodeId}:`, error);
    }
  }

  /**
   * Get service status. `running` is explicit instance state (set in start(),
   * cleared in stop()) rather than derived from the interval handle — the
   * warm-up delay means `tickTimer` doesn't exist until t+60s, so deriving
   * `running` from it would incorrectly report `false` during that window.
   */
  public getStatus(): { running: boolean } {
    return {
      running: this.running,
    };
  }
}

export const inactiveNodeNotificationService = new InactiveNodeNotificationService();
