/**
 * Auto-announce scheduler + send (#3962 Phase 4.2a PR3 §4b).
 *
 * Extracted from MeshtasticManager: arming the cron/interval scheduler for
 * periodic "I'm online" announcements (`startAnnounceScheduler` /
 * `setAnnounceInterval` / `restartAnnounceScheduler`), the actual send
 * (`sendAutoAnnouncement`), and the preview wrapper
 * (`previewAnnouncementMessage`).
 *
 * `replaceAnnouncementTokens` deliberately stays on `MeshtasticManager` —
 * spec §4b hazard: it is shared with `replaceAcknowledgementTokens`,
 * `replaceWelcomeTokens`, `replaceGeofenceTokens`, and the auto-responder's
 * `executeTimerTextMessage` token path. Moving it into an announce-only
 * module would break those other three callers. This service reaches back
 * into the manager for token expansion via the injected `mgr` reference
 * (`mgr.replaceAnnouncementTokens`) instead — the method's visibility was
 * widened from `private` to (default) `public` on the manager solely to
 * make that cross-class call legal; its body and location are unmoved.
 *
 * Import-cycle discipline (task42a_spec.md §3): constructor-injected
 * `import type` reference to MeshtasticManager, never a static value import.
 * A few pieces of manager state needed here (`isConnected`,
 * `rebootMergeInProgress`) are `private` on MeshtasticManager; narrow public
 * accessors bridge them (`isDeviceConnected()` already existed from PR2;
 * `isRebootMergeInProgress()` was added alongside this service) rather than
 * widening the fields themselves — same pattern as
 * `nodeDbMaintenanceService.ts`.
 */
import type { MeshtasticManager } from '../meshtasticManager.js';
import databaseService from '../../services/database.js';
import { CronOrIntervalScheduler, type ScheduleMode } from './cronOrIntervalScheduler.js';
import { logger } from '../../utils/logger.js';

export class AutoAnnounceService {
  private announceScheduler: CronOrIntervalScheduler | null = null;

  constructor(private readonly mgr: MeshtasticManager) {}

  /** `true` while a cron job or interval timer is armed. */
  get running(): boolean {
    return this.announceScheduler !== null;
  }

