/**
 * News Cache Repository
 *
 * Handles news cache and user news status database operations.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, desc } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

export interface NewsCache {
  id?: number;
  feedData: string; // JSON string of full feed
  fetchedAt: number;
  sourceUrl: string;
}

export interface UserNewsStatus {
  id?: number;
  userId: number;
  lastSeenNewsId?: string | null;
  dismissedNewsIds?: string | null; // JSON array of dismissed news IDs
  updatedAt: number;
}

export class NewsCacheRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  /**
   * Get the cached news feed
   */
  async getNewsCache(): Promise<NewsCache | null> {
    const { newsCache } = this.tables;
    const results = await this.db
      .select()
      .from(newsCache)
      .orderBy(desc(newsCache.fetchedAt))
      .limit(1);
    return results.length > 0 ? this.normalizeBigInts(results[0]) : null;
  }

  /**
   * Save news feed to cache (replaces any existing cache)
   */
  async saveNewsCache(cache: NewsCache): Promise<void> {
    const now = this.now();
    const { newsCache } = this.tables;
    // Delete old cache entries
    await this.db.delete(newsCache);
    // Insert new cache
    await this.db.insert(newsCache).values({
      feedData: cache.feedData,
      fetchedAt: cache.fetchedAt ?? now,
      sourceUrl: cache.sourceUrl,
    });
  }

  /**
   * Get user's news status
   */
  async getUserNewsStatus(userId: number): Promise<UserNewsStatus | null> {
    const { userNewsStatus } = this.tables;
    const results = await this.db
      .select()
      .from(userNewsStatus)
      .where(eq(userNewsStatus.userId, userId))
      .limit(1);
    return results.length > 0 ? this.normalizeBigInts(results[0]) : null;
  }

  /**
   * Save or update user's news status
   */
  async saveUserNewsStatus(status: UserNewsStatus): Promise<void> {
    const now = this.now();
    const { userNewsStatus } = this.tables;

    // Check if exists
    const existing = await this.db
      .select()
      .from(userNewsStatus)
      .where(eq(userNewsStatus.userId, status.userId))
      .limit(1);

    if (existing.length > 0) {
      await this.db
        .update(userNewsStatus)
        .set({
          lastSeenNewsId: status.lastSeenNewsId,
          dismissedNewsIds: status.dismissedNewsIds,
          updatedAt: now,
        })
        .where(eq(userNewsStatus.userId, status.userId));
    } else {
      await this.db.insert(userNewsStatus).values({
        userId: status.userId,
        lastSeenNewsId: status.lastSeenNewsId,
        dismissedNewsIds: status.dismissedNewsIds,
        updatedAt: now,
      });
    }
  }
}
