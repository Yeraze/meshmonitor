/**
 * Database Maintenance Service
 *
 * Automatically cleans up old data from the database to prevent unbounded growth.
 * Runs at a configurable time (default 04:00) and deletes:
 * - Messages older than messageRetentionDays (default 30)
 * - Traceroutes older than tracerouteRetentionDays (default 30)
 * - Route segments older than routeSegmentRetentionDays (default 30)
 * - Neighbor info older than neighborInfoRetentionDays (default 30)
 *
 * After cleanup, runs VACUUM to reclaim disk space.
 */

import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';

export interface MaintenanceStats {
  messagesDeleted: number;
  traceroutesDeleted: number;
  routeSegmentsDeleted: number;
  neighborInfoDeleted: number;
  sizeBefore: number;
  sizeAfter: number;
  duration: number;
  timestamp: string;
}

export interface MaintenanceStatus {
  running: boolean;
  maintenanceInProgress: boolean;
  enabled: boolean;
  maintenanceTime: string;
  lastRunTime: number | null;
  lastRunStats: MaintenanceStats | null;
  nextScheduledRun: string | null;
  databaseType: 'sqlite' | 'postgres' | 'mysql';
  settings: {
    messageRetentionDays: number;
    tracerouteRetentionDays: number;
    routeSegmentRetentionDays: number;
    neighborInfoRetentionDays: number;
  };
}

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

class DatabaseMaintenanceService {
  private schedulerInterval: NodeJS.Timeout | null = null;
  private isRunning = false;
  private isMaintenanceInProgress = false;
  private maintenanceLock: Promise<MaintenanceStats> | null = null;
  private lastRunTime: number | null = null;
  private lastRunStats: MaintenanceStats | null = null;

  /**
   * Initialize the database maintenance service
   */
  initialize(): void {
    this.start();
    logger.info('✅ Database maintenance service initialized');
  }

