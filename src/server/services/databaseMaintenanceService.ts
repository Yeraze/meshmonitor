/**
 * Database Maintenance Service
 *
 * Automatically cleans up old data from the database to prevent unbounded growth.
 * Runs at a configurable time (default 04:00 local time) and deletes:
 * - Messages older than messageRetentionDays (default 30)
 * - Traceroutes older than tracerouteRetentionDays (default 30)
 * - Route segments older than routeSegmentRetentionDays (default 30)
 * - Neighbor info older than neighborInfoRetentionDays (default 30)
 *
 * After cleanup, runs VACUUM to reclaim disk space.
 */

import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { waypointService } from './waypointService.js';

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

/** Minimum allowed retention days to prevent accidental data wipe */
const MIN_RETENTION_DAYS = 1;

/**
 * Format bytes to human-readable string
 */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return bytes === 0 ? '0 B' : `${bytes} B`;
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

/**
 * Get local date string in YYYY-MM-DD format (consistent with local time scheduling)
 */
function getLocalDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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
   * Get a retention setting from the database, with default and minimum enforcement
   */
  private async getRetentionDays(key: string, defaultDays: number = 30): Promise<number> {
    const value = parseInt(await databaseService.settings.getSetting(key) || String(defaultDays), 10);
    if (isNaN(value) || value < MIN_RETENTION_DAYS) {
      logger.warn(`⚠️ Retention setting "${key}" is ${value}, clamping to minimum ${MIN_RETENTION_DAYS} day(s)`);
      return MIN_RETENTION_DAYS;
    }
    return value;
  }

  /**
   * Check if it's time to run maintenance and execute if needed.
   * Uses a ±1 minute window to handle setInterval drift.
   */
  private async checkAndRunMaintenance(): Promise<void> {
    // Check if maintenance is enabled
    const enabled = await databaseService.settings.getSetting('maintenanceEnabled');
    if (enabled !== 'true') {
      return;
    }

    // Get the configured maintenance time (HH:MM format, default 04:00)
    const maintenanceTime = await databaseService.settings.getSetting('maintenanceTime') || '04:00';
    const [targetHour, targetMinute] = maintenanceTime.split(':').map(Number);

    // Get current time (all local time for consistency)
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();

    // Convert to minutes-since-midnight for easier comparison with ±1 minute window
    const targetMinutes = targetHour * 60 + targetMinute;
    const currentMinutes = currentHour * 60 + currentMinute;
    const diff = Math.abs(currentMinutes - targetMinutes);

    // Allow ±1 minute window to handle setInterval drift
    if (diff > 1 && diff < 1439) {
      // diff < 1439 handles midnight wraparound (e.g., target=23:59, current=00:00 → diff=1)
      return; // Not time yet
    }

    // Check if we already ran maintenance today (use local date, consistent with local time trigger)
    const lastRunKey = 'maintenance_lastRun';
    const lastRun = await databaseService.settings.getSetting(lastRunKey);
    const today = getLocalDateString(now);

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
   * Run database maintenance (can be called manually or by scheduler).
   * Uses a promise lock to prevent concurrent runs — the check-and-set is
   * atomic because it executes synchronously within a single event loop turn.
   */
  async runMaintenance(): Promise<MaintenanceStats> {
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
      // Get retention settings (defaults: 30 days, minimum: 1 day)
      const [messageRetention, tracerouteRetention, routeSegmentRetention, neighborInfoRetention] =
        await Promise.all([
          this.getRetentionDays('messageRetentionDays'),
          this.getRetentionDays('tracerouteRetentionDays'),
          this.getRetentionDays('routeSegmentRetentionDays'),
          this.getRetentionDays('neighborInfoRetentionDays'),
        ]);

      logger.info(`🔧 Running database maintenance with retention: messages=${messageRetention}d, traceroutes=${tracerouteRetention}d, routeSegments=${routeSegmentRetention}d, neighborInfo=${neighborInfoRetention}d`);

      // Get database size before cleanup
      stats.sizeBefore = await databaseService.getDatabaseSizeAsync();
      logger.info(`📊 Database size before: ${formatBytes(stats.sizeBefore)}`);

      // Run cleanups
      stats.messagesDeleted = await databaseService.cleanupOldMessagesAsync(messageRetention);
      if (stats.messagesDeleted > 0) {
        logger.info(`🗑️ Deleted ${stats.messagesDeleted} old messages`);
      }

      stats.traceroutesDeleted = await databaseService.cleanupOldTraceroutesAsync(tracerouteRetention);
      if (stats.traceroutesDeleted > 0) {
        logger.info(`🗑️ Deleted ${stats.traceroutesDeleted} old traceroutes`);
      }

      stats.routeSegmentsDeleted = await databaseService.cleanupOldRouteSegmentsAsync(routeSegmentRetention);
      if (stats.routeSegmentsDeleted > 0) {
        logger.info(`🗑️ Deleted ${stats.routeSegmentsDeleted} old route segments`);
      }

      stats.neighborInfoDeleted = await databaseService.cleanupOldNeighborInfoAsync(neighborInfoRetention);
      if (stats.neighborInfoDeleted > 0) {
        logger.info(`🗑️ Deleted ${stats.neighborInfoDeleted} old neighbor info records`);
      }

      // Sweep expired waypoints (24h grace by default).
      try {
        const expired = await waypointService.expireSweep();
        if (expired > 0) {
          logger.info(`🗑️ Removed ${expired} expired waypoint(s)`);
        }
      } catch (error) {
        logger.error('Waypoint expire sweep failed:', error);
      }

      // Run VACUUM to reclaim space
      await databaseService.vacuumAsync();

      // Get database size after cleanup
      stats.sizeAfter = await databaseService.getDatabaseSizeAsync();
      stats.duration = Date.now() - startTime;

      // Update in-memory state
      this.lastRunTime = Date.now();
      this.lastRunStats = stats;

      const totalDeleted = stats.messagesDeleted + stats.traceroutesDeleted +
                          stats.routeSegmentsDeleted + stats.neighborInfoDeleted;
      const spaceSaved = stats.sizeBefore - stats.sizeAfter;

      logger.info(`✅ Database maintenance complete in ${(stats.duration / 1000).toFixed(1)}s: ` +
        `deleted ${totalDeleted} records, size: ${formatBytes(stats.sizeBefore)} → ${formatBytes(stats.sizeAfter)} ` +
        `(${spaceSaved >= 0 ? 'saved' : 'grew by'} ${formatBytes(Math.abs(spaceSaved))})`);

      return stats;
    } catch (error) {
      logger.error('❌ Database maintenance failed:', error);
      throw error;
    } finally {
      this.isMaintenanceInProgress = false;
      // Always record that maintenance was attempted today (even on failure)
      // to prevent retry storms on persistent errors
      try {
        await databaseService.settings.setSetting(
          'maintenance_lastRun',
          `${getLocalDateString(new Date())}T${new Date().toISOString().split('T')[1]}`
        );
      } catch (settingError) {
        logger.error('❌ Failed to record maintenance_lastRun:', settingError);
      }
    }
  }

  /**
   * Get the current status of the maintenance service
   */
  async getStatus(): Promise<MaintenanceStatus> {
    // Fetch all settings in parallel to reduce DB round-trips
    const [enabledStr, maintenanceTime, messageRet, tracerouteRet, routeSegmentRet, neighborInfoRet] =
      await Promise.all([
        databaseService.settings.getSetting('maintenanceEnabled'),
        databaseService.settings.getSetting('maintenanceTime'),
        this.getRetentionDays('messageRetentionDays'),
        this.getRetentionDays('tracerouteRetentionDays'),
        this.getRetentionDays('routeSegmentRetentionDays'),
        this.getRetentionDays('neighborInfoRetentionDays'),
      ]);

    const enabled = enabledStr === 'true';
    const time = maintenanceTime || '04:00';

    // Calculate next scheduled run
    let nextScheduledRun: string | null = null;
    if (this.isRunning && enabled) {
      const now = new Date();
      const [targetHour, targetMinute] = time.split(':').map(Number);
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
      maintenanceTime: time,
      lastRunTime: this.lastRunTime,
      lastRunStats: this.lastRunStats,
      nextScheduledRun,
      databaseType: databaseService.drizzleDbType,
      settings: {
        messageRetentionDays: messageRet,
        tracerouteRetentionDays: tracerouteRet,
        routeSegmentRetentionDays: routeSegmentRet,
        neighborInfoRetentionDays: neighborInfoRet
      }
    };
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
