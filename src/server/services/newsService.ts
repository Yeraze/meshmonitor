/**
 * News Service
 *
 * Fetches and caches news from meshmonitor.org on a scheduled basis.
 * The news is shown to users via a popup after login.
 */

import * as cron from 'node-cron';
import { createRequire } from 'module';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';

const require = createRequire(import.meta.url);
const appVersion: string = require('../../../package.json').version;

// News feed types
export interface NewsItem {
  id: string;
  title: string;
  content: string;
  date: string;
  category: 'release' | 'security' | 'feature' | 'maintenance';
  priority: 'normal' | 'important';
  minVersion?: string;
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
   * Compare semver versions. Returns true if current >= required.
   */
  private isVersionAtLeast(current: string, required: string): boolean {
    const parse = (v: string) => v.split('.').map(Number);
    const cur = parse(current);
    const req = parse(required);
    for (let i = 0; i < Math.max(cur.length, req.length); i++) {
      const c = cur[i] || 0;
      const r = req[i] || 0;
      if (c > r) return true;
      if (c < r) return false;
    }
    return true; // equal
  }

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

      // Filter out items that require a newer version than currently installed
      feed.items = feed.items.filter(item =>
        !item.minVersion || this.isVersionAtLeast(appVersion, item.minVersion)
      );

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
   * Returns news items that the user hasn't dismissed and are newer than lastSeenNewsId
   */
  async getUnreadNewsForUser(userId: number): Promise<NewsItem[]> {
    try {
      const feed = await this.getCachedNews();
      if (!feed || !feed.items || feed.items.length === 0) {
        return [];
      }

      const userStatus = await this.getUserNewsStatus(userId);
      const dismissedIds = new Set(userStatus?.dismissedNewsIds || []);

      // Find the date of the lastSeenNewsId item to filter out older items
      let lastSeenDate: Date | null = null;
      if (userStatus?.lastSeenNewsId) {
        const lastSeenItem = feed.items.find(item => item.id === userStatus.lastSeenNewsId);
        if (lastSeenItem) {
          lastSeenDate = new Date(lastSeenItem.date);
        }
      }

      // Filter items: show if newer than lastSeenDate OR important (unless dismissed)
      return feed.items.filter(item => {
        // Hide dismissed items
        if (dismissedIds.has(item.id)) {
          return false;
        }
        // Always show important items that aren't dismissed
        if (item.priority === 'important') {
          return true;
        }
        // If we have a lastSeenDate, only show items newer than that
        if (lastSeenDate) {
          const itemDate = new Date(item.date);
          return itemDate > lastSeenDate;
        }
        // No lastSeenDate means show all non-dismissed items (first time user)
        return true;
      });
    } catch (error) {
      logger.error('Error getting unread news for user:', error);
      return [];
    }
  }
}

// Export singleton instance
export const newsService = new NewsService();
export default newsService;
