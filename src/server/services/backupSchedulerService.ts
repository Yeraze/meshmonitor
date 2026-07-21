/**
 * Backup Scheduler Service
 * Handles automated backup scheduling and execution for both device and system backups
 */

import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { deviceBackupService } from './deviceBackupService.js';
import { backupFileService } from './backupFileService.js';
import { systemBackupService } from './systemBackupService.js';

class BackupSchedulerService {
  private schedulerInterval: NodeJS.Timeout | null = null;
  private isRunning = false;
  private isDeviceBackupInProgress = false;
  private isSystemBackupInProgress = false;
  // Resolver rather than a captured instance: #3962 Phase 4.2a WP4 removed the
  // live Proxy alias that used to make a stored manager reference always
  // track the registry's current primary meshtastic_tcp source. A resolver
  // function preserves that "always current" behavior without the Proxy —
  // call it fresh on every use instead of caching the manager at initialize() time.
  private resolveManager: (() => any) | null = null;

  /**
   * Initialize the backup scheduler
   */
  initialize(resolveManager: () => any): void {
    this.resolveManager = resolveManager;

    // Initialize backup directories
    backupFileService.initializeBackupDirectory();
    systemBackupService.initializeBackupDirectory();

    // Start the scheduler
    this.start();

    logger.info('✅ Backup scheduler initialized (device + system backups)');
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
   * Check if it's time to run a device backup and execute if needed
   */
  private async checkAndRunDeviceBackup(): Promise<void> {
    // Prevent multiple concurrent device backup executions
    if (this.isDeviceBackupInProgress) {
      return;
    }

    try {
      // Check if automated device backups are enabled
      const enabled = await databaseService.settings.getSetting('backup_enabled');
      if (enabled !== 'true') {
        return; // Automated device backups are disabled
      }

      // Get the configured backup time (HH:MM format)
      const backupTime = await databaseService.settings.getSetting('backup_time') || '02:00';
      const [targetHour, targetMinute] = backupTime.split(':').map(Number);

      // Get current time
      const now = new Date();
      const currentHour = now.getHours();
      const currentMinute = now.getMinutes();

      // Check if we're within the backup time window (same hour and minute)
      if (currentHour !== targetHour || currentMinute !== targetMinute) {
        return; // Not time yet
      }

      // Check if we already ran a device backup today
      const lastBackupKey = 'backup_lastAutomaticBackup';
      const lastBackup = await databaseService.settings.getSetting(lastBackupKey);
      const today = now.toISOString().split('T')[0]; // YYYY-MM-DD

      if (lastBackup && lastBackup.startsWith(today)) {
        return; // Already ran a device backup today
      }

      // Set flag to prevent race conditions
      this.isDeviceBackupInProgress = true;

      // Run the automated device backup
      logger.debug('⏰ Time for automated device backup...');
      await this.runAutomatedDeviceBackup();

      // Update last device backup timestamp
      await databaseService.settings.setSetting(lastBackupKey, now.toISOString());
    } catch (error) {
      logger.error('❌ Error in device backup scheduler check:', error);
    } finally {
      // Always release the lock
      this.isDeviceBackupInProgress = false;
    }
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
   * Run an automated device backup
   */
  private async runAutomatedDeviceBackup(): Promise<void> {
    try {
      if (!this.resolveManager) {
        throw new Error('Meshtastic manager not initialized');
      }
      const meshtasticManager = this.resolveManager();

      logger.debug('🤖 Running automated device backup...');

      // Generate the backup YAML
      const yamlBackup = await deviceBackupService.generateBackup(meshtasticManager);

      // Get node ID for filename
      const localNodeInfo = meshtasticManager.getLocalNodeInfo();
      const nodeId = localNodeInfo?.nodeId || '!unknown';

      // Save to disk
      const filename = await backupFileService.saveBackup(yamlBackup, 'automatic', nodeId);

      logger.info(`✅ Automated device backup completed: ${filename}`);
    } catch (error) {
      logger.error('❌ Failed to run automated device backup:', error);
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
   * Manually trigger a backup (for testing or manual execution)
   */
  async triggerManualBackup(): Promise<string> {
    if (!this.resolveManager) {
      throw new Error('Meshtastic manager not initialized');
    }
    const meshtasticManager = this.resolveManager();

    logger.debug('👤 Running manual backup...');

    // Generate the backup YAML
    const yamlBackup = await deviceBackupService.generateBackup(meshtasticManager);

    // Get node ID for filename
    const localNodeInfo = meshtasticManager.getLocalNodeInfo();
    const nodeId = localNodeInfo?.nodeId || '!unknown';

    // Save to disk
    const filename = await backupFileService.saveBackup(yamlBackup, 'manual', nodeId);

    logger.info(`✅ Manual backup completed: ${filename}`);

    return filename;
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
   * Get scheduler status
   */
  async getStatus(): Promise<{
    running: boolean;
    device: {
      nextCheck: string | null;
      enabled: boolean;
      backupTime: string;
    };
    system: {
      nextCheck: string | null;
      enabled: boolean;
      backupTime: string;
    };
  }> {
    // Device backup settings
    const deviceEnabled = await databaseService.settings.getSetting('backup_enabled') === 'true';
    const deviceBackupTime = await databaseService.settings.getSetting('backup_time') || '02:00';

    let deviceNextCheck: string | null = null;
    if (this.isRunning && deviceEnabled) {
      const now = new Date();
      const [targetHour, targetMinute] = deviceBackupTime.split(':').map(Number);

      const next = new Date(now);
      next.setHours(targetHour, targetMinute, 0, 0);

      // If the time has passed today, schedule for tomorrow
      if (next <= now) {
        next.setDate(next.getDate() + 1);
      }

      deviceNextCheck = next.toISOString();
    }

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
      device: {
        nextCheck: deviceNextCheck,
        enabled: deviceEnabled,
        backupTime: deviceBackupTime
      },
      system: {
        nextCheck: systemNextCheck,
        enabled: systemEnabled,
        backupTime: systemBackupTime
      }
    };
  }
}

export const backupSchedulerService = new BackupSchedulerService();
