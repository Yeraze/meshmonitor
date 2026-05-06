/**
 * Upgrade Service
 * Handles automatic self-upgrade functionality for Docker deployments
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { v4 as uuidv4 } from 'uuid';

const DATA_DIR = process.env.DATA_DIR || '/data';
const UPGRADE_TRIGGER_FILE = path.join(DATA_DIR, '.upgrade-trigger');
const UPGRADE_STATUS_FILE = path.join(DATA_DIR, '.upgrade-status');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

// Circuit-breaker threshold: trip after this many consecutive failed upgrades
// to halt unattended retries when something is structurally wrong (e.g. a
// pinned image tag in docker-compose.yml — see issue #2871).
const PARSED_THRESHOLD = parseInt(process.env.AUTO_UPGRADE_FAILURE_THRESHOLD || '', 10);
export const AUTO_UPGRADE_FAILURE_THRESHOLD =
  Number.isFinite(PARSED_THRESHOLD) && PARSED_THRESHOLD > 0 ? PARSED_THRESHOLD : 3;

export interface UpgradeStatus {
  upgradeId: string;
  status: 'pending' | 'backing_up' | 'downloading' | 'restarting' | 'health_check' | 'complete' | 'failed' | 'rolled_back';
  progress: number;
  currentStep: string;
  logs: string[];
  startedAt: string;
  completedAt?: string;
  error?: string;
  fromVersion: string;
  toVersion: string;
}

export interface UpgradeRequest {
  targetVersion?: string;
  force?: boolean;
  backup?: boolean;
}

class UpgradeService {
  private readonly UPGRADE_ENABLED: boolean;
  private readonly DEPLOYMENT_METHOD: string;

  constructor() {
    this.UPGRADE_ENABLED = process.env.AUTO_UPGRADE_ENABLED === 'true';
    this.DEPLOYMENT_METHOD = this.detectDeploymentMethod();

    if (this.UPGRADE_ENABLED) {
      logger.info(`✅ Auto-upgrade enabled (deployment: ${this.DEPLOYMENT_METHOD})`);
    }
  }

  /**
   * Atomic file write using temp file + rename
   * This prevents race conditions and partial writes
   */
  private atomicWriteFile(filePath: string, content: string): void {
    // Defense in depth: all callers pass compile-time constants (UPGRADE_TRIGGER_FILE
    // or UPGRADE_STATUS_FILE), but enforce prefix check so a future caller with
    // a tainted filePath can never escape DATA_DIR.
    const resolvedDataDir = path.resolve(DATA_DIR);
    const resolvedFilePath = path.resolve(filePath);
    if (!resolvedFilePath.startsWith(resolvedDataDir + path.sep)) {
      throw new Error('Refusing to write upgrade file outside data directory');
    }
    const tempPath = `${resolvedFilePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    try {
      // Write to temporary file first
      fs.writeFileSync(tempPath, content, { mode: 0o644 });
      // Atomic rename (replaces target file if it exists)
      fs.renameSync(tempPath, resolvedFilePath);
    } catch (error) {
      // Clean up temp file if rename failed
      try {
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      } catch (_cleanupError) {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  /**
   * Check if upgrade functionality is enabled
   */
  isEnabled(): boolean {
    return this.UPGRADE_ENABLED;
  }

  /**
   * Detect the deployment method
   */
  private detectDeploymentMethod(): string {
    // Check if running in Kubernetes
    if (process.env.KUBERNETES_SERVICE_HOST) {
      return 'kubernetes';
    }

    // Check if running in Docker
    if (fs.existsSync('/.dockerenv')) {
      return 'docker';
    }

    // Check if running in LXC container
    // LXC containers can be detected by checking /proc/1/environ for container=lxc
    try {
      if (fs.existsSync('/proc/1/environ')) {
        const environ = fs.readFileSync('/proc/1/environ', 'utf8');
        if (environ.includes('container=lxc')) {
          return 'lxc';
        }
      }
    } catch (error) {
      // Ignore errors reading /proc/1/environ
    }

    return 'manual';
  }

  /**
   * Get deployment method for display
   */
  getDeploymentMethod(): string {
    return this.DEPLOYMENT_METHOD;
  }

  /**
   * Trigger an upgrade
   */
  async triggerUpgrade(
    request: UpgradeRequest,
    currentVersion: string,
    initiatedBy: string
  ): Promise<{ success: boolean; upgradeId?: string; message: string; issues?: string[] }> {
    try {
      // Check if enabled
      if (!this.UPGRADE_ENABLED) {
        return {
          success: false,
          message: 'Auto-upgrade is not enabled. Set AUTO_UPGRADE_ENABLED=true to enable.'
        };
      }

      // Check if Docker deployment
      if (this.DEPLOYMENT_METHOD !== 'docker') {
        const messages: Record<string, string> = {
          'lxc': 'Auto-upgrade is not supported in LXC deployments. Please update manually by downloading a new template from GitHub Releases.',
          'kubernetes': 'Auto-upgrade is not supported in Kubernetes deployments. Please update via Helm chart or kubectl apply.',
          'manual': 'Auto-upgrade is only available for Docker deployments. Current deployment method: manual'
        };

        return {
          success: false,
          message: messages[this.DEPLOYMENT_METHOD] || `Auto-upgrade is only supported for Docker deployments. Current: ${this.DEPLOYMENT_METHOD}`
        };
      }

      // Circuit breaker: refuse system-initiated upgrades when blocked.
      // Manual user-initiated upgrades (initiatedBy not starting with 'system-')
      // and force=true bypass the block so the user can investigate / retry.
      if (this.isSystemInitiated(initiatedBy) && !request.force) {
        const blocked = await this.getAutoUpgradeBlock();
        if (blocked.blocked) {
          logger.warn(`🛑 Auto-upgrade blocked by circuit breaker — refusing scheduled trigger. Reason: ${blocked.reason}`);
          return {
            success: false,
            message: `Auto-upgrade is blocked after ${AUTO_UPGRADE_FAILURE_THRESHOLD} consecutive failed attempts. ${blocked.reason || ''} Acknowledge from the UI to resume.`.trim()
          };
        }
      }

      // Check if upgrade already in progress
      const inProgress = await this.isUpgradeInProgress();
      if (inProgress && !request.force) {
        return {
          success: false,
          message: 'An upgrade is already in progress'
        };
      }

      const targetVersion = request.targetVersion || 'latest';

      // Pre-flight checks
      if (!request.force) {
        const checks = await this.preFlightChecks(targetVersion);
        if (!checks.safe) {
          return {
            success: false,
            message: 'Pre-flight checks failed',
            issues: checks.issues
          };
        }
      }

      // Create upgrade job
      const upgradeId = uuidv4();
      const now = Date.now();

      if (!databaseService.miscRepo) {
        return {
          success: false,
          message: 'Database repository not initialized'
        };
      }

      await databaseService.miscRepo.createUpgradeHistory({
        id: upgradeId,
        fromVersion: currentVersion,
        toVersion: targetVersion,
        deploymentMethod: this.DEPLOYMENT_METHOD,
        status: 'pending',
        progress: 0,
        currentStep: 'Preparing upgrade',
        logs: JSON.stringify(['Upgrade initiated']),
        startedAt: now,
        initiatedBy,
        rollbackAvailable: true,
      });

      // Clear stale watchdog status from any prior run before kicking off this
      // upgrade. Without this, the file-based sync paths in getUpgradeStatus()
      // and getActiveUpgrade() would observe a leftover "failed" string and
      // mark this brand-new row failed before the watchdog has even picked up
      // the trigger — which both surfaces a spurious "Upgrade failed" toast
      // and prevents markCompleteAndClear() from clearing the circuit
      // breaker on success.
      try {
        if (fs.existsSync(UPGRADE_STATUS_FILE)) {
          fs.unlinkSync(UPGRADE_STATUS_FILE);
        }
      } catch (clearError) {
        logger.warn('Could not clear stale upgrade status file before trigger:', clearError);
      }

      // Write trigger file for watchdog (using atomic write to prevent race conditions)
      const triggerData = {
        upgradeId,
        version: targetVersion,
        backup: request.backup !== false,
        timestamp: now
      };

      this.atomicWriteFile(UPGRADE_TRIGGER_FILE, JSON.stringify(triggerData, null, 2));
      logger.info(`🚀 Upgrade triggered: ${currentVersion} → ${targetVersion} (ID: ${upgradeId})`);

      return {
        success: true,
        upgradeId,
        message: `Upgrade to ${targetVersion} initiated. The watchdog will handle the upgrade process.`
      };
    } catch (error) {
      logger.error('❌ Failed to trigger upgrade:', error);
      return {
        success: false,
        message: `Failed to trigger upgrade: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  /**
   * Get upgrade status
   */
  async getUpgradeStatus(upgradeId: string): Promise<UpgradeStatus | null> {
    try {
      if (!databaseService.miscRepo) {
        logger.error('❌ Database repository not initialized');
        return null;
      }

      let row = await databaseService.miscRepo.getUpgradeById(upgradeId);

      if (!row) {
        return null;
      }

      // Sync terminal states from watchdog status file if DB still shows in-progress
      const IN_PROGRESS_STATUSES = ['pending', 'backing_up', 'downloading', 'restarting', 'health_check', 'cleanup'];
      if (IN_PROGRESS_STATUSES.includes(row.status)) {
        try {
          if (fs.existsSync(UPGRADE_STATUS_FILE)) {
            const fileStatus = fs.readFileSync(UPGRADE_STATUS_FILE, 'utf-8').trim().toLowerCase();
            if (fileStatus === 'complete' || fileStatus === 'ready') {
              logger.info(`🔄 Syncing upgrade ${upgradeId} status from file: ${row.status} -> complete`);
              await this.markCompleteAndClear(row.id);
              const updated = await databaseService.miscRepo.getUpgradeById(upgradeId);
              if (updated) row = updated;
            } else if (fileStatus === 'failed') {
              logger.info(`🔄 Syncing upgrade ${upgradeId} status from file: ${row.status} -> failed`);
              await this.markFailedAndEvaluate(row.id, 'Upgrade failed (detected from watchdog status)');
              const updated = await databaseService.miscRepo.getUpgradeById(upgradeId);
              if (updated) row = updated;
            }
          }
        } catch (fileError) {
          logger.debug('Could not read upgrade status file:', fileError);
        }
      }

      // Safely parse logs JSON
      let logs: string[] = [];
      if (row.logs) {
        try {
          const parsed = JSON.parse(row.logs);
          logs = Array.isArray(parsed) ? parsed : [];
        } catch (parseError) {
          logger.warn(`Failed to parse logs for upgrade ${upgradeId}:`, parseError);
          logs = [];
        }
      }

      return {
        upgradeId: row.id,
        status: row.status as UpgradeStatus['status'],
        progress: row.progress || 0,
        currentStep: row.currentStep || '',
        logs,
        startedAt: row.startedAt ? new Date(row.startedAt).toISOString() : new Date().toISOString(),
        completedAt: row.completedAt ? new Date(row.completedAt).toISOString() : undefined,
        error: row.errorMessage ?? undefined,
        fromVersion: row.fromVersion,
        toVersion: row.toVersion
      };
    } catch (error) {
      logger.error('❌ Failed to get upgrade status:', error);
      return null;
    }
  }

  /**
   * Get latest upgrade status from file (updated by watchdog)
   */
  async getLatestUpgradeStatus(): Promise<string | null> {
    try {
      if (fs.existsSync(UPGRADE_STATUS_FILE)) {
        const status = fs.readFileSync(UPGRADE_STATUS_FILE, 'utf-8').trim();
        return status;
      }
      return null;
    } catch (error) {
      logger.error('❌ Failed to read upgrade status file:', error);
      return null;
    }
  }

  /**
   * Get upgrade history
   */
  async getUpgradeHistory(limit: number = 10): Promise<UpgradeStatus[]> {
    try {
      if (!databaseService.miscRepo) {
        logger.error('❌ Database repository not initialized');
        return [];
      }

      const rows = await databaseService.miscRepo.getUpgradeHistoryList(limit);

      return rows.map(row => {
        // Safely parse logs JSON
        let logs: string[] = [];
        if (row.logs) {
          try {
            const parsed = JSON.parse(row.logs);
            logs = Array.isArray(parsed) ? parsed : [];
          } catch (parseError) {
            logger.warn(`Failed to parse logs for upgrade ${row.id}:`, parseError);
            logs = [];
          }
        }

        return {
          upgradeId: row.id,
          status: row.status as UpgradeStatus['status'],
          progress: row.progress || 0,
          currentStep: row.currentStep || '',
          logs,
          startedAt: row.startedAt ? new Date(row.startedAt).toISOString() : new Date().toISOString(),
          completedAt: row.completedAt ? new Date(row.completedAt).toISOString() : undefined,
          error: row.errorMessage ?? undefined,
          fromVersion: row.fromVersion,
          toVersion: row.toVersion
        };
      });
    } catch (error) {
      logger.error('❌ Failed to get upgrade history:', error);
      return [];
    }
  }

  /**
   * Check if an upgrade is currently in progress
   * Also cleans up stale upgrades that have been stuck for too long
   * @public - Made public to allow external code to check upgrade status before triggering
   */
  async isUpgradeInProgress(): Promise<boolean> {
    try {
      if (!databaseService.miscRepo) {
        logger.error('❌ Database repository not initialized');
        return false;
      }

      // First, clean up any stale upgrades (stuck for more than 30 minutes)
      const STALE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
      const staleThreshold = Date.now() - STALE_TIMEOUT_MS;

      const staleUpgrades = await databaseService.miscRepo.findStaleUpgrades(staleThreshold);

      if (staleUpgrades.length > 0) {
        logger.warn(`⚠️ Found ${staleUpgrades.length} stale upgrade(s), marking as failed`);

        for (const staleUpgrade of staleUpgrades) {
          const minutesStuck = Math.round((Date.now() - (staleUpgrade.startedAt || 0)) / 60000);
          logger.warn(`⚠️ Upgrade ${staleUpgrade.id} stuck at "${staleUpgrade.currentStep}" for ${minutesStuck} minutes`);

          await this.markFailedAndEvaluate(
            staleUpgrade.id,
            `Upgrade timed out after ${minutesStuck} minutes (stuck at: ${staleUpgrade.currentStep})`
          );

          // Also remove trigger file if it exists
          if (fs.existsSync(UPGRADE_TRIGGER_FILE)) {
            fs.unlinkSync(UPGRADE_TRIGGER_FILE);
            logger.info('🗑️ Removed stale upgrade trigger file');
          }
        }
      }

      // Now check if any non-stale upgrades are in progress
      const count = await databaseService.miscRepo.countInProgressUpgrades(staleThreshold);

      return count > 0;
    } catch (error) {
      logger.error('❌ Failed to check upgrade progress:', error);
      return false;
    }
  }

  /**
   * Get the currently active upgrade, if any
   * Also syncs with the upgrade status file written by the watchdog sidecar
   * @returns The active upgrade details or null if no upgrade is in progress
   */
  async getActiveUpgrade(): Promise<{
    upgradeId: string;
    status: string;
    progress: number;
    currentStep: string;
    fromVersion: string;
    toVersion: string;
    startedAt: number;
  } | null> {
    try {
      if (!databaseService.miscRepo) {
        logger.error('❌ Database repository not initialized');
        return null;
      }

      const STALE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
      const staleThreshold = Date.now() - STALE_TIMEOUT_MS;

      const row = await databaseService.miscRepo.findActiveUpgrade(staleThreshold);

      if (!row) {
        return null;
      }

      // Check status file from watchdog sidecar to sync state after container restart
      // The watchdog writes 'complete', 'ready', or 'failed' after the upgrade finishes
      // but the database may still show 'restarting' or 'health_check' if the old container
      // never had a chance to update it before being replaced
      try {
        if (fs.existsSync(UPGRADE_STATUS_FILE)) {
          const fileStatus = fs.readFileSync(UPGRADE_STATUS_FILE, 'utf-8').trim().toLowerCase();

          // If the watchdog has marked the upgrade complete or ready, sync to database
          if (fileStatus === 'complete' || fileStatus === 'ready') {
            logger.info(`🔄 Syncing upgrade status from file: ${row.status} -> complete`);
            await this.markCompleteAndClear(row.id);

            // No active upgrade anymore
            return null;
          }

          // If the watchdog has marked it failed, sync to database
          if (fileStatus === 'failed') {
            logger.info(`🔄 Syncing upgrade status from file: ${row.status} -> failed`);
            await this.markFailedAndEvaluate(
              row.id,
              'Upgrade failed (detected from watchdog status)'
            );

            // No active upgrade anymore
            return null;
          }
        }
      } catch (fileError) {
        // Ignore file read errors - continue with database status
        logger.debug('Could not read upgrade status file:', fileError);
      }

      return {
        upgradeId: row.id,
        status: row.status,
        progress: row.progress || 0,
        currentStep: row.currentStep || 'Starting...',
        fromVersion: row.fromVersion,
        toVersion: row.toVersion,
        startedAt: row.startedAt || Date.now(),
      };
    } catch (error) {
      logger.error('❌ Failed to get active upgrade:', error);
      return null;
    }
  }

  /**
   * Pre-flight checks before upgrade
   */
  private async preFlightChecks(_targetVersion: string): Promise<{ safe: boolean; issues: string[] }> {
    const issues: string[] = [];

    try {
      // Check disk space (need at least 500MB free)
      const stats = fs.statfsSync ? fs.statfsSync(DATA_DIR) : null;
      if (stats) {
        const freeSpace = stats.bavail * stats.bsize;
        const requiredSpace = 500 * 1024 * 1024; // 500MB
        if (freeSpace < requiredSpace) {
          issues.push(`Insufficient disk space. Required: 500MB, Available: ${Math.round(freeSpace / 1024 / 1024)}MB`);
        }
      }

      // Check if backup directory is writable
      if (!fs.existsSync(BACKUP_DIR)) {
        try {
          fs.mkdirSync(BACKUP_DIR, { recursive: true });
        } catch (error) {
          issues.push('Cannot create backup directory');
        }
      } else {
        try {
          fs.accessSync(BACKUP_DIR, fs.constants.W_OK);
        } catch (error) {
          issues.push('Backup directory is not writable');
        }
      }

      // Check if previous upgrade failed
      if (databaseService.miscRepo) {
        const lastUpgrade = await databaseService.miscRepo.getLastUpgrade();

        if (lastUpgrade && lastUpgrade.status === 'failed') {
          logger.warn('⚠️ Previous upgrade failed, but allowing new upgrade attempt');
          // Don't block, but log warning
        }
      }

      // Verify trigger file is writable
      try {
        fs.writeFileSync(path.join(DATA_DIR, '.upgrade-test'), 'test');
        fs.unlinkSync(path.join(DATA_DIR, '.upgrade-test'));
      } catch (error) {
        issues.push('Cannot write to data directory');
      }

    } catch (error) {
      logger.error('❌ Error during pre-flight checks:', error);
      issues.push(`Pre-flight check error: ${error instanceof Error ? error.message : String(error)}`);
    }

    return {
      safe: issues.length === 0,
      issues
    };
  }

  /**
   * Identify scheduled/immediate auto-upgrades vs manual user-initiated ones.
   * Used to scope circuit-breaker effects to unattended attempts only.
   */
  private isSystemInitiated(initiatedBy: string): boolean {
    return typeof initiatedBy === 'string' && initiatedBy.startsWith('system-');
  }

  /**
   * Read circuit-breaker state. Blocked when a previous run tripped the
   * threshold and no successful upgrade has cleared it since.
   */
  async getAutoUpgradeBlock(): Promise<{
    blocked: boolean;
    reason: string | null;
    consecutiveFailures: number;
    threshold: number;
  }> {
    let consecutiveFailures = 0;
    if (databaseService.miscRepo) {
      try {
        consecutiveFailures = await databaseService.miscRepo.countConsecutiveFailedUpgrades();
      } catch (error) {
        logger.warn('Failed to count consecutive upgrade failures:', error);
      }
    }
    let blocked = false;
    let reason: string | null = null;
    try {
      blocked = (await databaseService.settings.getSetting('autoUpgradeBlocked')) === 'true';
      reason = (await databaseService.settings.getSetting('autoUpgradeBlockedReason')) ?? null;
    } catch (error) {
      logger.warn('Failed to read auto-upgrade block state:', error);
    }
    return { blocked, reason, consecutiveFailures, threshold: AUTO_UPGRADE_FAILURE_THRESHOLD };
  }

  /**
   * Mark an upgrade failed and evaluate the circuit breaker.
   * Trips the breaker when consecutive failures reach the threshold.
   */
  private async markFailedAndEvaluate(id: string, errorMessage: string): Promise<void> {
    if (!databaseService.miscRepo) return;
    await databaseService.miscRepo.markUpgradeFailed(id, errorMessage);

    try {
      const consecutiveFailures = await databaseService.miscRepo.countConsecutiveFailedUpgrades();
      if (consecutiveFailures >= AUTO_UPGRADE_FAILURE_THRESHOLD) {
        const reason = `${consecutiveFailures} consecutive upgrade attempts failed. Last error: ${errorMessage}`;
        await databaseService.settings.setSetting('autoUpgradeBlocked', 'true');
        await databaseService.settings.setSetting('autoUpgradeBlockedReason', reason);
        logger.warn(`🛑 Auto-upgrade circuit breaker tripped after ${consecutiveFailures} failures: ${errorMessage}`);
      }
    } catch (error) {
      logger.warn('Failed to evaluate auto-upgrade circuit breaker:', error);
    }
  }

  /**
   * Mark an upgrade complete and clear any tripped circuit breaker.
   * Called instead of miscRepo.markUpgradeComplete from internal sync paths.
   */
  private async markCompleteAndClear(id: string): Promise<void> {
    if (!databaseService.miscRepo) return;
    await databaseService.miscRepo.markUpgradeComplete(id);
    await this.clearAutoUpgradeBlock('Cleared by successful upgrade');
  }

  /**
   * Clear the circuit breaker (user acknowledgement or successful upgrade).
   */
  async clearAutoUpgradeBlock(reason?: string): Promise<void> {
    try {
      await databaseService.settings.setSetting('autoUpgradeBlocked', 'false');
      await databaseService.settings.setSetting('autoUpgradeBlockedReason', '');
      if (reason) {
        logger.info(`✅ Auto-upgrade circuit breaker cleared: ${reason}`);
      }
    } catch (error) {
      logger.warn('Failed to clear auto-upgrade block:', error);
    }
  }

  /**
   * Cancel an in-progress upgrade
   */
  async cancelUpgrade(upgradeId: string): Promise<{ success: boolean; message: string }> {
    try {
      // Remove trigger file if it exists
      if (fs.existsSync(UPGRADE_TRIGGER_FILE)) {
        fs.unlinkSync(UPGRADE_TRIGGER_FILE);
      }

      // Update database status
      if (!databaseService.miscRepo) {
        return {
          success: false,
          message: 'Database repository not initialized'
        };
      }

      await databaseService.miscRepo.markUpgradeFailed(upgradeId, 'Cancelled by user');

      logger.info(`⚠️ Upgrade cancelled: ${upgradeId}`);

      return {
        success: true,
        message: 'Upgrade cancelled'
      };
    } catch (error) {
      logger.error('❌ Failed to cancel upgrade:', error);
      return {
        success: false,
        message: `Failed to cancel upgrade: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  /**
   * Test auto-upgrade configuration
   * Verifies all components needed for auto-upgrade are properly configured
   */
  async testConfiguration(): Promise<{
    success: boolean;
    results: Array<{ check: string; passed: boolean; message: string; details?: string }>;
    overallMessage: string;
  }> {
    const results: Array<{ check: string; passed: boolean; message: string; details?: string }> = [];

    try {
      // Check 1: AUTO_UPGRADE_ENABLED environment variable
      const upgradeEnabled = this.UPGRADE_ENABLED;
      results.push({
        check: 'Environment Variable',
        passed: upgradeEnabled,
        message: upgradeEnabled
          ? 'AUTO_UPGRADE_ENABLED=true is set'
          : 'AUTO_UPGRADE_ENABLED is not set to true',
        details: upgradeEnabled
          ? 'Auto-upgrade functionality is enabled'
          : 'Set AUTO_UPGRADE_ENABLED=true in docker-compose.yml or environment'
      });

      // Check 2: Deployment method
      const isDocker = this.DEPLOYMENT_METHOD === 'docker';
      results.push({
        check: 'Deployment Method',
        passed: isDocker,
        message: `Detected deployment: ${this.DEPLOYMENT_METHOD}`,
        details: isDocker
          ? 'Running in Docker container'
          : 'Auto-upgrade requires Docker deployment'
      });

      // Check 3: Data directory writable
      try {
        const testFile = path.join(DATA_DIR, '.upgrade-test-' + Date.now());
        fs.writeFileSync(testFile, 'test');
        fs.unlinkSync(testFile);
        results.push({
          check: 'Data Directory',
          passed: true,
          message: 'Data directory is writable',
          details: `Path: ${DATA_DIR}`
        });
      } catch (error) {
        results.push({
          check: 'Data Directory',
          passed: false,
          message: 'Cannot write to data directory',
          details: error instanceof Error ? error.message : String(error)
        });
      }

      // Check 4: Backup directory
      try {
        if (!fs.existsSync(BACKUP_DIR)) {
          fs.mkdirSync(BACKUP_DIR, { recursive: true });
        }
        fs.accessSync(BACKUP_DIR, fs.constants.W_OK);
        results.push({
          check: 'Backup Directory',
          passed: true,
          message: 'Backup directory exists and is writable',
          details: `Path: ${BACKUP_DIR}`
        });
      } catch (error) {
        results.push({
          check: 'Backup Directory',
          passed: false,
          message: 'Backup directory not writable',
          details: error instanceof Error ? error.message : String(error)
        });
      }

      // Check 5: Upgrader container (check if sidecar is running)
      // We can infer this by checking if the upgrade watchdog can be communicated with
      // For now, we'll check if the upgrade status file exists or can be created
      try {
        // Try to read existing status file, or create a test one
        if (fs.existsSync(UPGRADE_STATUS_FILE)) {
          const status = fs.readFileSync(UPGRADE_STATUS_FILE, 'utf-8').trim();
          results.push({
            check: 'Upgrader Sidecar',
            passed: true,
            message: 'Upgrader watchdog is running',
            details: `Current status: ${status || 'ready'}`
          });
        } else {
          // Write a test status to see if watchdog picks it up
          // If AUTO_UPGRADE_ENABLED is true but status file doesn't exist yet,
          // the watchdog might still be initializing
          results.push({
            check: 'Upgrader Sidecar',
            passed: upgradeEnabled && isDocker, // Assume it's starting if env is correct
            message: upgradeEnabled && isDocker
              ? 'Upgrader sidecar should be running (status file not yet created)'
              : 'Upgrader sidecar not detected',
            details: upgradeEnabled && isDocker
              ? 'The sidecar may still be initializing. Check "docker ps" for meshmonitor-upgrader container'
              : 'Ensure docker-compose.upgrade.yml is used when starting: docker compose -f docker-compose.yml -f docker-compose.upgrade.yml up -d'
          });
        }
      } catch (error) {
        results.push({
          check: 'Upgrader Sidecar',
          passed: false,
          message: 'Cannot detect upgrader watchdog',
          details: error instanceof Error ? error.message : String(error)
        });
      }

      // Check 6: Disk space
      try {
        const stats = fs.statfsSync ? fs.statfsSync(DATA_DIR) : null;
        if (stats) {
          const freeSpaceMB = Math.round((stats.bavail * stats.bsize) / 1024 / 1024);
          const requiredMB = 500;
          const hasSpace = freeSpaceMB >= requiredMB;
          results.push({
            check: 'Disk Space',
            passed: hasSpace,
            message: `${freeSpaceMB}MB free (${requiredMB}MB required)`,
            details: hasSpace
              ? 'Sufficient disk space for upgrade and backup'
              : `Need at least ${requiredMB}MB free space`
          });
        } else {
          results.push({
            check: 'Disk Space',
            passed: true,
            message: 'Unable to check disk space',
            details: 'statfsSync not available on this system'
          });
        }
      } catch (error) {
        results.push({
          check: 'Disk Space',
          passed: false,
          message: 'Could not check disk space',
          details: error instanceof Error ? error.message : String(error)
        });
      }

      // Check 7: Docker socket access (for the watchdog)
      // Test by executing the test script in the upgrader container
      if (upgradeEnabled && isDocker) {
        try {
          // Create a test request file
          const testRequestFile = path.join(DATA_DIR, '.docker-socket-test-request');
          const testResultFile = path.join(DATA_DIR, '.docker-socket-test');

          // Remove any previous test results
          if (fs.existsSync(testResultFile)) {
            fs.unlinkSync(testResultFile);
          }

          // Create test request (signals the upgrader to run the test)
          fs.writeFileSync(testRequestFile, Date.now().toString());

          // Wait for test result (upgrader will create the result file)
          let waited = 0;
          const maxWait = 10000; // 10 seconds
          let testResult = null;

          while (waited < maxWait) {
            if (fs.existsSync(testResultFile)) {
              testResult = fs.readFileSync(testResultFile, 'utf-8').trim();
              break;
            }
            // Wait 100ms between checks
            await new Promise(resolve => setTimeout(resolve, 100));
            waited += 100;
          }

          // Clean up test request file
          if (fs.existsSync(testRequestFile)) {
            fs.unlinkSync(testRequestFile);
          }

          if (testResult) {
            const isPassed = testResult.startsWith('PASS');
            const isWarn = testResult.startsWith('WARN');

            results.push({
              check: 'Docker Socket Permissions',
              passed: isPassed || isWarn,
              message: isPassed ? 'Upgrader can access Docker socket' :
                       isWarn ? 'Docker socket accessible (with warnings)' :
                       'Upgrader cannot access Docker socket',
              details: testResult
            });
          } else {
            // Timeout - upgrader may not be running or test script not available
            results.push({
              check: 'Docker Socket Permissions',
              passed: false,
              message: 'Cannot verify Docker socket access',
              details: 'Test timed out. Ensure meshmonitor-upgrader container is running with docker-compose.upgrade.yml'
            });
          }
        } catch (error) {
          results.push({
            check: 'Docker Socket Permissions',
            passed: false,
            message: 'Failed to test Docker socket access',
            details: error instanceof Error ? error.message : String(error)
          });
        }
      } else {
        results.push({
          check: 'Docker Socket Permissions',
          passed: false,
          message: 'Requires upgrader sidecar',
          details: 'Auto-upgrade must be enabled and running in Docker to test socket permissions'
        });
      }

      // Determine overall success
      const allCriticalPassed = results
        .filter(r => ['Environment Variable', 'Deployment Method', 'Data Directory', 'Backup Directory'].includes(r.check))
        .every(r => r.passed);

      const overallMessage = allCriticalPassed
        ? 'Auto-upgrade configuration is valid. All critical checks passed.'
        : 'Auto-upgrade configuration has issues. Review failed checks above.';

      return {
        success: allCriticalPassed,
        results,
        overallMessage
      };
    } catch (error) {
      logger.error('❌ Failed to test configuration:', error);
      return {
        success: false,
        results: [{
          check: 'Test Error',
          passed: false,
          message: 'Failed to run configuration test',
          details: error instanceof Error ? error.message : String(error)
        }],
        overallMessage: 'Configuration test failed to run'
      };
    }
  }
}

export const upgradeService = new UpgradeService();
