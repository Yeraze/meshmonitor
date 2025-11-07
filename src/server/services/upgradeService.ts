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

      // Write trigger file for watchdog
      const triggerData = {
        upgradeId,
        version: targetVersion,
        backup: request.backup !== false,
        timestamp: now
      };

      fs.writeFileSync(UPGRADE_TRIGGER_FILE, JSON.stringify(triggerData, null, 2));
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

      return {
        upgradeId: row.id,
        status: row.status,
        progress: row.progress || 0,
        currentStep: row.currentStep || '',
        logs: row.logs ? JSON.parse(row.logs) : [],
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

      return rows.map(row => ({
        upgradeId: row.id,
        status: row.status,
        progress: row.progress || 0,
        currentStep: row.currentStep || '',
        logs: row.logs ? JSON.parse(row.logs) : [],
        startedAt: new Date(row.startedAt).toISOString(),
        completedAt: row.completedAt ? new Date(row.completedAt).toISOString() : undefined,
        error: row.errorMessage,
        fromVersion: row.fromVersion,
        toVersion: row.toVersion
      }));
    } catch (error) {
      logger.error('❌ Failed to get upgrade history:', error);
      return [];
    }
  }

  /**
   * Check if an upgrade is currently in progress
   */
  private async isUpgradeInProgress(): Promise<boolean> {
    try {
      const row = databaseService.db.prepare(
        `SELECT COUNT(*) as count FROM upgrade_history
         WHERE status IN ('pending', 'backing_up', 'downloading', 'restarting', 'health_check')`
      ).get() as any;

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
}

export const upgradeService = new UpgradeService();