  async startAnnounceScheduler(): Promise<void> {
    const sourceId = this.mgr.sourceId;

    // Clear any existing scheduler
    this.announceScheduler?.stop();
    this.announceScheduler = null;

    // Check if auto-announce is enabled
    const autoAnnounceEnabled = await databaseService.settings.getSettingForSource(sourceId, 'autoAnnounceEnabled');
    if (autoAnnounceEnabled !== 'true') {
      logger.debug('📢 Auto-announce is disabled');
      return;
    }

    // Determine schedule mode (cron vs interval — per-source, written by
    // AutoAnnounceSection via /api/settings?sourceId=)
    const useSchedule = (await databaseService.settings.getSettingForSource(sourceId, 'autoAnnounceUseSchedule')) === 'true';

    let mode: ScheduleMode;
    if (useSchedule) {
      const scheduleExpression = (await databaseService.settings.getSettingForSource(sourceId, 'autoAnnounceSchedule')) || '0 */6 * * *';
      logger.debug(`📢 Starting announce scheduler with cron expression: ${scheduleExpression}`);
      mode = { kind: 'cron', expression: scheduleExpression };
    } else {
      const intervalHours = parseInt((await databaseService.settings.getSettingForSource(sourceId, 'autoAnnounceIntervalHours')) || '6');
      const intervalMs = intervalHours * 60 * 60 * 1000;
      logger.debug(`📢 Starting announce scheduler with ${intervalHours} hour interval`);
      mode = { kind: 'interval', intervalMs };
    }

    this.announceScheduler = new CronOrIntervalScheduler({
      label: `Meshtastic:${sourceId}`,
      mode,
      onTick: () => {
        logger.debug(`📢 Announce tick triggered (connected: ${this.mgr.isDeviceConnected()})`);
        if (this.mgr.isDeviceConnected()) {
          return this.sendAutoAnnouncement(true).catch((error: Error) => {
            logger.error('❌ Error in auto-announce:', error);
          });
        }
        logger.debug('📢 Skipping announcement - not connected to node');
      },
    });

    if (!this.announceScheduler.start()) {
      // cron expression was invalid; warning already logged by the scheduler
      if (mode.kind === 'cron') {
        logger.error(`❌ Invalid cron expression: ${mode.expression}`);
      }
      this.announceScheduler = null;
      return;
    }

    logger.debug('📢 Announce scheduler started');

    // Check if announce-on-start is enabled (per-source; applies to both cron and interval modes)
    const announceOnStart = await databaseService.settings.getSettingForSource(sourceId, 'autoAnnounceOnStart');
    if (announceOnStart === 'true') {
      // Check spam protection: don't send if announced within last hour
      const lastAnnouncementTime = await databaseService.settings.getSettingForSource(sourceId, 'lastAnnouncementTime');
      const now = Date.now();
      const oneHour = 60 * 60 * 1000;

      if (lastAnnouncementTime) {
        const timeSinceLastAnnouncement = now - parseInt(lastAnnouncementTime);
        if (timeSinceLastAnnouncement < oneHour) {
          const minutesRemaining = Math.ceil((oneHour - timeSinceLastAnnouncement) / 60000);
          logger.debug(`📢 Skipping startup announcement - last announcement was ${Math.floor(timeSinceLastAnnouncement / 60000)} minutes ago (spam protection: ${minutesRemaining} minutes remaining)`);
        } else {
          logger.debug('📢 Sending startup announcement');
          // Delay startup announcement to allow reboot detection and ghost cleanup to complete
          setTimeout(async () => {
            if (this.mgr.isDeviceConnected()) {
              try {
                await this.sendAutoAnnouncement(true);
              } catch (error) {
                logger.error('❌ Error in startup announcement:', error);
              }
            }
          }, 30000);
        }
      } else {
        // No previous announcement, send one
        logger.debug('📢 Sending first startup announcement');
        // Delay startup announcement to allow reboot detection and ghost cleanup to complete
        setTimeout(async () => {
          if (this.mgr.isDeviceConnected()) {
            try {
              await this.sendAutoAnnouncement(true);
            } catch (error) {
              logger.error('❌ Error in startup announcement:', error);
            }
          }
        }, 30000);
      }
    }
  }

  setAnnounceInterval(hours: number): void {
    if (hours < 3 || hours > 24) {
      throw new Error('Announce interval must be between 3 and 24 hours');
    }

    logger.debug(`📢 Announce interval updated to ${hours} hours`);

    if (this.mgr.isDeviceConnected()) {
      this.startAnnounceScheduler().catch(err => logger.error('Error starting announce scheduler:', err));
    }
  }

  restartAnnounceScheduler(): void {
    logger.debug('📢 Restarting announce scheduler due to settings change');

    if (this.mgr.isDeviceConnected()) {
      this.startAnnounceScheduler().catch(err => logger.error('Error restarting announce scheduler:', err));
    }
  }

  /**
   * Disarm the scheduler, if armed. Idempotent — safe to call from both
   * `disconnect()` and `userDisconnect()`. `startAnnounceScheduler()`
   * re-arms on the next (re)connect via `handleConnected`.
   */
  stop(): void {
    if (this.announceScheduler) {
      this.announceScheduler.stop();
      this.announceScheduler = null;
      logger.debug('📢 Stopped announce scheduler');
    }
  }

