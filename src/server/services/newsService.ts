/**
 * News Service
 *
 * Fetches and caches news from meshmonitor.org on a scheduled basis.
 * The news is shown to users via a popup after login.
 */

import * as cron from 'node-cron';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';

// News feed types
export interface NewsItem {
  id: string;
  title: string;
  content: string;
  date: string;
  category: 'release' | 'security' | 'feature' | 'maintenance';
  priority: 'normal' | 'important';
}

export interface NewsFeed {
  version: string;
  lastUpdated: string;
  items: NewsItem[];
}

const DEFAULT_NEWS_URL = 'https://meshmonitor.org/news.json';

class NewsService {
  private cronJob: cron.ScheduledTask | null = null;
  private isInitialized = false;

  /**
   * Initialize the news service
   * Sets up the cron job to fetch news every 6 hours
   */
  initialize(): void {
    if (this.isInitialized) {
      logger.warn('News service is already initialized');
      return;
    }

    // Schedule to run every 6 hours (cron: "0 */6 * * *")
    const cronExpression = '0 */6 * * *';

    if (!cron.validate(cronExpression)) {
      logger.error('Invalid cron expression for news service');
      return;
    }

    this.cronJob = cron.schedule(
      cronExpression,
      async () => {
        logger.info('News service cron job triggered');
        await this.fetchAndCacheNews();
      },
      {
        timezone: 'Etc/UTC'
      }
    );

    // Explicitly start the cron job
    this.cronJob.start();

    this.isInitialized = true;
    logger.info('News service initialized (runs every 6 hours)');

    // Run initial fetch
    logger.info('Running initial news fetch...');
    this.fetchAndCacheNews().catch(err => {
      logger.error('Initial news fetch failed:', err);
    });
  }

  /**
   * Fetch news from the configured URL and store in database
   */
  async fetchAndCacheNews(): Promise<void> {
    try {
      const url = process.env.NEWS_FEED_URL || DEFAULT_NEWS_URL;
      logger.debug(`Fetching news from: ${url}`);

      const response = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'MeshMonitor News Service'
        },
        signal: AbortSignal.timeout(30000) // 30 second timeout
      });

      if (!response.ok) {
        logger.error(`Failed to fetch news: HTTP ${response.status}`);
        return;
      }

      const data = await response.json() as NewsFeed;

      // Validate the feed structure
      if (!data || !data.items || !Array.isArray(data.items)) {
        logger.warn('Invalid news feed structure');
        return;
      }

      // Store in database
      await databaseService.saveNewsCacheAsync(JSON.stringify(data), url);

      logger.info(`Stored news feed with ${data.items.length} items`);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        logger.error('News fetch timed out');
      } else {
        logger.error('Error fetching or storing news:', error);
      }
    }
  }

  /**
   * Stop the news service
   */
  stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
      this.isInitialized = false;
      logger.info('News service stopped');
    }
  }

  /**
   * Manually trigger a news fetch (for testing)
   */
  async triggerFetch(): Promise<void> {
    logger.info('Manually triggering news fetch...');
    await this.fetchAndCacheNews();
  }

  /**
   * Get cached news feed from database
   */
  async getCachedNews(): Promise<NewsFeed | null> {
    try {
      const cache = await databaseService.getNewsCacheAsync();
      if (!cache) {
        return null;
      }

      const feed = JSON.parse(cache.feedData) as NewsFeed;
      return feed;
    } catch (error) {
      logger.error('Error retrieving cached news:', error);
      return null;
    }
  }

  /**
   * Get user's news status
   */
  async getUserNewsStatus(userId: number): Promise<{ lastSeenNewsId: string | null; dismissedNewsIds: string[] } | null> {
    try {
      return await databaseService.getUserNewsStatusAsync(userId);
    } catch (error) {
      logger.error('Error retrieving user news status:', error);
      return null;
    }
  }

  /**
   * Update user's news status
   */
  async saveUserNewsStatus(userId: number, lastSeenNewsId: string | null, dismissedNewsIds: string[]): Promise<void> {
    try {
      await databaseService.saveUserNewsStatusAsync(userId, lastSeenNewsId, dismissedNewsIds);
    } catch (error) {
      logger.error('Error saving user news status:', error);
      throw error;
    }
  }

  /**
   * Get unread news for a user
   * Returns news items that the user hasn't dismissed
   */
  async getUnreadNewsForUser(userId: number): Promise<NewsItem[]> {
    try {
      const feed = await this.getCachedNews();
      if (!feed || !feed.items || feed.items.length === 0) {
        return [];
      }

      const userStatus = await this.getUserNewsStatus(userId);
      const dismissedIds = new Set(userStatus?.dismissedNewsIds || []);

      // Filter out dismissed items
      return feed.items.filter(item => !dismissedIds.has(item.id));
    } catch (error) {
      logger.error('Error getting unread news for user:', error);
      return [];
    }
  }
}

// Export singleton instance
export const newsService = new NewsService();
export default newsService;
