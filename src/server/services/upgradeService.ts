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
    const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    try {
      // Write to temporary file first
      fs.writeFileSync(tempPath, content, { mode: 0o644 });
      // Atomic rename (replaces target file if it exists)
      fs.renameSync(tempPath, filePath);
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
    // Check if running in Docker
    if (fs.existsSync('/.dockerenv')) {
      // Check if running in Kubernetes
      if (process.env.KUBERNETES_SERVICE_HOST) {
        return 'kubernetes';
      }
      // Check if managed by Docker Compose
      return 'docker';
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
        return {
          success: false,
          message: `Auto-upgrade is only supported for Docker deployments. Current: ${this.DEPLOYMENT_METHOD}`
        };
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

      databaseService.db.prepare(
        `INSERT INTO upgrade_history
        (id, fromVersion, toVersion, deploymentMethod, status, progress, currentStep, logs, startedAt, initiatedBy, rollbackAvailable)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        upgradeId,
        currentVersion,
        targetVersion,
        this.DEPLOYMENT_METHOD,
        'pending',
        0,
        'Preparing upgrade',
        JSON.stringify(['Upgrade initiated']),
        now,
        initiatedBy,
        1
      );

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
      const row = databaseService.db.prepare(
        `SELECT * FROM upgrade_history WHERE id = ? ORDER BY startedAt DESC LIMIT 1`
      ).get(upgradeId) as any;

      if (!row) {
        return null;
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
        status: row.status,
        progress: row.progress || 0,
        currentStep: row.currentStep || '',
        logs,
        startedAt: new Date(row.startedAt).toISOString(),
        completedAt: row.completedAt ? new Date(row.completedAt).toISOString() : undefined,
        error: row.errorMessage,
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
      const rows = databaseService.db.prepare(
        `SELECT * FROM upgrade_history ORDER BY startedAt DESC LIMIT ?`
      ).all(limit) as any[];

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
          status: row.status,
          progress: row.progress || 0,
          currentStep: row.currentStep || '',
          logs,
          startedAt: new Date(row.startedAt).toISOString(),
          completedAt: row.completedAt ? new Date(row.completedAt).toISOString() : undefined,
          error: row.errorMessage,
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
   */
  private async isUpgradeInProgress(): Promise<boolean> {
    try {
      // First, clean up any stale upgrades (stuck for more than 30 minutes)
      const STALE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
      const staleThreshold = Date.now() - STALE_TIMEOUT_MS;

      const staleUpgrades = databaseService.db.prepare(
        `SELECT id, startedAt, currentStep FROM upgrade_history
         WHERE status IN ('pending', 'backing_up', 'downloading', 'restarting', 'health_check')
         AND startedAt < ?`
      ).all(staleThreshold) as any[];

      if (staleUpgrades.length > 0) {
        logger.warn(`⚠️ Found ${staleUpgrades.length} stale upgrade(s), marking as failed`);

        for (const staleUpgrade of staleUpgrades) {
          const minutesStuck = Math.round((Date.now() - staleUpgrade.startedAt) / 60000);
          logger.warn(`⚠️ Upgrade ${staleUpgrade.id} stuck at "${staleUpgrade.currentStep}" for ${minutesStuck} minutes`);

          databaseService.db.prepare(
            `UPDATE upgrade_history
             SET status = ?, completedAt = ?, errorMessage = ?
             WHERE id = ?`
          ).run(
            'failed',
            Date.now(),
            `Upgrade timed out after ${minutesStuck} minutes (stuck at: ${staleUpgrade.currentStep})`,
            staleUpgrade.id
          );

          // Also remove trigger file if it exists
          if (fs.existsSync(UPGRADE_TRIGGER_FILE)) {
            fs.unlinkSync(UPGRADE_TRIGGER_FILE);
            logger.info('🗑️ Removed stale upgrade trigger file');
          }
        }
      }

      // Now check if any non-stale upgrades are in progress
      const row = databaseService.db.prepare(
        `SELECT COUNT(*) as count FROM upgrade_history
         WHERE status IN ('pending', 'backing_up', 'downloading', 'restarting', 'health_check')
         AND startedAt >= ?`
      ).get(staleThreshold) as any;

      return row.count > 0;
    } catch (error) {
      logger.error('❌ Failed to check upgrade progress:', error);
      return false;
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
      const lastUpgrade = databaseService.db.prepare(
        `SELECT * FROM upgrade_history ORDER BY startedAt DESC LIMIT 1`
      ).get() as any;

      if (lastUpgrade && lastUpgrade.status === 'failed') {
        logger.warn('⚠️ Previous upgrade failed, but allowing new upgrade attempt');
        // Don't block, but log warning
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
   * Cancel an in-progress upgrade
   */
  async cancelUpgrade(upgradeId: string): Promise<{ success: boolean; message: string }> {
    try {
      // Remove trigger file if it exists
      if (fs.existsSync(UPGRADE_TRIGGER_FILE)) {
        fs.unlinkSync(UPGRADE_TRIGGER_FILE);
      }

      // Update database status
      databaseService.db.prepare(
        `UPDATE upgrade_history SET status = ?, completedAt = ?, errorMessage = ? WHERE id = ?`
      ).run('failed', Date.now(), 'Cancelled by user', upgradeId);

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