  async sendAutoAnnouncement(triggeredByAutomation = false): Promise<void> {
    if (this.mgr.isRebootMergeInProgress()) {
      logger.debug('📢 Skipping auto-announcement - reboot merge in progress');
      return;
    }

    // Airtime cutoff: skip scheduled announcements while the mesh is congested.
    // Manual "Send Announcement" requests (triggeredByAutomation = false) are
    // always allowed through.
    if (triggeredByAutomation && await this.mgr.isAutomationAirtimeGated()) {
      return;
    }

    try {
      // All auto-announce settings are per-source (written by AutoAnnounceSection
      // via /api/settings?sourceId=).
      const settings = databaseService.settings;
      const sourceId = this.mgr.sourceId;

      const message = await settings.getSettingForSource(sourceId, 'autoAnnounceMessage') || 'MeshMonitor {VERSION} online for {DURATION} {FEATURES}';

      // Multi-channel support: read JSON array, fall back to legacy single index
      let channelIndexes: number[];
      const channelIndexesStr = await settings.getSettingForSource(sourceId, 'autoAnnounceChannelIndexes');
      if (channelIndexesStr) {
        try {
          const parsed = JSON.parse(channelIndexesStr);
          channelIndexes = Array.isArray(parsed) ? parsed.filter(n => typeof n === 'number') : [0];
        } catch {
          channelIndexes = [0];
        }
      } else {
        // Legacy migration: read old single channel setting (pre-4.0, global-only)
        const legacyIndex = parseInt(await settings.getSetting('autoAnnounceChannelIndex') || '0');
        channelIndexes = [legacyIndex];
      }

      if (channelIndexes.length === 0) {
        channelIndexes = [0];
      }

      // Replace tokens
      const replacedMessage = await this.mgr.replaceAnnouncementTokens(message);

      logger.debug(`📢 Sending auto-announcement to ${channelIndexes.length} channel(s) [${channelIndexes.join(',')}]: "${replacedMessage}"`);

      channelIndexes.forEach((channelIdx, i) => {
        this.mgr.messageQueue.enqueue(
          replacedMessage,
          0, // destination: 0 for channel broadcast
          undefined, // no reply-to for announcements
          () => {
            logger.debug(`✅ Auto-announcement ${i + 1}/${channelIndexes.length} delivered to channel ${channelIdx}`);
          },
          (reason: string) => {
            logger.warn(`❌ Auto-announcement ${i + 1}/${channelIndexes.length} failed on channel ${channelIdx}: ${reason}`);
          },
          channelIdx, // channel number
          1 // single attempt, no retry for broadcasts
        );
      });

      // Update last announcement time (per-source)
      if (sourceId) {
        await databaseService.settings.setSourceSetting(sourceId, 'lastAnnouncementTime', Date.now().toString());
      } else {
        await databaseService.settings.setSetting('lastAnnouncementTime', Date.now().toString());
      }
      logger.debug('📢 Last announcement time updated');

      // Check if NodeInfo broadcasting is enabled (per-source)
      const nodeInfoEnabled = await settings.getSettingForSource(sourceId, 'autoAnnounceNodeInfoEnabled') === 'true';
      if (nodeInfoEnabled) {
        try {
          const nodeInfoChannelsStr = await settings.getSettingForSource(sourceId, 'autoAnnounceNodeInfoChannels') || '[]';
          const nodeInfoChannels = JSON.parse(nodeInfoChannelsStr) as number[];
          const nodeInfoDelaySeconds = parseInt(await settings.getSettingForSource(sourceId, 'autoAnnounceNodeInfoDelaySeconds') || '30');

          if (nodeInfoChannels.length > 0) {
            logger.debug(`📢 NodeInfo broadcasting enabled - will broadcast to ${nodeInfoChannels.length} channel(s)`);
            // Run NodeInfo broadcasting asynchronously (don't block the announcement)
            this.mgr.broadcastNodeInfoToChannels(nodeInfoChannels, nodeInfoDelaySeconds).catch(error => {
              logger.error('❌ Error in NodeInfo broadcasting:', error);
            });
          }
        } catch (parseError) {
          logger.error('❌ Error parsing NodeInfo channels setting:', parseError);
        }
      }
    } catch (error) {
      logger.error('❌ Error sending auto-announcement:', error);
    }
  }

  /**
   * Public wrapper for `mgr.replaceAnnouncementTokens`, used by the preview
   * API endpoint (`GET /api/announce/preview`).
   */
  async previewAnnouncementMessage(message: string): Promise<string> {
    return this.mgr.replaceAnnouncementTokens(message);
  }
}