  /**
   * Start the maintenance scheduler
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('⚠️ Database maintenance scheduler is already running');
      return;
    }

    this.isRunning = true;

    // Check every minute if it's time to run maintenance
    this.schedulerInterval = setInterval(() => {
      this.checkAndRunMaintenance().catch(error => {
        logger.error('❌ Error in maintenance scheduler check:', error);
      });
    }, 60000); // Check every minute

    logger.info('▶️ Database maintenance scheduler started (checks every minute)');
  }

  /**
   * Stop the maintenance scheduler
   */
  stop(): void {
    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
      this.schedulerInterval = null;
    }
    this.isRunning = false;
    logger.info('⏹️ Database maintenance scheduler stopped');
  }

  /**
   * Check if it's time to run maintenance and execute if needed
   */
  private async checkAndRunMaintenance(): Promise<void> {
    // Check if maintenance is enabled
    const enabled = databaseService.getSetting('maintenanceEnabled');
    if (enabled !== 'true') {
      return;
    }

    // Get the configured maintenance time (HH:MM format, default 04:00)
    const maintenanceTime = databaseService.getSetting('maintenanceTime') || '04:00';
    const [targetHour, targetMinute] = maintenanceTime.split(':').map(Number);

    // Get current time
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();

    // Check if we're within the maintenance time window (exact minute match)
    if (currentHour !== targetHour || currentMinute !== targetMinute) {
      return; // Not time yet
    }

    // Check if we already ran maintenance today
    const lastRunKey = 'maintenance_lastRun';
    const lastRun = databaseService.getSetting(lastRunKey);
    const today = now.toISOString().split('T')[0]; // YYYY-MM-DD

    if (lastRun && lastRun.startsWith(today)) {
      return; // Already ran maintenance today
    }

    // Run maintenance
    logger.info('⏰ Time for scheduled database maintenance...');
    try {
      await this.runMaintenance();
    } catch (error) {
      logger.error('❌ Scheduled maintenance failed:', error);
    }
  }

  /**
   * Run database maintenance (can be called manually or by scheduler)
   * Uses a lock to prevent race conditions from concurrent calls
   */
  async runMaintenance(): Promise<MaintenanceStats> {
    // If maintenance is already running, throw an error
    // The lock ensures atomic check-and-set
    if (this.maintenanceLock) {
      throw new Error('Maintenance already in progress');
    }

    // Create the maintenance promise and store it as the lock
    this.maintenanceLock = this.executeMaintenanceInternal();

    try {
      return await this.maintenanceLock;
    } finally {
      this.maintenanceLock = null;
    }
  }

  /**
   * Internal maintenance execution - should only be called via runMaintenance()
   */
  private async executeMaintenanceInternal(): Promise<MaintenanceStats> {
    this.isMaintenanceInProgress = true;
    const startTime = Date.now();

    const stats: MaintenanceStats = {
      messagesDeleted: 0,
      traceroutesDeleted: 0,
      routeSegmentsDeleted: 0,
      neighborInfoDeleted: 0,
      sizeBefore: 0,
      sizeAfter: 0,
      duration: 0,
      timestamp: new Date().toISOString()
    };

    try {
      // Get retention settings (defaults: 30 days)
      const messageRetention = parseInt(databaseService.getSetting('messageRetentionDays') || '30', 10);
      const tracerouteRetention = parseInt(databaseService.getSetting('tracerouteRetentionDays') || '30', 10);
      const routeSegmentRetention = parseInt(databaseService.getSetting('routeSegmentRetentionDays') || '30', 10);
      const neighborInfoRetention = parseInt(databaseService.getSetting('neighborInfoRetentionDays') || '30', 10);

      logger.info(`🔧 Running database maintenance with retention: messages=${messageRetention}d, traceroutes=${tracerouteRetention}d, routeSegments=${routeSegmentRetention}d, neighborInfo=${neighborInfoRetention}d`);

      // Get database size before cleanup
      stats.sizeBefore = databaseService.getDatabaseSize();
      logger.info(`📊 Database size before: ${formatBytes(stats.sizeBefore)}`);

      // Run cleanups
      stats.messagesDeleted = databaseService.cleanupOldMessages(messageRetention);
      if (stats.messagesDeleted > 0) {
        logger.info(`🗑️ Deleted ${stats.messagesDeleted} old messages`);
      }

      stats.traceroutesDeleted = databaseService.cleanupOldTraceroutes(tracerouteRetention);
      if (stats.traceroutesDeleted > 0) {
        logger.info(`🗑️ Deleted ${stats.traceroutesDeleted} old traceroutes`);
      }

      stats.routeSegmentsDeleted = databaseService.cleanupOldRouteSegments(routeSegmentRetention);
      if (stats.routeSegmentsDeleted > 0) {
        logger.info(`🗑️ Deleted ${stats.routeSegmentsDeleted} old route segments`);
      }

      stats.neighborInfoDeleted = databaseService.cleanupOldNeighborInfo(neighborInfoRetention);
      if (stats.neighborInfoDeleted > 0) {
        logger.info(`🗑️ Deleted ${stats.neighborInfoDeleted} old neighbor info records`);
      }

      // Run VACUUM to reclaim space
      databaseService.vacuum();

      // Get database size after cleanup
      stats.sizeAfter = databaseService.getDatabaseSize();
      stats.duration = Date.now() - startTime;

      // Update last run time in database
      databaseService.setSetting('maintenance_lastRun', new Date().toISOString());

      // Update in-memory state
      this.lastRunTime = Date.now();
      this.lastRunStats = stats;

      const totalDeleted = stats.messagesDeleted + stats.traceroutesDeleted +
                          stats.routeSegmentsDeleted + stats.neighborInfoDeleted;
      const spaceSaved = stats.sizeBefore - stats.sizeAfter;

      logger.info(`✅ Database maintenance complete in ${(stats.duration / 1000).toFixed(1)}s: ` +
        `deleted ${totalDeleted} records, size: ${formatBytes(stats.sizeBefore)} → ${formatBytes(stats.sizeAfter)} ` +
        `(saved ${formatBytes(spaceSaved)})`);

      return stats;
    } catch (error) {
      logger.error('❌ Database maintenance failed:', error);
      throw error;
    } finally {
      this.isMaintenanceInProgress = false;
    }
  }

  /**
   * Get the current status of the maintenance service
   */
  getStatus(): MaintenanceStatus {
    const enabled = databaseService.getSetting('maintenanceEnabled') === 'true';
    const maintenanceTime = databaseService.getSetting('maintenanceTime') || '04:00';

    // Calculate next scheduled run
    let nextScheduledRun: string | null = null;
    if (this.isRunning && enabled) {
      const now = new Date();
      const [targetHour, targetMinute] = maintenanceTime.split(':').map(Number);
      const next = new Date(now);
      next.setHours(targetHour, targetMinute, 0, 0);

      // If the time has already passed today, schedule for tomorrow
      if (next <= now) {
        next.setDate(next.getDate() + 1);
      }
      nextScheduledRun = next.toISOString();
    }

    return {
      running: this.isRunning,
      maintenanceInProgress: this.isMaintenanceInProgress,
      enabled,
      maintenanceTime,
      lastRunTime: this.lastRunTime,
      lastRunStats: this.lastRunStats,
      nextScheduledRun,
      databaseType: databaseService.drizzleDbType,
      settings: {
        messageRetentionDays: parseInt(databaseService.getSetting('messageRetentionDays') || '30', 10),
        tracerouteRetentionDays: parseInt(databaseService.getSetting('tracerouteRetentionDays') || '30', 10),
        routeSegmentRetentionDays: parseInt(databaseService.getSetting('routeSegmentRetentionDays') || '30', 10),
        neighborInfoRetentionDays: parseInt(databaseService.getSetting('neighborInfoRetentionDays') || '30', 10)
      }
    };
  }

  /**
   * Get the current database size in bytes
   */
  getDatabaseSize(): number {
    return databaseService.getDatabaseSize();
  }

  /**
   * Get the current database size in bytes - async version for PostgreSQL/MySQL
   */
  async getDatabaseSizeAsync(): Promise<number> {
    return databaseService.getDatabaseSizeAsync();
  }

  /**
   * Format bytes to human-readable string (exposed for external use)
   */
  formatBytes(bytes: number): string {
    return formatBytes(bytes);
  }
}

export const databaseMaintenanceService = new DatabaseMaintenanceService();
