/**
 * Solar Monitoring Service
 * Handles automated fetching of solar production estimates from forecast.solar API
 * Runs 5 minutes after every hour to retrieve updated estimates
 */

import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import * as cron from 'node-cron';

interface SolarEstimateResponse {
  result: Record<string, number>; // timestamp -> watt_hours mapping
  message?: {
    code: number;
    type: string;
    text: string;
    info?: Record<string, unknown>;
  };
}

class SolarMonitoringService {
  private cronJob: cron.ScheduledTask | null = null;
  private isInitialized = false;

  /**
   * Initialize the solar monitoring service
   * Sets up the cron job to run 5 minutes after every hour
   */
  initialize(): void {
    if (this.isInitialized) {
      logger.warn('⚠️  Solar monitoring service is already initialized');
      return;
    }

    // Schedule to run at 5 minutes past every hour (cron: "5 * * * *")
    // Minutes Hours Days Months DayOfWeek
    const cronExpression = '5 * * * *';

    if (!cron.validate(cronExpression)) {
      logger.error('❌ Invalid cron expression for solar monitoring');
      return;
    }

    this.cronJob = cron.schedule(
      cronExpression,
      async () => {
        logger.info('☀️  Solar monitoring cron job triggered');
        await this.fetchAndStoreSolarEstimates();
      },
      {
        timezone: 'Etc/UTC' // Use UTC timezone for consistency
      }
    );

    // Explicitly start the cron job
    this.cronJob.start();

    this.isInitialized = true;
    logger.info('✅ Solar monitoring service initialized (runs at :05 of every hour)');

    // Run initial fetch
    logger.info('☀️  Running initial solar estimate fetch...');
    this.fetchAndStoreSolarEstimates().catch(err => {
      logger.error('❌ Initial solar fetch failed:', err);
    });
  }

  /**
   * Fetch solar estimates from forecast.solar API and store in database
   */
  private async fetchAndStoreSolarEstimates(): Promise<void> {
    try {
      // Check if solar monitoring is enabled
      const enabled = databaseService.getSetting('solarMonitoringEnabled');
      if (enabled !== '1' && enabled !== 'true') {
        logger.debug('☀️  Solar monitoring is disabled, skipping fetch');
        return;
      }

      // Get configuration from settings
      const latitude = parseFloat(databaseService.getSetting('solarMonitoringLatitude') || '0');
      const longitude = parseFloat(databaseService.getSetting('solarMonitoringLongitude') || '0');
      const declination = parseFloat(databaseService.getSetting('solarMonitoringDeclination') || '0');
      const azimuth = parseFloat(databaseService.getSetting('solarMonitoringAzimuth') || '0');

      // Validate coordinates
      if (latitude === 0 && longitude === 0) {
        logger.warn('⚠️  Solar monitoring coordinates not set, skipping fetch');
        return;
      }

      // Build API URL
      const url = `https://api.forecast.solar/estimate/watthours/period/${latitude}/${longitude}/${declination}/${azimuth}/1`;
      logger.debug(`☀️  Fetching solar estimates from: ${url}`);

      // Fetch data from API
      const response = await fetch(url);
      if (!response.ok) {
        logger.error(`❌ Failed to fetch solar estimates: HTTP ${response.status}`);
        return;
      }

      const data = await response.json() as SolarEstimateResponse;

      // Check for API errors (code 0 = success, non-zero = error)
      if (data.message && data.message.code !== 0) {
        logger.error(`❌ Forecast.solar API error: ${data.message.text} (code: ${data.message.code})`);
        return;
      }

      // Extract result data (this contains the timestamp->watt_hours mapping)
      const estimates = data.result;
      if (!estimates || typeof estimates !== 'object') {
        logger.warn('⚠️  No estimate data in API response');
        return;
      }

      // Store estimates in database using upsert (INSERT OR REPLACE)
      const fetchedAt = Math.floor(Date.now() / 1000); // Unix timestamp
      const stmt = databaseService.db.prepare(`
        INSERT OR REPLACE INTO solar_estimates (timestamp, watt_hours, fetched_at)
        VALUES (?, ?, ?)
      `);

      let count = 0;
      for (const [timestampStr, wattHours] of Object.entries(estimates)) {
        // Parse timestamp (format: "2024-11-05 14:00:00")
        const timestamp = Math.floor(new Date(timestampStr).getTime() / 1000);
        stmt.run(timestamp, wattHours, fetchedAt);
        count++;
      }

      logger.info(`✅ Stored ${count} solar estimates (fetched at ${new Date(fetchedAt * 1000).toISOString()})`);

    } catch (error) {
      logger.error('❌ Error fetching or storing solar estimates:', error);
    }
  }

  /**
   * Stop the solar monitoring service
   */
  stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
      this.isInitialized = false;
      logger.info('🛑 Solar monitoring service stopped');
    }
  }

  /**
   * Manually trigger a solar estimate fetch (for testing)
   */
  async triggerFetch(): Promise<void> {
    logger.info('🔄 Manually triggering solar estimate fetch...');
    await this.fetchAndStoreSolarEstimates();
  }

  /**
   * Get recent solar estimates from database
   */
  getRecentEstimates(limit: number = 100): Array<{ timestamp: number; watt_hours: number; fetched_at: number }> {
    // For PostgreSQL/MySQL, solar estimates not yet implemented
    if (databaseService.drizzleDbType === 'postgres' || databaseService.drizzleDbType === 'mysql') {
      return [];
    }
    try {
      const stmt = databaseService.db.prepare(`
        SELECT timestamp, watt_hours, fetched_at
        FROM solar_estimates
        ORDER BY timestamp DESC
        LIMIT ?
      `);
      return stmt.all(limit) as Array<{ timestamp: number; watt_hours: number; fetched_at: number }>;
    } catch (error) {
      logger.error('❌ Error retrieving solar estimates:', error);
      return [];
    }
  }

  /**
   * Get solar estimates for a specific time range
   */
  getEstimatesInRange(startTimestamp: number, endTimestamp: number): Array<{ timestamp: number; watt_hours: number; fetched_at: number }> {
    // For PostgreSQL/MySQL, solar estimates not yet implemented
    if (databaseService.drizzleDbType === 'postgres' || databaseService.drizzleDbType === 'mysql') {
      return [];
    }
    try {
      const stmt = databaseService.db.prepare(`
        SELECT timestamp, watt_hours, fetched_at
        FROM solar_estimates
        WHERE timestamp >= ? AND timestamp <= ?
        ORDER BY timestamp ASC
      `);
      return stmt.all(startTimestamp, endTimestamp) as Array<{ timestamp: number; watt_hours: number; fetched_at: number }>;
    } catch (error) {
      logger.error('❌ Error retrieving solar estimates in range:', error);
      return [];
    }
  }
}

// Export singleton instance
export const solarMonitoringService = new SolarMonitoringService();
