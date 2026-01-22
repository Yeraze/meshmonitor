/**
 * Misc Repository
 *
 * Handles solar estimates and auto-traceroute nodes database operations.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, desc, asc, and, gte, lte, lt, inArray, sql } from 'drizzle-orm';
import {
  solarEstimatesSqlite,
  solarEstimatesPostgres,
  solarEstimatesMysql,
  autoTracerouteNodesSqlite,
  autoTracerouteNodesPostgres,
  autoTracerouteNodesMysql,
  upgradeHistorySqlite,
  upgradeHistoryPostgres,
  upgradeHistoryMysql,
  newsCacheSqlite,
  newsCachePostgres,
  newsCacheMysql,
  userNewsStatusSqlite,
  userNewsStatusPostgres,
  userNewsStatusMysql,
} from '../schema/misc.js';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

export interface SolarEstimate {
  id?: number;
  timestamp: number;
  watt_hours: number;
  fetched_at: number;
  created_at?: number | null;
}

export interface AutoTracerouteNode {
  id?: number;
  nodeNum: number;
  enabled?: boolean;
  createdAt: number;
}

export interface UpgradeHistoryRecord {
  id: string;
  fromVersion: string;
  toVersion: string;
  deploymentMethod: string;
  status: string;
  progress?: number | null;
  currentStep?: string | null;
  logs?: string | null;
  backupPath?: string | null;
  startedAt?: number | null;
  completedAt?: number | null;
  initiatedBy?: string | null;
  errorMessage?: string | null;
  rollbackAvailable?: boolean | null;
}

export interface NewUpgradeHistory {
  id: string;
  fromVersion: string;
  toVersion: string;
  deploymentMethod: string;
  status: string;
  progress?: number;
  currentStep?: string;
  logs?: string;
  startedAt?: number;
  initiatedBy?: string;
  rollbackAvailable?: boolean;
}

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

/**
 * Repository for miscellaneous operations (solar estimates, auto-traceroute nodes, news)
 */
