import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { notificationService } from './notificationService.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { HourlyLogLimiter } from '../utils/hourlyLogLimiter.js';

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
 */
class InactiveNodeNotificationService {
  private checkInterval: NodeJS.Timeout | null = null;
  private initialCheckTimeout: NodeJS.Timeout | null = null;
  private lastNotifiedNodes: Map<string, number> = new Map(); // "userId:sourceId:nodeId" -> last notification timestamp
  private currentThresholdHours: number = 24;
  private currentCooldownHours: number = 24;
  private readonly DEFAULT_CHECK_INTERVAL_MINUTES = 60; // Check every hour
  private readonly DEFAULT_INACTIVE_THRESHOLD_HOURS = 24; // 24 hours of inactivity
  private readonly DEFAULT_NOTIFICATION_COOLDOWN_HOURS = 24; // Don't notify about same node more than once per 24 hours
  // Diagnostics: at most once per key per hour — see HourlyLogLimiter/#4020.
  private readonly hourlyLog = new HourlyLogLimiter();

  /**
   * Start the inactive node monitoring service
   */
  public start(
    inactiveThresholdHours: number = this.DEFAULT_INACTIVE_THRESHOLD_HOURS,
    checkIntervalMinutes: number = this.DEFAULT_CHECK_INTERVAL_MINUTES,
    cooldownHours: number = this.DEFAULT_NOTIFICATION_COOLDOWN_HOURS
  ): void {
    if (this.checkInterval) {
      logger.warn('⚠️  Inactive node notification service is already running');
      return;
    }

    this.currentThresholdHours = inactiveThresholdHours;
    this.currentCooldownHours = cooldownHours;

    logger.info(
      `🔔 Starting inactive node notification service (checking every ${checkIntervalMinutes} minutes, threshold: ${inactiveThresholdHours} hours, cooldown: ${cooldownHours} hours)`
    );

    // Run initial check after a short delay
    // Capture parameters in closure to ensure correct values are used even if service is restarted
    this.initialCheckTimeout = setTimeout(() => {
      void this.checkInactiveNodes();
      this.initialCheckTimeout = null; // Clear reference after execution
    }, 60000); // Wait 1 minute before first check

    // Schedule periodic checks
    this.checkInterval = setInterval(() => {
      void this.checkInactiveNodes();
    }, checkIntervalMinutes * 60 * 1000);
  }

  /**
   * Stop the inactive node monitoring service
   */
  public stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    // Clear the initial check timeout if it hasn't fired yet
    if (this.initialCheckTimeout) {
      clearTimeout(this.initialCheckTimeout);
      this.initialCheckTimeout = null;
    }

