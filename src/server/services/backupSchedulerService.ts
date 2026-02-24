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
  private meshtasticManager: any = null;

  /**
   * Initialize the backup scheduler
   */
  initialize(meshtasticManager: any): void {
    this.meshtasticManager = meshtasticManager;

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
      this.checkAndRunBackup();
    }, 60000); // Check every minute

    logger.info('▶️  Backup scheduler started (checks every minute)');

    // Run initial check
    this.checkAndRunBackup();
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
      const enabled = databaseService.getSetting('backup_enabled');
      if (enabled !== 'true') {
        return; // Automated device backups are disabled
      }

      // Get the configured backup time (HH:MM format)
      const backupTime = databaseService.getSetting('backup_time') || '02:00';
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
      const lastBackup = databaseService.getSetting(lastBackupKey);
      const today = now.toISOString().split('T')[0]; // YYYY-MM-DD

      if (lastBackup && lastBackup.startsWith(today)) {
        return; // Already ran a device backup today
      }

      // Set flag to prevent race conditions
      this.isDeviceBackupInProgress = true;

      // Run the automated device backup
      logger.info('⏰ Time for automated device backup...');
      await this.runAutomatedDeviceBackup();

      // Update last device backup timestamp
      databaseService.setSetting(lastBackupKey, now.toISOString());
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
      const enabled = databaseService.getSetting('system_backup_enabled');
      if (enabled !== 'true') {
        return; // Automated system backups are disabled
      }

      // Get the configured backup time (HH:MM format)
      const backupTime = databaseService.getSetting('system_backup_time') || '03:00';
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
      const lastBackup = databaseService.getSetting(lastBackupKey);
      const today = now.toISOString().split('T')[0]; // YYYY-MM-DD

      if (lastBackup && lastBackup.startsWith(today)) {
        return; // Already ran a system backup today
      }

      // Set flag to prevent race conditions
      this.isSystemBackupInProgress = true;

      // Run the automated system backup
      logger.info('⏰ Time for automated system backup...');
      await this.runAutomatedSystemBackup();

      // Update last system backup timestamp
      databaseService.setSetting(lastBackupKey, now.toISOString());
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
      if (!this.meshtasticManager) {
        throw new Error('Meshtastic manager not initialized');
      }

      logger.info('🤖 Running automated device backup...');

      // Generate the backup YAML
      const yamlBackup = await deviceBackupService.generateBackup(this.meshtasticManager);

      // Get node ID for filename
      const localNodeInfo = this.meshtasticManager.getLocalNodeInfo();
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
      logger.info('🤖 Running automated system backup...');

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
    if (!this.meshtasticManager) {
      throw new Error('Meshtastic manager not initialized');
    }

    logger.info('👤 Running manual backup...');

    // Generate the backup YAML
    const yamlBackup = await deviceBackupService.generateBackup(this.meshtasticManager);

    // Get node ID for filename
    const localNodeInfo = this.meshtasticManager.getLocalNodeInfo();
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
    logger.info('👤 Running manual system backup...');

    // Create system backup
    const dirname = await systemBackupService.createBackup('manual');

    logger.info(`✅ Manual system backup completed: ${dirname}`);

    return dirname;
  }

  /**
   * Get scheduler status
   */
  getStatus(): {
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
  } {
    // Device backup settings
    const deviceEnabled = databaseService.getSetting('backup_enabled') === 'true';
    const deviceBackupTime = databaseService.getSetting('backup_time') || '02:00';

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
    const systemEnabled = databaseService.getSetting('system_backup_enabled') === 'true';
    const systemBackupTime = databaseService.getSetting('system_backup_time') || '03:00';

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
