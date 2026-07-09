import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { notificationService } from './notificationService.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { HourlyLogLimiter } from '../utils/hourlyLogLimiter.js';

interface LowBatteryNodeCheck {
  nodeId: string;
  nodeNum: number;
  longName: string;
  shortName: string;
  /** Human-readable current battery level, e.g. "15%" (Meshtastic) or "3100mV" (MeshCore). */
  valueLabel: string;
  /** Human-readable configured threshold, e.g. "20%" or "3300mV". */
  thresholdLabel: string;
  sourceId: string;
  sourceName: string;
}

/** One flagged (userId, sourceId) preferences row as returned by the repository. */
interface LowBatteryPrefRow {
  userId: number;
  sourceId: string;
  notifyOnLowBattery: boolean;
  notifyOnMessage: boolean;
  appriseEnabled: boolean;
  monitoredNodes: string | null;
  lowBatteryThreshold: number | null;
  lowBatteryVoltageThreshold: number | null;
  appriseUrlCount: number;
}

/**
 * Polls monitored nodes and notifies users when a node's battery drops below
 * their per-user threshold. Meshtastic nodes report a 0-100 percentage
 * (lowBatteryThreshold); MeshCore nodes report a voltage in millivolts
 * (lowBatteryVoltageThreshold), so the two protocols compare against different
 * per-user thresholds. The monitored-node list is shared with the inactive-node
 * feature (user_notification_preferences.monitored_nodes). Check interval and
 * cooldown are global admin settings, mirroring the inactive-node service.
 *
 * #4020: `user_notification_preferences` is one row per (userId, sourceId). A
 * user's flag/monitored-nodes/channel-config can be split across several rows
 * (e.g. the flag was saved on the '' row before a source existed, then
 * monitored nodes were saved on a per-source row later). The repository now
 * returns ALL of a user's rows once ANY row has the flag set, and this service
 * merges them per §1 Rule A of the #4020 design: eligibility = any row true,
 * monitored nodes = union across rows, threshold = exact-source row, else '',
 * else the first row.
 *
 * Implements: https://github.com/Yeraze/meshmonitor/issues/3305
 * MeshCore voltage support: https://github.com/Yeraze/meshmonitor/issues/3331
 * Split-row fix: https://github.com/Yeraze/meshmonitor/issues/4020
 */
class LowBatteryNotificationService {
  private checkInterval: NodeJS.Timeout | null = null;
  private initialCheckTimeout: NodeJS.Timeout | null = null;
  private lastNotifiedNodes: Map<string, number> = new Map(); // "userId:sourceId:nodeId" -> last notification timestamp
  private currentCooldownHours: number = 24;
  private readonly DEFAULT_CHECK_INTERVAL_MINUTES = 60; // Check every hour
  private readonly DEFAULT_THRESHOLD_PERCENT = 20; // Used when a user has no explicit threshold
  private readonly DEFAULT_VOLTAGE_THRESHOLD_MV = 3300; // MeshCore: alert below ~3.3V when no explicit threshold
  private readonly DEFAULT_NOTIFICATION_COOLDOWN_HOURS = 24; // Don't notify about same node more than once per 24 hours
  // Diagnostics: at most once per key per hour (not once-per-process — see #4020,
  // where a single-shot diagnostic was invisible for the lifetime of any
  // long-running deployment once it had already fired).
  private readonly hourlyLog = new HourlyLogLimiter();

  /**
   * Start the low-battery monitoring service
   */
  public start(
    checkIntervalMinutes: number = this.DEFAULT_CHECK_INTERVAL_MINUTES,
    cooldownHours: number = this.DEFAULT_NOTIFICATION_COOLDOWN_HOURS
  ): void {
    if (this.checkInterval) {
      logger.warn('⚠️  Low battery notification service is already running');
      return;
    }

    this.currentCooldownHours = cooldownHours;

    logger.info(
      `🔔 Starting low battery notification service (checking every ${checkIntervalMinutes} minutes, cooldown: ${cooldownHours} hours)`
    );

    // Run initial check after a short delay
    this.initialCheckTimeout = setTimeout(() => {
      void this.checkLowBatteryNodes();
      this.initialCheckTimeout = null;
    }, 60000); // Wait 1 minute before first check

    // Schedule periodic checks
    this.checkInterval = setInterval(() => {
      void this.checkLowBatteryNodes();
    }, checkIntervalMinutes * 60 * 1000);
  }