    if (this.checkInterval === null && this.initialCheckTimeout === null) {
      logger.info('⏹️  Inactive node notification service stopped');
    }
  }

  /**
   * Check for inactive nodes and send notifications
   * Only checks nodes that are in each user's monitored list
   * Captures current parameter values at the start to ensure consistency throughout the check,
   * even if the service is restarted with new parameters while this check is running.
   */
  private async checkInactiveNodes(): Promise<void> {
    try {
      // Capture current parameter values at the start of the check to ensure consistency
      // throughout the entire check cycle, even if the service is restarted mid-check
      const thresholdHours = this.currentThresholdHours;
      const cooldownHours = this.currentCooldownHours;

      const now = Date.now();
      const cutoffSeconds = Math.floor(now / 1000) - thresholdHours * 60 * 60;

      // Get all preference rows for users who have inactive-node notifications
      // enabled on at least one (userId, sourceId) row (#4020 — see class doc).
      const rows = await databaseService.notifications.getUsersWithInactiveNodeNotifications();

      if (rows.length === 0) {
        this.hourlyLog.log('no-users', 'info', '✅ No users have inactive node notifications enabled');
        await this.logZeroEligibleDiagnostic();
        return;
      }

      // Phase C: iterate every active source and run the inactivity check per source.
      // All source types (meshtastic, MeshCore, MQTT) are now in the unified
      // sourceManagerRegistry, so a single getAllManagers() covers every source.
      const managers = sourceManagerRegistry.getAllManagers();
      if (managers.length === 0) {
        logger.debug('No source managers registered — skipping inactive node check');
        return;
      }

      // Resolve sourceName once per source per scan
      const sourceNames = new Map<string, string>();
      for (const manager of managers) {
        let sourceName: string = manager.sourceId;
        try {
          const source = await databaseService.sources.getSource(manager.sourceId);
          if (source?.name) sourceName = source.name;
        } catch (err) {
          logger.debug(`Could not resolve source name for ${manager.sourceId}:`, err);
        }
        sourceNames.set(manager.sourceId, sourceName);
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

      logger.debug(`🔍 Checking inactive nodes for ${rowsByUser.size} user(s) (${rows.length} preference row(s))`);

      for (const [userId, userRows] of rowsByUser.entries()) {
        // Rule A: monitored-node union across all of this user's rows (dedup).
        const monitoredUnion = this.parseMonitoredUnion(userId, userRows);
        if (monitoredUnion.length === 0) {
          this.hourlyLog.log(
            `empty-monitored:${userId}`,
            'info',
            `⚠️ [inactive-node] user=${userId} has no monitored nodes across any row — skipping. rows: ${this.formatRowsSummary(userRows)}`
          );
          continue;
        }

        // Process each source for this user (scoped to this source)
        for (const manager of managers) {
          const sourceId = manager.sourceId;
          const sourceName = sourceNames.get(sourceId) ?? sourceId;

          // Phase C: permission check — skip user if they lack nodes:read on this source
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
            ? await this.collectMeshCoreInactiveAlerts(monitoredUnion, sourceId, thresholdHours, now)
            : await this.collectMeshtasticInactiveAlerts(monitoredUnion, sourceId, cutoffSeconds, now);

          if (alerts.length === 0) continue;

          logger.debug(`🔍 Found ${alerts.length} inactive monitored node(s) for user ${userId} on source ${sourceId}`);

          for (const alert of alerts) {
            // Source-scoped cooldown key prevents collisions across sources
            const notificationKey = `${userId}:${sourceId}:${alert.nodeId}`;
            const lastNotification = this.lastNotifiedNodes.get(notificationKey);
            const cooldownMs = cooldownHours * 60 * 60 * 1000;

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
   * Parse and dedup-union the monitoredNodes JSON across all of a user's
   * preference rows. A malformed row is logged and contributes nothing
   * (rather than aborting the whole union), matching the per-row parse
   * failure handling this replaces.
   */
  private parseMonitoredUnion(userId: number, rows: Array<{ sourceId: string; monitoredNodes: string | null }>): string[] {
    const union = new Set<string>();
    for (const row of rows) {
      if (!row.monitoredNodes) continue;
      try {
        const parsed = JSON.parse(row.monitoredNodes);
        if (Array.isArray(parsed)) {
          for (const id of parsed) union.add(id);
        }
      } catch (error) {
        logger.warn(`Failed to parse monitored_nodes for user ${userId} (source ${row.sourceId || "''"}):`, error);
      }
    }
    return Array.from(union);
  }

  /**
   * Compact, count-only summary of a user's preference rows for diagnostics.
   * Never includes URL contents or node identifiers — only booleans/counts.
   */
  private formatRowsSummary(rows: InactiveNodePrefRow[]): string {
    return rows
      .map((r) => {
        const src = r.sourceId === '' ? "''" : this.truncateSourceId(r.sourceId);
        const monitoredCount = this.countMonitored(r.monitoredNodes);
        return `[src=${src} inactive=${r.notifyOnInactiveNode ? '✓' : '✗'} webPush=${r.notifyOnMessage ? '✓' : '✗'} apprise=${r.appriseEnabled ? '✓' : '✗'} monitored=${monitoredCount} urls=${r.appriseUrlCount}]`;
      })
      .join(' ');
  }

  private countMonitored(monitoredNodes: string | null): number {
    if (!monitoredNodes) return 0;
    try {
      const parsed = JSON.parse(monitoredNodes);
      return Array.isArray(parsed) ? parsed.length : 0;
    } catch {
      return 0;
    }
  }

  private truncateSourceId(sourceId: string): string {
    return sourceId.length > 8 ? `${sourceId.substring(0, 8)}…` : sourceId;
  }

  /**
   * When no users are currently eligible, dump every known user's full row
   * set (counts only) so an operator can see WHY — e.g. the flag is on one
   * row but the channel/URLs are on another (the exact #4020 failure mode).
   */
  private async logZeroEligibleDiagnostic(): Promise<void> {
    const userIds = await databaseService.notifications.getAllPreferenceUserIds();
    for (const userId of userIds) {
      const rows = await databaseService.notifications.getUserPreferenceRows(userId);
      if (rows.length === 0) continue;
      const dump = rows
        .map(({ sourceId, prefs }) => {
          const src = sourceId === '' ? "''" : this.truncateSourceId(sourceId);
          return `[src=${src} inactive=${prefs.notifyOnInactiveNode ? '✓' : '✗'} webPush=${prefs.enableWebPush ? '✓' : '✗'} apprise=${prefs.enableApprise ? '✓' : '✗'} monitored=${prefs.monitoredNodes.length} urls=${prefs.appriseUrls.length}]`;
        })
        .join(' ');
      this.hourlyLog.log(`no-users:${userId}`, 'info', `⚠️ [inactive-node] user=${userId} rows: ${dump}`);
    }
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
   * Get service status
   */
  public getStatus(): { running: boolean; lastCheck?: number } {
    return {
      running: this.checkInterval !== null,
    };
  }
}

export const inactiveNodeNotificationService = new InactiveNodeNotificationService();