export class MiscRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  // ============ SOLAR ESTIMATES ============

  /**
   * Upsert a solar estimate (insert or update on conflict)
   */
  async upsertSolarEstimate(estimate: SolarEstimate): Promise<void> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db
        .insert(solarEstimatesSqlite)
        .values({
          timestamp: estimate.timestamp,
          watt_hours: estimate.watt_hours,
          fetched_at: estimate.fetched_at,
          created_at: estimate.created_at ?? this.now(),
        })
        .onConflictDoUpdate({
          target: solarEstimatesSqlite.timestamp,
          set: {
            watt_hours: estimate.watt_hours,
            fetched_at: estimate.fetched_at,
          },
        });
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      await db
        .insert(solarEstimatesMysql)
        .values({
          timestamp: estimate.timestamp,
          watt_hours: estimate.watt_hours,
          fetched_at: estimate.fetched_at,
          created_at: estimate.created_at ?? this.now(),
        })
        .onDuplicateKeyUpdate({
          set: {
            watt_hours: estimate.watt_hours,
            fetched_at: estimate.fetched_at,
          },
        });
    } else {
      const db = this.getPostgresDb();
      await db
        .insert(solarEstimatesPostgres)
        .values({
          timestamp: estimate.timestamp,
          watt_hours: estimate.watt_hours,
          fetched_at: estimate.fetched_at,
          created_at: estimate.created_at ?? this.now(),
        })
        .onConflictDoUpdate({
          target: solarEstimatesPostgres.timestamp,
          set: {
            watt_hours: estimate.watt_hours,
            fetched_at: estimate.fetched_at,
          },
        });
    }
  }

  /**
   * Get recent solar estimates
   */
  async getRecentSolarEstimates(limit: number = 100): Promise<SolarEstimate[]> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const results = await db
        .select()
        .from(solarEstimatesSqlite)
        .orderBy(desc(solarEstimatesSqlite.timestamp))
        .limit(limit);
      return this.normalizeBigInts(results);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const results = await db
        .select()
        .from(solarEstimatesMysql)
        .orderBy(desc(solarEstimatesMysql.timestamp))
        .limit(limit);
      return this.normalizeBigInts(results);
    } else {
      const db = this.getPostgresDb();
      const results = await db
        .select()
        .from(solarEstimatesPostgres)
        .orderBy(desc(solarEstimatesPostgres.timestamp))
        .limit(limit);
      return this.normalizeBigInts(results);
    }
  }

  /**
   * Get solar estimates within a time range
   */
  async getSolarEstimatesInRange(startTimestamp: number, endTimestamp: number): Promise<SolarEstimate[]> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const results = await db
        .select()
        .from(solarEstimatesSqlite)
        .where(
          and(
            gte(solarEstimatesSqlite.timestamp, startTimestamp),
            lte(solarEstimatesSqlite.timestamp, endTimestamp)
          )
        )
        .orderBy(asc(solarEstimatesSqlite.timestamp));
      return this.normalizeBigInts(results);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const results = await db
        .select()
        .from(solarEstimatesMysql)
        .where(
          and(
            gte(solarEstimatesMysql.timestamp, startTimestamp),
            lte(solarEstimatesMysql.timestamp, endTimestamp)
          )
        )
        .orderBy(asc(solarEstimatesMysql.timestamp));
      return this.normalizeBigInts(results);
    } else {
      const db = this.getPostgresDb();
      const results = await db
        .select()
        .from(solarEstimatesPostgres)
        .where(
          and(
            gte(solarEstimatesPostgres.timestamp, startTimestamp),
            lte(solarEstimatesPostgres.timestamp, endTimestamp)
          )
        )
        .orderBy(asc(solarEstimatesPostgres.timestamp));
      return this.normalizeBigInts(results);
    }
  }

  // ============ AUTO-TRACEROUTE NODES ============

  /**
   * Get all auto-traceroute nodes
   */
  async getAutoTracerouteNodes(): Promise<number[]> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const results = await db
        .select({ nodeNum: autoTracerouteNodesSqlite.nodeNum })
        .from(autoTracerouteNodesSqlite)
        .orderBy(asc(autoTracerouteNodesSqlite.createdAt));
      return results.map(r => Number(r.nodeNum));
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const results = await db
        .select({ nodeNum: autoTracerouteNodesMysql.nodeNum })
        .from(autoTracerouteNodesMysql)
        .orderBy(asc(autoTracerouteNodesMysql.createdAt));
      return results.map(r => Number(r.nodeNum));
    } else {
      const db = this.getPostgresDb();
      const results = await db
        .select({ nodeNum: autoTracerouteNodesPostgres.nodeNum })
        .from(autoTracerouteNodesPostgres)
        .orderBy(asc(autoTracerouteNodesPostgres.createdAt));
      return results.map(r => Number(r.nodeNum));
    }
  }

  /**
   * Set auto-traceroute nodes (replaces all existing entries)
   */
  async setAutoTracerouteNodes(nodeNums: number[]): Promise<void> {
    const now = this.now();

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      // Delete all existing entries
      await db.delete(autoTracerouteNodesSqlite);
      // Insert new entries
      for (const nodeNum of nodeNums) {
        await db
          .insert(autoTracerouteNodesSqlite)
          .values({ nodeNum, createdAt: now })
          .onConflictDoNothing();
      }
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      // Delete all existing entries
      await db.delete(autoTracerouteNodesMysql);
      // Insert new entries
      for (const nodeNum of nodeNums) {
        await db
          .insert(autoTracerouteNodesMysql)
          .values({ nodeNum, createdAt: now });
      }
    } else {
      const db = this.getPostgresDb();
      // Delete all existing entries
      await db.delete(autoTracerouteNodesPostgres);
      // Insert new entries
      for (const nodeNum of nodeNums) {
        await db
          .insert(autoTracerouteNodesPostgres)
          .values({ nodeNum, createdAt: now })
          .onConflictDoNothing();
      }
    }
  }

  /**
   * Add a single auto-traceroute node
   */
  async addAutoTracerouteNode(nodeNum: number): Promise<void> {
    const now = this.now();

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db
        .insert(autoTracerouteNodesSqlite)
        .values({ nodeNum, createdAt: now })
        .onConflictDoNothing();
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      // MySQL doesn't have onConflictDoNothing, use INSERT IGNORE via raw
      try {
        await db
          .insert(autoTracerouteNodesMysql)
          .values({ nodeNum, createdAt: now });
      } catch {
        // Ignore duplicate key errors
      }
    } else {
      const db = this.getPostgresDb();
      await db
        .insert(autoTracerouteNodesPostgres)
        .values({ nodeNum, createdAt: now })
        .onConflictDoNothing();
    }
  }

  /**
   * Remove a single auto-traceroute node
   */
  async removeAutoTracerouteNode(nodeNum: number): Promise<void> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db.delete(autoTracerouteNodesSqlite).where(eq(autoTracerouteNodesSqlite.nodeNum, nodeNum));
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      await db.delete(autoTracerouteNodesMysql).where(eq(autoTracerouteNodesMysql.nodeNum, nodeNum));
    } else {
      const db = this.getPostgresDb();
      await db.delete(autoTracerouteNodesPostgres).where(eq(autoTracerouteNodesPostgres.nodeNum, nodeNum));
    }
  }

  // ============ UPGRADE HISTORY ============

  // Status values that indicate an upgrade is in progress
  private readonly IN_PROGRESS_STATUSES = ['pending', 'backing_up', 'downloading', 'restarting', 'health_check'];

  /**
   * Create a new upgrade history record
   */
  async createUpgradeHistory(upgrade: NewUpgradeHistory): Promise<void> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db.insert(upgradeHistorySqlite).values({
        id: upgrade.id,
        fromVersion: upgrade.fromVersion,
        toVersion: upgrade.toVersion,
        deploymentMethod: upgrade.deploymentMethod,
        status: upgrade.status,
        progress: upgrade.progress ?? 0,
        currentStep: upgrade.currentStep,
        logs: upgrade.logs,
        startedAt: upgrade.startedAt,
        initiatedBy: upgrade.initiatedBy,
        rollbackAvailable: upgrade.rollbackAvailable,
      });
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      await db.insert(upgradeHistoryMysql).values({
        id: upgrade.id,
        fromVersion: upgrade.fromVersion,
        toVersion: upgrade.toVersion,
        deploymentMethod: upgrade.deploymentMethod,
        status: upgrade.status,
        progress: upgrade.progress ?? 0,
        currentStep: upgrade.currentStep,
        logs: upgrade.logs,
        startedAt: upgrade.startedAt,
        initiatedBy: upgrade.initiatedBy,
        rollbackAvailable: upgrade.rollbackAvailable,
      });
    } else {
      const db = this.getPostgresDb();
      await db.insert(upgradeHistoryPostgres).values({
        id: upgrade.id,
        fromVersion: upgrade.fromVersion,
        toVersion: upgrade.toVersion,
        deploymentMethod: upgrade.deploymentMethod,
        status: upgrade.status,
        progress: upgrade.progress ?? 0,
        currentStep: upgrade.currentStep,
        logs: upgrade.logs,
        startedAt: upgrade.startedAt,
        initiatedBy: upgrade.initiatedBy,
        rollbackAvailable: upgrade.rollbackAvailable,
      });
    }
  }

  /**
   * Get upgrade history record by ID
   */
  async getUpgradeById(id: string): Promise<UpgradeHistoryRecord | null> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const results = await db
        .select()
        .from(upgradeHistorySqlite)
        .where(eq(upgradeHistorySqlite.id, id))
        .limit(1);
      return results.length > 0 ? this.normalizeBigInts(results[0]) : null;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const results = await db
        .select()
        .from(upgradeHistoryMysql)
        .where(eq(upgradeHistoryMysql.id, id))
        .limit(1);
      return results.length > 0 ? this.normalizeBigInts(results[0]) : null;
    } else {
      const db = this.getPostgresDb();
      const results = await db
        .select()
        .from(upgradeHistoryPostgres)
        .where(eq(upgradeHistoryPostgres.id, id))
        .limit(1);
      return results.length > 0 ? this.normalizeBigInts(results[0]) : null;
    }
  }

  /**
   * Get upgrade history (most recent first)
   */
  async getUpgradeHistoryList(limit: number = 10): Promise<UpgradeHistoryRecord[]> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const results = await db
        .select()
        .from(upgradeHistorySqlite)
        .orderBy(desc(upgradeHistorySqlite.startedAt))
        .limit(limit);
      return this.normalizeBigInts(results);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const results = await db
        .select()
        .from(upgradeHistoryMysql)
        .orderBy(desc(upgradeHistoryMysql.startedAt))
        .limit(limit);
      return this.normalizeBigInts(results);
    } else {
      const db = this.getPostgresDb();
      const results = await db
        .select()
        .from(upgradeHistoryPostgres)
        .orderBy(desc(upgradeHistoryPostgres.startedAt))
        .limit(limit);
      return this.normalizeBigInts(results);
    }
  }

  /**
   * Get the most recent upgrade record
   */
  async getLastUpgrade(): Promise<UpgradeHistoryRecord | null> {
    const results = await this.getUpgradeHistoryList(1);
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Find stale upgrades (stuck for too long)
   */
  async findStaleUpgrades(staleThreshold: number): Promise<UpgradeHistoryRecord[]> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const results = await db
        .select()
        .from(upgradeHistorySqlite)
        .where(
          and(
            inArray(upgradeHistorySqlite.status, this.IN_PROGRESS_STATUSES),
            lt(upgradeHistorySqlite.startedAt, staleThreshold)
          )
        );
      return this.normalizeBigInts(results);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const results = await db
        .select()
        .from(upgradeHistoryMysql)
        .where(
          and(
            inArray(upgradeHistoryMysql.status, this.IN_PROGRESS_STATUSES),
            lt(upgradeHistoryMysql.startedAt, staleThreshold)
          )
        );
      return this.normalizeBigInts(results);
    } else {
      const db = this.getPostgresDb();
      const results = await db
        .select()
        .from(upgradeHistoryPostgres)
        .where(
          and(
            inArray(upgradeHistoryPostgres.status, this.IN_PROGRESS_STATUSES),
            lt(upgradeHistoryPostgres.startedAt, staleThreshold)
          )
        );
      return this.normalizeBigInts(results);
    }
  }

  /**
   * Count in-progress upgrades (non-stale)
   */
  async countInProgressUpgrades(staleThreshold: number): Promise<number> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db
        .select({ count: sql<number>`count(*)` })
        .from(upgradeHistorySqlite)
        .where(
          and(
            inArray(upgradeHistorySqlite.status, this.IN_PROGRESS_STATUSES),
            gte(upgradeHistorySqlite.startedAt, staleThreshold)
          )
        );
      return Number(result[0]?.count ?? 0);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db
        .select({ count: sql<number>`count(*)` })
        .from(upgradeHistoryMysql)
        .where(
          and(
            inArray(upgradeHistoryMysql.status, this.IN_PROGRESS_STATUSES),
            gte(upgradeHistoryMysql.startedAt, staleThreshold)
          )
        );
      return Number(result[0]?.count ?? 0);
    } else {
      const db = this.getPostgresDb();
      const result = await db
        .select({ count: sql<number>`count(*)` })
        .from(upgradeHistoryPostgres)
        .where(
          and(
            inArray(upgradeHistoryPostgres.status, this.IN_PROGRESS_STATUSES),
            gte(upgradeHistoryPostgres.startedAt, staleThreshold)
          )
        );
      return Number(result[0]?.count ?? 0);
    }
  }

  /**
   * Find the currently active upgrade (if any)
   */
  async findActiveUpgrade(staleThreshold: number): Promise<UpgradeHistoryRecord | null> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const results = await db
        .select()
        .from(upgradeHistorySqlite)
        .where(
          and(
            inArray(upgradeHistorySqlite.status, this.IN_PROGRESS_STATUSES),
            gte(upgradeHistorySqlite.startedAt, staleThreshold)
          )
        )
        .orderBy(desc(upgradeHistorySqlite.startedAt))
        .limit(1);
      return results.length > 0 ? this.normalizeBigInts(results[0]) : null;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const results = await db
        .select()
        .from(upgradeHistoryMysql)
        .where(
          and(
            inArray(upgradeHistoryMysql.status, this.IN_PROGRESS_STATUSES),
            gte(upgradeHistoryMysql.startedAt, staleThreshold)
          )
        )
        .orderBy(desc(upgradeHistoryMysql.startedAt))
        .limit(1);
      return results.length > 0 ? this.normalizeBigInts(results[0]) : null;
    } else {
      const db = this.getPostgresDb();
      const results = await db
        .select()
        .from(upgradeHistoryPostgres)
        .where(
          and(
            inArray(upgradeHistoryPostgres.status, this.IN_PROGRESS_STATUSES),
            gte(upgradeHistoryPostgres.startedAt, staleThreshold)
          )
        )
        .orderBy(desc(upgradeHistoryPostgres.startedAt))
        .limit(1);
      return results.length > 0 ? this.normalizeBigInts(results[0]) : null;
    }
  }

  /**
   * Mark an upgrade as failed
   */
  async markUpgradeFailed(id: string, errorMessage: string): Promise<void> {
    const now = this.now();
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db
        .update(upgradeHistorySqlite)
        .set({
          status: 'failed',
          completedAt: now,
          errorMessage: errorMessage,
        })
        .where(eq(upgradeHistorySqlite.id, id));
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      await db
        .update(upgradeHistoryMysql)
        .set({
          status: 'failed',
          completedAt: now,
          errorMessage: errorMessage,
        })
        .where(eq(upgradeHistoryMysql.id, id));
    } else {
      const db = this.getPostgresDb();
      await db
        .update(upgradeHistoryPostgres)
        .set({
          status: 'failed',
          completedAt: now,
          errorMessage: errorMessage,
        })
        .where(eq(upgradeHistoryPostgres.id, id));
    }
  }

  /**
   * Mark an upgrade as complete
   */
  async markUpgradeComplete(id: string): Promise<void> {
    const now = this.now();
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db
        .update(upgradeHistorySqlite)
        .set({
          status: 'complete',
          completedAt: now,
          currentStep: 'Upgrade complete',
        })
        .where(eq(upgradeHistorySqlite.id, id));
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      await db
        .update(upgradeHistoryMysql)
        .set({
          status: 'complete',
          completedAt: now,
          currentStep: 'Upgrade complete',
        })
        .where(eq(upgradeHistoryMysql.id, id));
    } else {
      const db = this.getPostgresDb();
      await db
        .update(upgradeHistoryPostgres)
        .set({
          status: 'complete',
          completedAt: now,
          currentStep: 'Upgrade complete',
        })
        .where(eq(upgradeHistoryPostgres.id, id));
    }
  }

  // ============ NEWS CACHE ============

  /**
   * Get the cached news feed
   */
  async getNewsCache(): Promise<NewsCache | null> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const results = await db
        .select()
        .from(newsCacheSqlite)
        .orderBy(desc(newsCacheSqlite.fetchedAt))
        .limit(1);
      return results.length > 0 ? this.normalizeBigInts(results[0]) : null;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const results = await db
        .select()
        .from(newsCacheMysql)
        .orderBy(desc(newsCacheMysql.fetchedAt))
        .limit(1);
      return results.length > 0 ? this.normalizeBigInts(results[0]) : null;
    } else {
      const db = this.getPostgresDb();
      const results = await db
        .select()
        .from(newsCachePostgres)
        .orderBy(desc(newsCachePostgres.fetchedAt))
        .limit(1);
      return results.length > 0 ? this.normalizeBigInts(results[0]) : null;
    }
  }

  /**
   * Save news feed to cache (replaces any existing cache)
   */
  async saveNewsCache(cache: NewsCache): Promise<void> {
    const now = this.now();
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      // Delete old cache entries
      await db.delete(newsCacheSqlite);
      // Insert new cache
      await db.insert(newsCacheSqlite).values({
        feedData: cache.feedData,
        fetchedAt: cache.fetchedAt ?? now,
        sourceUrl: cache.sourceUrl,
      });
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      await db.delete(newsCacheMysql);
      await db.insert(newsCacheMysql).values({
        feedData: cache.feedData,
        fetchedAt: cache.fetchedAt ?? now,
        sourceUrl: cache.sourceUrl,
      });
    } else {
      const db = this.getPostgresDb();
      await db.delete(newsCachePostgres);
      await db.insert(newsCachePostgres).values({
        feedData: cache.feedData,
        fetchedAt: cache.fetchedAt ?? now,
        sourceUrl: cache.sourceUrl,
      });
    }
  }

  // ============ USER NEWS STATUS ============

  /**
   * Get user's news status
   */
  async getUserNewsStatus(userId: number): Promise<UserNewsStatus | null> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const results = await db
        .select()
        .from(userNewsStatusSqlite)
        .where(eq(userNewsStatusSqlite.userId, userId))
        .limit(1);
      return results.length > 0 ? this.normalizeBigInts(results[0]) : null;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const results = await db
        .select()
        .from(userNewsStatusMysql)
        .where(eq(userNewsStatusMysql.userId, userId))
        .limit(1);
      return results.length > 0 ? this.normalizeBigInts(results[0]) : null;
    } else {
      const db = this.getPostgresDb();
      const results = await db
        .select()
        .from(userNewsStatusPostgres)
        .where(eq(userNewsStatusPostgres.userId, userId))
        .limit(1);
      return results.length > 0 ? this.normalizeBigInts(results[0]) : null;
    }
  }

  /**
   * Save or update user's news status
   */
  async saveUserNewsStatus(status: UserNewsStatus): Promise<void> {
    const now = this.now();
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      // Check if exists
      const existing = await db
        .select()
        .from(userNewsStatusSqlite)
        .where(eq(userNewsStatusSqlite.userId, status.userId))
        .limit(1);

      if (existing.length > 0) {
        await db
          .update(userNewsStatusSqlite)
          .set({
            lastSeenNewsId: status.lastSeenNewsId,
            dismissedNewsIds: status.dismissedNewsIds,
            updatedAt: now,
          })
          .where(eq(userNewsStatusSqlite.userId, status.userId));
      } else {
        await db.insert(userNewsStatusSqlite).values({
          userId: status.userId,
          lastSeenNewsId: status.lastSeenNewsId,
          dismissedNewsIds: status.dismissedNewsIds,
          updatedAt: now,
        });
      }
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const existing = await db
        .select()
        .from(userNewsStatusMysql)
        .where(eq(userNewsStatusMysql.userId, status.userId))
        .limit(1);

      if (existing.length > 0) {
        await db
          .update(userNewsStatusMysql)
          .set({
            lastSeenNewsId: status.lastSeenNewsId,
            dismissedNewsIds: status.dismissedNewsIds,
            updatedAt: now,
          })
          .where(eq(userNewsStatusMysql.userId, status.userId));
      } else {
        await db.insert(userNewsStatusMysql).values({
          userId: status.userId,
          lastSeenNewsId: status.lastSeenNewsId,
          dismissedNewsIds: status.dismissedNewsIds,
          updatedAt: now,
        });
      }
    } else {
      const db = this.getPostgresDb();
      const existing = await db
        .select()
        .from(userNewsStatusPostgres)
        .where(eq(userNewsStatusPostgres.userId, status.userId))
        .limit(1);

      if (existing.length > 0) {
        await db
          .update(userNewsStatusPostgres)
          .set({
            lastSeenNewsId: status.lastSeenNewsId,
            dismissedNewsIds: status.dismissedNewsIds,
            updatedAt: now,
          })
          .where(eq(userNewsStatusPostgres.userId, status.userId));
      } else {
        await db.insert(userNewsStatusPostgres).values({
          userId: status.userId,
          lastSeenNewsId: status.lastSeenNewsId,
          dismissedNewsIds: status.dismissedNewsIds,
          updatedAt: now,
        });
      }
    }
  }
}
