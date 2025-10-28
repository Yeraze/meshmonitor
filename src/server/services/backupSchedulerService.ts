/**
 * Backup Scheduler Service
 * Handles automated backup scheduling and execution
 */

import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { deviceBackupService } from './deviceBackupService.js';
import { backupFileService } from './backupFileService.js';

class BackupSchedulerService {
  private schedulerInterval: NodeJS.Timeout | null = null;
  private isRunning = false;
  private meshtasticManager: any = null;

  /**
   * Initialize the backup scheduler
   */
  initialize(meshtasticManager: any): void {
    this.meshtasticManager = meshtasticManager;

    // Initialize backup directory
    backupFileService.initializeBackupDirectory();

    // Start the scheduler
    this.start();

    logger.info('✅ Backup scheduler initialized');
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
    try {
      // Check if automated backups are enabled
      const enabled = databaseService.getSetting('backup_enabled');
      if (enabled !== 'true') {
        return; // Automated backups are disabled
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

      // Check if we already ran a backup today
      const lastBackupKey = 'backup_lastAutomaticBackup';
      const lastBackup = databaseService.getSetting(lastBackupKey);
      const today = now.toISOString().split('T')[0]; // YYYY-MM-DD

      if (lastBackup && lastBackup.startsWith(today)) {
        return; // Already ran a backup today
      }

      // Run the automated backup
      logger.info('⏰ Time for automated backup...');
      await this.runAutomatedBackup();

      // Update last backup timestamp
      databaseService.setSetting(lastBackupKey, now.toISOString());
    } catch (error) {
      logger.error('❌ Error in backup scheduler check:', error);
    }
  }

  /**
   * Run an automated backup
   */
  private async runAutomatedBackup(): Promise<void> {
    try {
      if (!this.meshtasticManager) {
        throw new Error('Meshtastic manager not initialized');
      }

      logger.info('🤖 Running automated backup...');

      // Generate the backup YAML
      const yamlBackup = await deviceBackupService.generateBackup(this.meshtasticManager);

      // Get node ID for filename
      const localNodeInfo = this.meshtasticManager.getLocalNodeInfo();
      const nodeId = localNodeInfo?.nodeId || '!unknown';

      // Save to disk
      const filename = await backupFileService.saveBackup(yamlBackup, 'automatic', nodeId);

      logger.info(`✅ Automated backup completed: ${filename}`);
    } catch (error) {
      logger.error('❌ Failed to run automated backup:', error);
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
   * Get scheduler status
   */
  getStatus(): { running: boolean; nextCheck: string | null; enabled: boolean; backupTime: string } {
    const enabled = databaseService.getSetting('backup_enabled') === 'true';
    const backupTime = databaseService.getSetting('backup_time') || '02:00';

    let nextCheck: string | null = null;
    if (this.isRunning && enabled) {
      const now = new Date();
      const [targetHour, targetMinute] = backupTime.split(':').map(Number);

      const next = new Date(now);
      next.setHours(targetHour, targetMinute, 0, 0);

      // If the time has passed today, schedule for tomorrow
      if (next <= now) {
        next.setDate(next.getDate() + 1);
      }

      nextCheck = next.toISOString();
    }

    return {
      running: this.isRunning,
      nextCheck,
      enabled,
      backupTime
    };
  }
}

export const backupSchedulerService = new BackupSchedulerService();
