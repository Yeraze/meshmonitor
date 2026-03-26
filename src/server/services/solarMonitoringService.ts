/**
 * Solar Monitoring Service
 * Handles automated fetching of solar production estimates from forecast.solar API
 * Runs 5 minutes after every hour to retrieve updated estimates
 */

import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { validateCron, scheduleCron, type CronJob } from '../utils/cronScheduler.js';

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
  private cronJob: CronJob | null = null;
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

    if (!validateCron(cronExpression)) {
      logger.error('❌ Invalid cron expression for solar monitoring');
      return;
    }

    this.cronJob = scheduleCron(
      cronExpression,
      async () => {
        logger.info('☀️  Solar monitoring cron job triggered');
        await this.fetchAndStoreSolarEstimates();
      },
      {
        timezone: 'Etc/UTC' // Use UTC timezone for consistency
      }
    );

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
      const enabled = await databaseService.settings.getSetting('solarMonitoringEnabled');
      if (enabled !== '1' && enabled !== 'true') {
        logger.debug('☀️  Solar monitoring is disabled, skipping fetch');
        return;
      }

      // Get configuration from settings
      const latitude = parseFloat(await databaseService.settings.getSetting('solarMonitoringLatitude') || '0');
      const longitude = parseFloat(await databaseService.settings.getSetting('solarMonitoringLongitude') || '0');
      const declination = parseFloat(await databaseService.settings.getSetting('solarMonitoringDeclination') || '0');
      const azimuth = parseFloat(await databaseService.settings.getSetting('solarMonitoringAzimuth') || '0');

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

      // Store estimates in database using async method
      const fetchedAt = Math.floor(Date.now() / 1000); // Unix timestamp

      let count = 0;
      for (const [timestampStr, wattHours] of Object.entries(estimates)) {
        // Parse timestamp (format: "2024-11-05 14:00:00")
        const timestamp = Math.floor(new Date(timestampStr).getTime() / 1000);
        await databaseService.upsertSolarEstimateAsync(timestamp, wattHours, fetchedAt);
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
  async getRecentEstimates(limit: number = 100): Promise<Array<{ timestamp: number; watt_hours: number; fetched_at: number }>> {
    try {
      return await databaseService.getRecentSolarEstimatesAsync(limit);
    } catch (error) {
      logger.error('❌ Error retrieving solar estimates:', error);
      return [];
    }
  }

  /**
   * Get solar estimates for a specific time range
   */
  async getEstimatesInRange(startTimestamp: number, endTimestamp: number): Promise<Array<{ timestamp: number; watt_hours: number; fetched_at: number }>> {
    try {
      return await databaseService.getSolarEstimatesInRangeAsync(startTimestamp, endTimestamp);
    } catch (error) {
      logger.error('❌ Error retrieving solar estimates in range:', error);
      return [];
    }
  }
}

// Export singleton instance
export const solarMonitoringService = new SolarMonitoringService();
