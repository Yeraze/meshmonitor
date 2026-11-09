/**
 * Backup Scheduler Service
 * Handles automated backup scheduling and execution for both device and system backups
 */

import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { backupFileService } from './backupFileService.js';
import { systemBackupService } from './systemBackupService.js';
import { deviceConfigBackupService, isBackupBusy, type BackupTarget } from './deviceConfigBackupService.js';
import type { BackupProtocol } from './backupAdapters/index.js';
import type { ISourceManager } from '../sourceManagerRegistry.js';

/** The slice of the source registry the scheduler needs. */
export interface BackupSchedulerRegistry {
  getManager(sourceId: string): ISourceManager | undefined;
}

export interface BackupScheduleSettings {
  enabled: boolean;
  maxBackups: number;
  backupTime: string;
}

const key = (sourceId: string, name: string): string => `source:${sourceId}:${name}`;

/** Local `YYYY-MM-DD` (the scheduler matches a LOCAL HH:MM, so the day guard is local too). */
export function localDateString(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

const hhmm = (d: Date): string => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

class BackupSchedulerService {
  private schedulerInterval: NodeJS.Timeout | null = null;
  private isRunning = false;
  private isDeviceBackupInProgress = false;
  private isSystemBackupInProgress = false;
  private registry: BackupSchedulerRegistry | null = null;

  /**
   * Initialize the backup scheduler. The registry is read fresh on every
   * pass, so a source added or removed later is picked up.
   */
  initialize(registry: BackupSchedulerRegistry): void {
    this.registry = registry;

    // Initialize backup directories
    backupFileService.initializeBackupDirectory();
    systemBackupService.initializeBackupDirectory();

    // Start the scheduler
    this.start();

    logger.info('Backup scheduler initialized (per-source device backups + system backups)');
  }

  /**
   * Start the backup scheduler
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('⚠️  Backup scheduler is already running');
      return;
    }

    this.isRunning = true;

    // Check every minute if it's time to run a backup
    this.schedulerInterval = setInterval(() => {
      this.checkAndRunBackup().catch(err => logger.error('Backup scheduler error:', err));
    }, 60000); // Check every minute

    logger.debug('▶️  Backup scheduler started (checks every minute)');

    // Run initial check
    this.checkAndRunBackup().catch(err => logger.error('Backup scheduler error:', err));
  }

  /**
   * Stop the backup scheduler
   */
  stop(): void {
    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
      this.schedulerInterval = null;
    }

    this.isRunning = false;
    logger.info('⏹️  Backup scheduler stopped');
  }

  /**
   * Check if it's time to run a backup and execute if needed
   */
  private async checkAndRunBackup(): Promise<void> {
    // Check and run device backups
    await this.checkAndRunDeviceBackup();

    // Check and run system backups
    await this.checkAndRunSystemBackup();
  }

  /**
   * Persist a source's schedule. Saving never triggers a backup: when the
   * chosen time is not later than now, today's guard is set, so only the next
   * day's slot fires.
   */
  async applySettings(sourceId: string, settings: BackupScheduleSettings, now: Date = new Date()): Promise<void> {
    const s = databaseService.settings;
    await s.setSetting(key(sourceId, 'backup_enabled'), String(settings.enabled));
    await s.setSetting(key(sourceId, 'backup_maxBackups'), String(settings.maxBackups));
    await s.setSetting(key(sourceId, 'backup_time'), settings.backupTime);
    if (settings.enabled && settings.backupTime <= hhmm(now)) {
      await s.setSetting(key(sourceId, 'backup_lastAutomaticBackupDate'), localDateString(now));
    }
  }

  /** Read a source's schedule and the last automatic result. */
  async readSettings(sourceId: string): Promise<BackupScheduleSettings & {
    lastAutomaticBackupDate: string | null;
    lastAutomaticBackupAt: string | null;
    lastAutomaticBackupError: string | null;
  }> {
    const s = databaseService.settings;
    const maxRaw = parseInt((await s.getSetting(key(sourceId, 'backup_maxBackups'))) || '7', 10);
    return {
      enabled: (await s.getSetting(key(sourceId, 'backup_enabled'))) === 'true',
      maxBackups: Number.isNaN(maxRaw) ? 7 : maxRaw,
      backupTime: (await s.getSetting(key(sourceId, 'backup_time'))) || '02:00',
      lastAutomaticBackupDate: (await s.getSetting(key(sourceId, 'backup_lastAutomaticBackupDate'))) || null,
      lastAutomaticBackupAt: (await s.getSetting(key(sourceId, 'backup_lastAutomaticBackupAt'))) || null,
      lastAutomaticBackupError: (await s.getSetting(key(sourceId, 'backup_lastAutomaticBackupError'))) || null,
    };
  }

  /**
   * Check every Meshtastic TCP and MeshCore source, sequentially, and back up
   * those whose local HH:MM matches now and that have not run today.
   */
  async checkAndRunDeviceBackup(now: Date = new Date()): Promise<void> {
    // Prevent multiple concurrent device backup passes
    if (this.isDeviceBackupInProgress) {
      return;
    }
    this.isDeviceBackupInProgress = true;
    try {
      const sources = await databaseService.sources.getAllSources();
      for (const source of sources) {
        if (source.type !== 'meshtastic_tcp' && source.type !== 'meshcore') continue;
        try {
          await this.checkSource(source.id, source.type === 'meshcore' ? 'meshcore' : 'meshtastic', now);
        } catch (error) {
          logger.error(`Error in device backup scheduler check for source ${source.id}:`, error instanceof Error ? error.message : String(error));
        }
      }
    } catch (error) {
      logger.error('Error in device backup scheduler check:', error);
    } finally {
      this.isDeviceBackupInProgress = false;
    }
  }

  private async checkSource(sourceId: string, protocol: BackupProtocol, now: Date): Promise<void> {
    const s = databaseService.settings;
    if ((await s.getSetting(key(sourceId, 'backup_enabled'))) !== 'true') return;

    const backupTime = (await s.getSetting(key(sourceId, 'backup_time'))) || '02:00';
    if (backupTime !== hhmm(now)) return; // not this minute

    const today = localDateString(now);
    if ((await s.getSetting(key(sourceId, 'backup_lastAutomaticBackupDate'))) === today) return;

    // The slot is reached: set the guard first, so a skip, a failure or a
    // restart in the same minute never runs it twice. No catch-up later.
    await s.setSetting(key(sourceId, 'backup_lastAutomaticBackupDate'), today);

    let error = '';
    try {
      const manager = this.registry?.getManager(sourceId);
      if (!manager || !manager.getStatus().connected) {
        error = 'SOURCE_NOT_CONNECTED';
      } else if (protocol === 'meshcore' && !(await this.isCompanion(manager))) {
        error = 'SOURCE_NOT_COMPANION';
      } else if (isBackupBusy(sourceId)) {
        error = 'BACKUP_BUSY';
      } else {
        const target: BackupTarget = { sourceId, protocol, manager };
        const { filename } = await deviceConfigBackupService.create(target, 'automatic');
        logger.info(`Automated ${protocol} backup completed for source ${sourceId}: ${filename}`);
      }
    } catch (err) {
      error = 'BACKUP_FAILED';
      logger.error(`Automated device backup failed for source ${sourceId}:`, err instanceof Error ? err.message : String(err));
    }
    if (error) logger.warn(`Automated device backup for source ${sourceId} did not run: ${error}`);
    await s.setSetting(key(sourceId, 'backup_lastAutomaticBackupError'), error);
    await s.setSetting(key(sourceId, 'backup_lastAutomaticBackupAt'), now.toISOString());
  }

  private async isCompanion(manager: ISourceManager): Promise<boolean> {
    const { MeshCoreDeviceType } = await import('../meshcoreManager.js');
    const status = (manager as unknown as { getConnectionStatus(): { deviceType?: unknown } }).getConnectionStatus();
    return status.deviceType === MeshCoreDeviceType.COMPANION;
  }

  /**
   * Check if it's time to run a system backup and execute if needed
   */
  private async checkAndRunSystemBackup(): Promise<void> {
    // Prevent multiple concurrent system backup executions
    if (this.isSystemBackupInProgress) {
      return;
    }

    try {
      // Check if automated system backups are enabled
      const enabled = await databaseService.settings.getSetting('system_backup_enabled');
      if (enabled !== 'true') {
        return; // Automated system backups are disabled
      }

      // Get the configured backup time (HH:MM format)
      const backupTime = await databaseService.settings.getSetting('system_backup_time') || '03:00';
      const [targetHour, targetMinute] = backupTime.split(':').map(Number);

      // Get current time
      const now = new Date();
      const currentHour = now.getHours();
      const currentMinute = now.getMinutes();

      // Check if we're within the backup time window (same hour and minute)
      if (currentHour !== targetHour || currentMinute !== targetMinute) {
        return; // Not time yet
      }

      // Check if we already ran a system backup today
      const lastBackupKey = 'system_backup_lastAutomaticBackup';
      const lastBackup = await databaseService.settings.getSetting(lastBackupKey);
      const today = now.toISOString().split('T')[0]; // YYYY-MM-DD

      if (lastBackup && lastBackup.startsWith(today)) {
        return; // Already ran a system backup today
      }

      // Set flag to prevent race conditions
      this.isSystemBackupInProgress = true;

      // Run the automated system backup
      logger.debug('⏰ Time for automated system backup...');
      await this.runAutomatedSystemBackup();

      // Update last system backup timestamp
      await databaseService.settings.setSetting(lastBackupKey, now.toISOString());
    } catch (error) {
      logger.error('❌ Error in system backup scheduler check:', error);
    } finally {
      // Always release the lock
      this.isSystemBackupInProgress = false;
    }
  }

  /**
   * Run an automated system backup
   */
  private async runAutomatedSystemBackup(): Promise<void> {
    try {
      logger.debug('🤖 Running automated system backup...');

      // Create system backup
      const dirname = await systemBackupService.createBackup('automatic');

      logger.info(`✅ Automated system backup completed: ${dirname}`);
    } catch (error) {
      logger.error('❌ Failed to run automated system backup:', error);
    }
  }

  /**
   * Manually trigger a system backup
   */
  async triggerManualSystemBackup(): Promise<string> {
    logger.debug('👤 Running manual system backup...');

    // Create system backup
    const dirname = await systemBackupService.createBackup('manual');

    logger.info(`✅ Manual system backup completed: ${dirname}`);

    return dirname;
  }

  /**
   * Get scheduler status. Device schedules are per source (`readSettings`);
   * only the system schedule is global.
   */
  async getStatus(): Promise<{
    running: boolean;
    system: {
      nextCheck: string | null;
      enabled: boolean;
      backupTime: string;
    };
  }> {
    // System backup settings
    const systemEnabled = await databaseService.settings.getSetting('system_backup_enabled') === 'true';
    const systemBackupTime = await databaseService.settings.getSetting('system_backup_time') || '03:00';

    let systemNextCheck: string | null = null;
    if (this.isRunning && systemEnabled) {
      const now = new Date();
      const [targetHour, targetMinute] = systemBackupTime.split(':').map(Number);

      const next = new Date(now);
      next.setHours(targetHour, targetMinute, 0, 0);

      // If the time has passed today, schedule for tomorrow
      if (next <= now) {
        next.setDate(next.getDate() + 1);
      }

      systemNextCheck = next.toISOString();
    }

    return {
      running: this.isRunning,
      system: {
        nextCheck: systemNextCheck,
        enabled: systemEnabled,
        backupTime: systemBackupTime
      }
    };
  }
}

export const backupSchedulerService = new BackupSchedulerService();