  /**
   * Stop the low-battery monitoring service
   */
  public stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    if (this.initialCheckTimeout) {
      clearTimeout(this.initialCheckTimeout);
      this.initialCheckTimeout = null;
    }

    if (this.checkInterval === null && this.initialCheckTimeout === null) {
      logger.info('⏹️  Low battery notification service stopped');
    }
  }

  /**
   * Check monitored nodes for low battery and send notifications.
   * Captures the cooldown value at the start so a mid-check restart can't skew it.
   */
  private async checkLowBatteryNodes(): Promise<void> {
    try {
      const cooldownHours = this.currentCooldownHours;
      const now = Date.now();

      // Get all preference rows for users who have low-battery notifications
      // enabled on at least one (userId, sourceId) row (#4020 — see class doc).
      const rows = await databaseService.notifications.getUsersWithLowBatteryNotifications();

      if (rows.length === 0) {
        this.hourlyLog.log('no-users', 'info', '✅ No users have low battery notifications enabled');
        await this.logZeroEligibleDiagnostic();
        return;
      }

      // All source types (meshtastic, MeshCore, MQTT) are now in the unified
      // sourceManagerRegistry, so a single getAllManagers() covers every source.
      const managers = sourceManagerRegistry.getAllManagers();
      if (managers.length === 0) {
        logger.debug('No source managers registered — skipping low battery check');
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
      const rowsByUser = new Map<number, LowBatteryPrefRow[]>();
      for (const row of rows) {
        const list = rowsByUser.get(row.userId);
        if (list) {
          list.push(row);
        } else {
          rowsByUser.set(row.userId, [row]);
        }
      }

      logger.debug(`🔍 Checking low battery for ${rowsByUser.size} user(s) (${rows.length} preference row(s))`);

      for (const [userId, userRows] of rowsByUser.entries()) {
        // Rule A: monitored-node union across all of this user's rows (dedup).
        const monitoredUnion = this.parseMonitoredUnion(userId, userRows);
        if (monitoredUnion.length === 0) {
          this.hourlyLog.log(
            `empty-monitored:${userId}`,
            'info',
            `🔋 [low-battery] user=${userId} has no monitored nodes across any row — skipping. rows: ${this.formatRowsSummary(userRows)}`
          );
          continue;
        }

        // Rule A: threshold precedence — exact-source row, then '' row, then first row.
        const rowsBySource = new Map<string, LowBatteryPrefRow>();
        for (const row of userRows) {
          if (!rowsBySource.has(row.sourceId)) rowsBySource.set(row.sourceId, row);
        }

        for (const manager of managers) {
          const sourceId = manager.sourceId;
          const sourceName = sourceNames.get(sourceId) ?? sourceId;

          // Permission check — skip user if they lack nodes:read on this source
          try {
            const allowed = await databaseService.checkPermissionAsync(userId, 'nodes', 'read', sourceId);
            if (!allowed) {
              this.hourlyLog.log(
                `perm:${userId}:${sourceId}`,
                'info',
                `🔒 [low-battery] user=${userId} lacks nodes:read on source ${sourceId} — skipping`
              );
              continue;
            }
          } catch (err) {
            logger.error(`Permission check failed for user ${userId} on source ${sourceId}:`, err);
            continue;
          }

          const thresholdRow = rowsBySource.get(sourceId) ?? rowsBySource.get('') ?? userRows[0];

          // MeshCore nodes report voltage (mV); Meshtastic nodes report a 0-100
          // percentage. Build a protocol-appropriate list of alerts with the
          // current value/threshold already formatted for display.
          const alerts = manager.sourceType === 'meshcore'
            ? await this.collectMeshCoreLowBatteryAlerts(thresholdRow, monitoredUnion, sourceId)
            : await this.collectMeshtasticLowBatteryAlerts(thresholdRow, monitoredUnion, sourceId);

          if (alerts.length === 0) continue;

          logger.debug(`🔍 Found ${alerts.length} low-battery monitored node(s) for user ${userId} on source ${sourceId}`);

          for (const alert of alerts) {
            // Source-scoped cooldown key prevents collisions across sources
            const notificationKey = `${userId}:${sourceId}:${alert.nodeId}`;
            const lastNotification = this.lastNotifiedNodes.get(notificationKey);
            const cooldownMs = cooldownHours * 60 * 60 * 1000;

            if (lastNotification && now - lastNotification < cooldownMs) {
              logger.debug(
                `⏭️  Skipping low battery notification for user ${userId}, node ${alert.nodeId} on ${sourceId} (already notified recently)`
              );
              continue;
            }

            await this.sendLowBatteryNotification(userId, { ...alert, sourceId, sourceName });

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
      logger.error('❌ Error checking low battery nodes:', error);
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
  private formatRowsSummary(rows: LowBatteryPrefRow[]): string {
    return rows
      .map((r) => {
        const src = r.sourceId === '' ? "''" : this.truncateSourceId(r.sourceId);
        const monitoredCount = this.countMonitored(r.monitoredNodes);
        const pct = r.lowBatteryThreshold ?? this.DEFAULT_THRESHOLD_PERCENT;
        const mv = r.lowBatteryVoltageThreshold ?? this.DEFAULT_VOLTAGE_THRESHOLD_MV;
        return `[src=${src} lowBatt=${r.notifyOnLowBattery ? '✓' : '✗'} webPush=${r.notifyOnMessage ? '✓' : '✗'} apprise=${r.appriseEnabled ? '✓' : '✗'} monitored=${monitoredCount} urls=${r.appriseUrlCount} pct=${pct} mv=${mv}]`;
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
          return `[src=${src} lowBatt=${prefs.notifyOnLowBattery ? '✓' : '✗'} webPush=${prefs.enableWebPush ? '✓' : '✗'} apprise=${prefs.enableApprise ? '✓' : '✗'} monitored=${prefs.monitoredNodes.length} urls=${prefs.appriseUrls.length} pct=${prefs.lowBatteryThreshold} mv=${prefs.lowBatteryVoltageThreshold}]`;
        })
        .join(' ');
      this.hourlyLog.log(`no-users:${userId}`, 'info', `🔋 [low-battery] user=${userId} rows: ${dump}`);
    }
  }

  /**
   * Collect low-battery alerts for a Meshtastic source, comparing each monitored
   * node's battery percentage against the user's percent threshold.
   */
  private async collectMeshtasticLowBatteryAlerts(
    thresholdRow: { lowBatteryThreshold: number | null },
    monitoredNodeIds: string[],
    sourceId: string
  ): Promise<Array<Omit<LowBatteryNodeCheck, 'sourceId' | 'sourceName'>>> {
    const threshold =
      thresholdRow.lowBatteryThreshold != null && thresholdRow.lowBatteryThreshold >= 0 && thresholdRow.lowBatteryThreshold <= 100
        ? thresholdRow.lowBatteryThreshold
        : this.DEFAULT_THRESHOLD_PERCENT;

    const lowBatteryNodes = await databaseService.nodes.getLowBatteryMonitoredNodes(
      monitoredNodeIds,
      threshold,
      sourceId
    );

    const alerts: Array<Omit<LowBatteryNodeCheck, 'sourceId' | 'sourceName'>> = [];
    for (const node of lowBatteryNodes) {
      if (node.batteryLevel == null) continue;
      alerts.push({
        nodeId: node.nodeId,
        nodeNum: node.nodeNum,
        longName: node.longName || node.shortName || `Node ${node.nodeNum}`,
        shortName: node.shortName || '????',
        valueLabel: `${node.batteryLevel}%`,
        thresholdLabel: `${threshold}%`,
      });
    }
    return alerts;
  }

  /**
   * Collect low-battery alerts for a MeshCore source. MeshCore nodes report
   * battery voltage (mV) instead of a percentage, so each monitored node's
   * batteryMv is compared against the user's voltage threshold. Monitored-node
   * ids for MeshCore use the `mc:<sourceId>:<pubkey12>` form emitted by
   * GET /api/nodes, so we reconstruct that id from each node's public key.
   */
  private async collectMeshCoreLowBatteryAlerts(
    thresholdRow: { lowBatteryVoltageThreshold: number | null },
    monitoredNodeIds: string[],
    sourceId: string
  ): Promise<Array<Omit<LowBatteryNodeCheck, 'sourceId' | 'sourceName'>>> {
    const voltageThreshold =
      thresholdRow.lowBatteryVoltageThreshold != null && thresholdRow.lowBatteryVoltageThreshold > 0
        ? thresholdRow.lowBatteryVoltageThreshold
        : this.DEFAULT_VOLTAGE_THRESHOLD_MV;

    const monitoredSet = new Set(monitoredNodeIds);
    const lowNodes = await databaseService.meshcore.getLowVoltageNodes(sourceId, voltageThreshold);

    const alerts: Array<Omit<LowBatteryNodeCheck, 'sourceId' | 'sourceName'>> = [];
    for (const node of lowNodes) {
      if (node.batteryMv == null) continue;
      const pubKey = node.publicKey || '';
      const nodeId = `mc:${sourceId}:${pubKey.substring(0, 12)}`;
      if (!monitoredSet.has(nodeId)) continue;
      alerts.push({
        nodeId,
        nodeNum: 0,
        longName: node.name || nodeId,
        shortName: (node.name || '????').substring(0, 4),
        valueLabel: `${node.batteryMv}mV`,
        thresholdLabel: `${voltageThreshold}mV`,
      });
    }

    const meshCoreMonitoredCount = monitoredNodeIds.filter(id => id.startsWith(`mc:${sourceId}:`)).length;
    this.hourlyLog.log(
      `meshcore-diag:${sourceId}`,
      'info',
      `🔋 [MeshCore low-battery] source=${sourceId}: threshold=${voltageThreshold}mV, ${meshCoreMonitoredCount} monitored node id(s) for this source, ` +
      `${lowNodes.length} node(s) in meshcore_nodes currently below threshold, ${alerts.length} matched a monitored id (0 here usually means batteryMv was never persisted — check the MeshCorePoller logs)`
    );
    return alerts;
  }

  /**
   * Send a low-battery notification for a node to a specific user
   */
  private async sendLowBatteryNotification(userId: number, node: LowBatteryNodeCheck): Promise<void> {
    try {
      const payload = {
        title: `[${node.sourceName}] 🔋 Low Battery: ${node.longName}`,
        body: `[${node.sourceName}] ${node.shortName} (${node.nodeId}) battery at ${node.valueLabel} (threshold: ${node.thresholdLabel})`,
        type: 'warning' as const,
        sourceId: node.sourceId,
        sourceName: node.sourceName,
      };

      const result = await notificationService.broadcastToPreferenceUsers('notifyOnLowBattery', payload, userId);

      logger.info(
        `📤 Low battery notification for user ${userId} node ${node.nodeId} (${node.valueLabel} battery): sent=${result.sent} filtered=${result.filtered}`
      );

      if (result.sent === 0) {
        // notificationService.broadcastToPreferenceUsers returns a flat
        // aggregate (sent/failed/filtered) across push+apprise+desktop, not a
        // per-service breakdown, so this WARN reports the aggregate counts
        // rather than a push-vs-apprise split.
        this.hourlyLog.log(
          `zero-delivery:${userId}:${node.sourceId}`,
          'warn',
          `⚠️ low-battery alert for user ${userId} node ${node.nodeId} matched but 0 notifications delivered ` +
          `(filtered=${result.filtered}, failed=${result.failed}) — no usable delivery channel on any prefs row`
        );
      }
    } catch (error) {
      logger.error(`❌ Error sending low battery notification to user ${userId} for ${node.nodeId}:`, error);
    }
  }

  /**
   * Get service status
   */
  public getStatus(): { running: boolean } {
    return {
      running: this.checkInterval !== null,
    };
  }
}

export const lowBatteryNotificationService = new LowBatteryNotificationService();
