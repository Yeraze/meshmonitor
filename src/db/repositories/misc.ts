/**
 * Misc Repository
 *
 * Handles solar estimates and auto-traceroute nodes database operations.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, desc, asc, and, or, gte, lte, lt, inArray, notInArray, sql, isNull } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType, DbCustomTheme, DbPacketLog, DbPacketCountByNode, DbPacketCountByPortnum, DbDistinctRelayNode } from '../types.js';
import { logger } from '../../utils/logger.js';
import { getPortNumName } from '../../server/constants/meshtastic.js';

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

export interface BackupHistory {
  id?: number;
  nodeId?: string | null;
  nodeNum?: number | null;
  filename: string;
  filePath: string;
  fileSize?: number | null;
  backupType: string;  // 'auto' or 'manual'
  timestamp: number;
  createdAt: number;
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
   * Upsert a solar estimate (insert or update on conflict).
   * Keeps branching: MySQL uses onDuplicateKeyUpdate vs onConflictDoUpdate.
   */
  async upsertSolarEstimate(estimate: SolarEstimate): Promise<void> {
    const { solarEstimates } = this.tables;
    const values = {
      timestamp: estimate.timestamp,
      watt_hours: estimate.watt_hours,
      fetched_at: estimate.fetched_at,
      created_at: estimate.created_at ?? this.now(),
    };
    const setData = {
      watt_hours: estimate.watt_hours,
      fetched_at: estimate.fetched_at,
    };

    await this.upsert(solarEstimates, values, solarEstimates.timestamp, setData);
  }

  /**
   * Get recent solar estimates
   */
  async getRecentSolarEstimates(limit: number = 100): Promise<SolarEstimate[]> {
    const { solarEstimates } = this.tables;
    const results = await this.db
      .select()
      .from(solarEstimates)
      .orderBy(desc(solarEstimates.timestamp))
      .limit(limit);
    return this.normalizeBigInts(results);
  }

  /**
   * Get solar estimates within a time range
   */
  async getSolarEstimatesInRange(startTimestamp: number, endTimestamp: number): Promise<SolarEstimate[]> {
    const { solarEstimates } = this.tables;
    const results = await this.db
      .select()
      .from(solarEstimates)
      .where(
        and(
          gte(solarEstimates.timestamp, startTimestamp),
          lte(solarEstimates.timestamp, endTimestamp)
        )
      )
      .orderBy(asc(solarEstimates.timestamp));
    return this.normalizeBigInts(results);
  }

  // ============ AUTO-TRACEROUTE NODES ============

  /**
   * Get all auto-traceroute nodes.
   * When sourceId is provided, return only rows scoped to that source OR
   * legacy unscoped rows (sourceId IS NULL). When omitted, return everything.
   */
  async getAutoTracerouteNodes(sourceId?: string): Promise<number[]> {
    const { autoTracerouteNodes } = this.tables;
    const query = this.db
      .select({ nodeNum: autoTracerouteNodes.nodeNum })
      .from(autoTracerouteNodes);
    const results = sourceId
      ? await query
          .where(eq(autoTracerouteNodes.sourceId, sourceId))
          .orderBy(asc(autoTracerouteNodes.createdAt))
      : await query.orderBy(asc(autoTracerouteNodes.createdAt));
    return results.map((r: any) => Number(r.nodeNum));
  }

  /**
   * Set auto-traceroute nodes (replaces all existing entries for the given
   * source, or globally when sourceId is omitted).
   */
  async setAutoTracerouteNodes(nodeNums: number[], sourceId?: string): Promise<void> {
    const now = this.now();
    const { autoTracerouteNodes } = this.tables;

    // Delete existing entries scoped to this source (or all when unscoped).
    if (sourceId) {
      await this.db
        .delete(autoTracerouteNodes)
        .where(eq(autoTracerouteNodes.sourceId, sourceId));
    } else {
      await this.db.delete(autoTracerouteNodes);
    }
    // Insert new entries
    for (const nodeNum of nodeNums) {
      await this.db
        .insert(autoTracerouteNodes)
        .values({ nodeNum, createdAt: now, sourceId: sourceId ?? null });
    }
  }

  /**
   * Add a single auto-traceroute node.
   * Keeps branching: MySQL lacks onConflictDoNothing.
   */
  async addAutoTracerouteNode(nodeNum: number, sourceId?: string): Promise<void> {
    const now = this.now();
    const { autoTracerouteNodes } = this.tables;

    // Pre-check for the (nodeNum, sourceId) tuple. Needed because SQLite/MySQL
    // treat NULL as distinct in UNIQUE constraints, so insertIgnore would
    // allow duplicate unscoped rows.
    const whereClause = sourceId
      ? and(eq(autoTracerouteNodes.nodeNum, nodeNum), eq(autoTracerouteNodes.sourceId, sourceId))
      : and(eq(autoTracerouteNodes.nodeNum, nodeNum), isNull(autoTracerouteNodes.sourceId));
    const existing = await this.db
      .select({ id: autoTracerouteNodes.id })
      .from(autoTracerouteNodes)
      .where(whereClause)
      .limit(1);
    if (existing.length > 0) return;

    await this.insertIgnore(autoTracerouteNodes, {
      nodeNum,
      createdAt: now,
      sourceId: sourceId ?? null,
    });
  }

  /**
   * Remove a single auto-traceroute node
   */
  async removeAutoTracerouteNode(nodeNum: number, sourceId?: string): Promise<void> {
    const { autoTracerouteNodes } = this.tables;
    const where = sourceId
      ? and(
          eq(autoTracerouteNodes.nodeNum, nodeNum),
          eq(autoTracerouteNodes.sourceId, sourceId)
        )
      : eq(autoTracerouteNodes.nodeNum, nodeNum);
    await this.db.delete(autoTracerouteNodes).where(where);
  }

  // ============ UPGRADE HISTORY ============

  // Status values that indicate an upgrade is in progress
  private readonly IN_PROGRESS_STATUSES = ['pending', 'backing_up', 'downloading', 'restarting', 'health_check'];

  /**
   * Create a new upgrade history record
   */
  async createUpgradeHistory(upgrade: NewUpgradeHistory): Promise<void> {
    const { upgradeHistory } = this.tables;
    await this.db.insert(upgradeHistory).values({
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

  /**
   * Get upgrade history record by ID
   */
  async getUpgradeById(id: string): Promise<UpgradeHistoryRecord | null> {
    const { upgradeHistory } = this.tables;
    const results = await this.db
      .select()
      .from(upgradeHistory)
      .where(eq(upgradeHistory.id, id))
      .limit(1);
    return results.length > 0 ? this.normalizeBigInts(results[0]) : null;
  }

  /**
   * Get upgrade history (most recent first)
   */
  async getUpgradeHistoryList(limit: number = 10): Promise<UpgradeHistoryRecord[]> {
    const { upgradeHistory } = this.tables;
    const results = await this.db
      .select()
      .from(upgradeHistory)
      .orderBy(desc(upgradeHistory.startedAt))
      .limit(limit);
    return this.normalizeBigInts(results);
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
    const { upgradeHistory } = this.tables;
    const results = await this.db
      .select()
      .from(upgradeHistory)
      .where(
        and(
          inArray(upgradeHistory.status, this.IN_PROGRESS_STATUSES),
          lt(upgradeHistory.startedAt, staleThreshold)
        )
      );
    return this.normalizeBigInts(results);
  }

  /**
   * Count in-progress upgrades (non-stale)
   */
  async countInProgressUpgrades(staleThreshold: number): Promise<number> {
    const { upgradeHistory } = this.tables;
    const result = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(upgradeHistory)
      .where(
        and(
          inArray(upgradeHistory.status, this.IN_PROGRESS_STATUSES),
          gte(upgradeHistory.startedAt, staleThreshold)
        )
      );
    return Number(result[0]?.count ?? 0);
  }

  /**
   * Find the currently active upgrade (if any)
   */
  async findActiveUpgrade(staleThreshold: number): Promise<UpgradeHistoryRecord | null> {
    const { upgradeHistory } = this.tables;
    const results = await this.db
      .select()
      .from(upgradeHistory)
      .where(
        and(
          inArray(upgradeHistory.status, this.IN_PROGRESS_STATUSES),
          gte(upgradeHistory.startedAt, staleThreshold)
        )
      )
      .orderBy(desc(upgradeHistory.startedAt))
      .limit(1);
    return results.length > 0 ? this.normalizeBigInts(results[0]) : null;
  }

  /**
   * Mark an upgrade as failed
   */
  async markUpgradeFailed(id: string, errorMessage: string): Promise<void> {
    const now = this.now();
    const { upgradeHistory } = this.tables;
    await this.db
      .update(upgradeHistory)
      .set({
        status: 'failed',
        completedAt: now,
        errorMessage: errorMessage,
      })
      .where(eq(upgradeHistory.id, id));
  }

  /**
   * Mark an upgrade as complete
   */
  async markUpgradeComplete(id: string): Promise<void> {
    const now = this.now();
    const { upgradeHistory } = this.tables;
    await this.db
      .update(upgradeHistory)
      .set({
        status: 'complete',
        completedAt: now,
        currentStep: 'Upgrade complete',
      })
      .where(eq(upgradeHistory.id, id));
  }

  /**
   * Count consecutive failed upgrades from most recent backwards.
   * Stops counting at the first non-failed (e.g. 'complete') row.
   * Used by the auto-upgrade circuit breaker to halt repeated retries
   * when something is structurally wrong (e.g. pinned image tag).
   */
  async countConsecutiveFailedUpgrades(): Promise<number> {
    const { upgradeHistory } = this.tables;
    const rows = await this.db
      .select({ status: upgradeHistory.status })
      .from(upgradeHistory)
      .orderBy(desc(upgradeHistory.startedAt))
      .limit(50);
    let count = 0;
    for (const row of rows) {
      if (row.status === 'failed') {
        count++;
      } else {
        break;
      }
    }
    return count;
  }

  // ============ NEWS CACHE ============

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

  // ============ USER NEWS STATUS ============

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

  // ============ BACKUP HISTORY ============

  /**
   * Insert a new backup history record
   */
  async insertBackupHistory(backup: BackupHistory): Promise<void> {
    const { backupHistory } = this.tables;
    await this.db.insert(backupHistory).values({
      nodeId: backup.nodeId,
      nodeNum: backup.nodeNum,
      filename: backup.filename,
      filePath: backup.filePath,
      fileSize: backup.fileSize,
      backupType: backup.backupType,
      timestamp: backup.timestamp,
      createdAt: backup.createdAt,
    });
  }

  /**
   * Get all backup history records ordered by timestamp (newest first)
   */
  async getBackupHistoryList(): Promise<BackupHistory[]> {
    const { backupHistory } = this.tables;
    const results = await this.db
      .select()
      .from(backupHistory)
      .orderBy(desc(backupHistory.timestamp));
    return this.normalizeBigInts(results);
  }

  /**
   * Get a backup history record by filename
   */
  async getBackupByFilename(filename: string): Promise<BackupHistory | null> {
    const { backupHistory } = this.tables;
    const results = await this.db
      .select()
      .from(backupHistory)
      .where(eq(backupHistory.filename, filename))
      .limit(1);
    return results.length > 0 ? this.normalizeBigInts(results[0]) : null;
  }

  /**
   * Delete a backup history record by filename
   */
  async deleteBackupHistory(filename: string): Promise<void> {
    const { backupHistory } = this.tables;
    await this.db.delete(backupHistory).where(eq(backupHistory.filename, filename));
  }

  /**
   * Count total backup history records
   */
  async countBackups(): Promise<number> {
    const { backupHistory } = this.tables;
    const result = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(backupHistory);
    return Number(result[0]?.count ?? 0);
  }

  /**
   * Get oldest backup history records (for purging)
   */
  async getOldestBackups(limit: number): Promise<BackupHistory[]> {
    const { backupHistory } = this.tables;
    const results = await this.db
      .select()
      .from(backupHistory)
      .orderBy(asc(backupHistory.timestamp))
      .limit(limit);
    return this.normalizeBigInts(results);
  }

  /**
   * Get backup statistics
   */
  async getBackupStats(): Promise<{ count: number; totalSize: number; oldestTimestamp: number | null; newestTimestamp: number | null }> {
    const { backupHistory } = this.tables;
    const result = await this.db
      .select({
        count: sql<number>`count(*)`,
        totalSize: sql<number>`coalesce(sum(${backupHistory.fileSize}), 0)`,
        oldestTimestamp: sql<number>`min(${backupHistory.timestamp})`,
        newestTimestamp: sql<number>`max(${backupHistory.timestamp})`,
      })
      .from(backupHistory);
    const row = result[0];
    return {
      count: Number(row?.count ?? 0),
      totalSize: Number(row?.totalSize ?? 0),
      oldestTimestamp: row?.oldestTimestamp ? Number(row.oldestTimestamp) : null,
      newestTimestamp: row?.newestTimestamp ? Number(row.newestTimestamp) : null,
    };
  }

  // ============ AUTO TIME SYNC NODES ============

  /**
   * Get all auto time sync nodes.
   * When sourceId is provided, return only rows scoped to that source.
   * When omitted, return everything.
   */
  async getAutoTimeSyncNodes(sourceId?: string): Promise<number[]> {
    const { autoTimeSyncNodes } = this.tables;
    const query = this.db
      .select({ nodeNum: autoTimeSyncNodes.nodeNum })
      .from(autoTimeSyncNodes);
    const results = sourceId
      ? await query
          .where(eq(autoTimeSyncNodes.sourceId, sourceId))
          .orderBy(asc(autoTimeSyncNodes.createdAt))
      : await query.orderBy(asc(autoTimeSyncNodes.createdAt));
    return results.map((r: any) => Number(r.nodeNum));
  }

  /**
   * Set auto time sync nodes (replaces all existing entries for the given
   * source, or globally when sourceId is omitted).
   */
  async setAutoTimeSyncNodes(nodeNums: number[], sourceId?: string): Promise<void> {
    const now = this.now();
    const { autoTimeSyncNodes } = this.tables;

    // Delete existing entries scoped to this source (or all when unscoped).
    if (sourceId) {
      await this.db
        .delete(autoTimeSyncNodes)
        .where(eq(autoTimeSyncNodes.sourceId, sourceId));
    } else {
      await this.db.delete(autoTimeSyncNodes);
    }
    // Insert new entries
    for (const nodeNum of nodeNums) {
      await this.db
        .insert(autoTimeSyncNodes)
        .values({ nodeNum, createdAt: now, sourceId: sourceId ?? null });
    }
  }

  /**
   * Add a single auto time sync node.
   * Keeps branching: MySQL lacks onConflictDoNothing.
   */
  async addAutoTimeSyncNode(nodeNum: number, sourceId?: string): Promise<void> {
    const now = this.now();
    const { autoTimeSyncNodes } = this.tables;

    await this.insertIgnore(autoTimeSyncNodes, {
      nodeNum,
      createdAt: now,
      sourceId: sourceId ?? null,
    });
  }

  /**
   * Remove a single auto time sync node
   */
  async removeAutoTimeSyncNode(nodeNum: number, sourceId?: string): Promise<void> {
    const { autoTimeSyncNodes } = this.tables;
    const where = sourceId
      ? and(
          eq(autoTimeSyncNodes.nodeNum, nodeNum),
          eq(autoTimeSyncNodes.sourceId, sourceId)
        )
      : eq(autoTimeSyncNodes.nodeNum, nodeNum);
    await this.db.delete(autoTimeSyncNodes).where(where);
  }

  // ============ CUSTOM THEMES ============

  /**
   * Normalize a raw theme row into DbCustomTheme format.
   * Ensures is_builtin is coerced to 0/1 for consistency across dialects.
   */
  private normalizeThemeRow(row: any): DbCustomTheme {
    return {
      id: Number(row.id),
      name: row.name,
      slug: row.slug,
      definition: row.definition,
      is_builtin: row.is_builtin ? 1 : 0,
      created_by: row.created_by != null ? Number(row.created_by) : undefined,
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
    };
  }

  /**
   * Get all custom themes ordered by name
   */
  async getAllCustomThemes(): Promise<DbCustomTheme[]> {
    const { customThemes } = this.tables;
    try {
      const results = await this.db
        .select()
        .from(customThemes)
        .orderBy(asc(customThemes.name));
      return results.map((row: any) => this.normalizeThemeRow(row));
    } catch (error) {
      logger.error('[MiscRepository] Failed to get custom themes:', error);
      throw error;
    }
  }

  /**
   * Get a specific custom theme by slug
   */
  async getCustomThemeBySlug(slug: string): Promise<DbCustomTheme | undefined> {
    const { customThemes } = this.tables;
    try {
      const results = await this.db
        .select()
        .from(customThemes)
        .where(eq(customThemes.slug, slug))
        .limit(1);
      if (results.length === 0) return undefined;
      return this.normalizeThemeRow(results[0]);
    } catch (error) {
      logger.error(`[MiscRepository] Failed to get custom theme ${slug}:`, error);
      throw error;
    }
  }

  /**
   * Create a new custom theme
   */
  async createCustomTheme(name: string, slug: string, definitionJson: string, userId?: number): Promise<DbCustomTheme> {
    const now = Math.floor(Date.now() / 1000);
    const { customThemes } = this.tables;

    try {
      if (this.isMySQL()) {
        // MySQL: use raw query for RETURNING-like behavior via insertId
        const db = this.getMysqlDb();
        const result = await db
          .insert(customThemes)
          .values({
            name,
            slug,
            definition: definitionJson,
            is_builtin: false,
            created_by: userId ?? null,
            created_at: now,
            updated_at: now,
          });
        const id = Number((result as any)[0].insertId);
        logger.debug(`[MiscRepository] Created custom theme: ${name} (slug: ${slug})`);
        return { id, name, slug, definition: definitionJson, is_builtin: 0, created_by: userId, created_at: now, updated_at: now };
      } else if (this.isPostgres()) {
        // PostgreSQL: use returning()
        const db = this.getPostgresDb();
        const result = await db
          .insert(customThemes)
          .values({
            name,
            slug,
            definition: definitionJson,
            is_builtin: false,
            created_by: userId ?? null,
            created_at: now,
            updated_at: now,
          })
          .returning({ id: customThemes.id });
        const id = Number(result[0].id);
        logger.debug(`[MiscRepository] Created custom theme: ${name} (slug: ${slug})`);
        return { id, name, slug, definition: definitionJson, is_builtin: 0, created_by: userId, created_at: now, updated_at: now };
      } else {
        // SQLite: use returning()
        const db = this.getSqliteDb();
        const result = await db
          .insert(customThemes)
          .values({
            name,
            slug,
            definition: definitionJson,
            is_builtin: false,
            created_by: userId ?? null,
            created_at: now,
            updated_at: now,
          })
          .returning({ id: customThemes.id });
        const id = Number(result[0].id);
        logger.debug(`[MiscRepository] Created custom theme: ${name} (slug: ${slug})`);
        return { id, name, slug, definition: definitionJson, is_builtin: 0, created_by: userId, created_at: now, updated_at: now };
      }
    } catch (error) {
      logger.error(`[MiscRepository] Failed to create custom theme ${name}:`, error);
      throw error;
    }
  }

  /**
   * Update an existing custom theme
   */
  async updateCustomTheme(slug: string, updates: Partial<{ name: string; definition: string }>): Promise<boolean> {
    const { customThemes } = this.tables;

    try {
      // Check if theme exists
      const existing = await this.getCustomThemeBySlug(slug);
      if (!existing) {
        logger.warn(`[MiscRepository] Cannot update non-existent theme: ${slug}`);
        return false;
      }

      const now = Math.floor(Date.now() / 1000);
      const setData: Record<string, any> = { updated_at: now };

      if (updates.name !== undefined) {
        setData.name = updates.name;
      }
      if (updates.definition !== undefined) {
        setData.definition = typeof updates.definition === 'string'
          ? updates.definition
          : JSON.stringify(updates.definition);
      }

      await this.db
        .update(customThemes)
        .set(setData)
        .where(eq(customThemes.slug, slug));

      logger.debug(`[MiscRepository] Updated custom theme: ${slug}`);
      return true;
    } catch (error) {
      logger.error(`[MiscRepository] Failed to update custom theme ${slug}:`, error);
      throw error;
    }
  }

  /**
   * Delete a custom theme by slug
   */
  async deleteCustomTheme(slug: string): Promise<boolean> {
    const { customThemes } = this.tables;

    try {
      // Check if theme exists and is not built-in
      const existing = await this.getCustomThemeBySlug(slug);
      if (!existing) {
        logger.warn(`[MiscRepository] Cannot delete non-existent theme: ${slug}`);
        return false;
      }
      if (existing.is_builtin) {
        throw new Error('Cannot delete built-in themes');
      }

      await this.db
        .delete(customThemes)
        .where(eq(customThemes.slug, slug));

      logger.debug(`[MiscRepository] Deleted custom theme: ${slug}`);
      return true;
    } catch (error) {
      logger.error(`[MiscRepository] Failed to delete custom theme ${slug}:`, error);
      throw error;
    }
  }

  // ============ DISTANCE DELETE LOG ============

  /**
   * Get auto-delete-by-distance log entries.
   * If sourceId is provided, scope to that source. NULL sourceId is the
   * legacy/unscoped bucket; an unfiltered call returns all rows.
   */
  async getDistanceDeleteLog(limit: number = 10, sourceId?: string): Promise<any[]> {
    const { autoDistanceDeleteLog } = this.tables;
    const baseQuery = (this.db as any)
      .select()
      .from(autoDistanceDeleteLog);
    const query = sourceId
      ? baseQuery.where(eq(autoDistanceDeleteLog.sourceId, sourceId))
      : baseQuery;
    const rows = await query
      .orderBy(desc(autoDistanceDeleteLog.timestamp))
      .limit(limit);
    return (rows as any[]).map((e: any) => ({
      ...e,
      details: e.details ? JSON.parse(e.details) : [],
    }));
  }

  /**
   * Add an entry to the auto-delete-by-distance log
   */
  async addDistanceDeleteLogEntry(entry: {
    timestamp: number;
    nodesDeleted: number;
    thresholdKm: number;
    details: string;
    sourceId?: string;
  }): Promise<void> {
    const { autoDistanceDeleteLog } = this.tables;
    const now = Date.now();
    await (this.db as any).insert(autoDistanceDeleteLog).values({
      timestamp: entry.timestamp,
      nodesDeleted: entry.nodesDeleted,
      thresholdKm: entry.thresholdKm,
      details: entry.details,
      createdAt: now,
      sourceId: entry.sourceId ?? null,
    });
  }

  // ============ PACKET LOG ============

  /**
   * Filter options for packet log queries
   */
  private buildPacketLogWhere(options: PacketLogFilterOptions): { conditions: any[]; } {
    const conditions: any[] = [];
    const { portnum, from_node, to_node, channel, encrypted, since, relay_node, sourceId } = options;

    if (sourceId !== undefined) conditions.push(sql`pl.${sql.identifier('sourceId')} = ${sourceId}`);
    if (portnum !== undefined) conditions.push(sql`pl.portnum = ${portnum}`);
    if (from_node !== undefined) conditions.push(sql`pl.from_node = ${from_node}`);
    if (to_node !== undefined) conditions.push(sql`pl.to_node = ${to_node}`);
    if (channel !== undefined) conditions.push(sql`pl.channel = ${channel}`);
    if (encrypted !== undefined) {
      if (this.isSQLite()) {
        conditions.push(sql`pl.encrypted = ${encrypted ? 1 : 0}`);
      } else {
        conditions.push(sql`pl.encrypted = ${encrypted}`);
      }
    }
    if (since !== undefined) conditions.push(sql`pl.timestamp >= ${since}`);
    if (relay_node === 'unknown') {
      conditions.push(sql`pl.relay_node IS NULL`);
    } else if (relay_node !== undefined) {
      conditions.push(sql`pl.relay_node = ${relay_node}`);
    }

    return { conditions };
  }

  /**
   * Combine SQL conditions with AND
   */
  private combineConditions(conditions: any[]): any {
    if (conditions.length === 0) return sql`1=1`;
    return conditions.reduce((acc, cond) => sql`${acc} AND ${cond}`);
  }

  /**
   * Normalize a raw packet log row — coerce BIGINT fields to number
   */
  private normalizePacketLogRow(row: any): DbPacketLog {
    return {
      ...row,
      id: row.id != null ? Number(row.id) : row.id,
      packet_id: row.packet_id != null ? Number(row.packet_id) : row.packet_id,
      timestamp: row.timestamp != null ? Number(row.timestamp) : row.timestamp,
      from_node: row.from_node != null ? Number(row.from_node) : row.from_node,
      to_node: row.to_node != null ? Number(row.to_node) : row.to_node,
      relay_node: row.relay_node != null ? Number(row.relay_node) : row.relay_node,
      created_at: row.created_at != null ? Number(row.created_at) : row.created_at,
      // PostgreSQL lowercases unquoted aliases — normalize for frontend
      from_node_longName: row.from_node_longName ?? row.from_node_longname ?? null,
      to_node_longName: row.to_node_longName ?? row.to_node_longname ?? null,
    } as DbPacketLog;
  }

  /**
   * Insert a packet log entry
   */
  async insertPacketLog(packet: Omit<DbPacketLog, 'id' | 'created_at'>, sourceId?: string): Promise<number> {
    const { packetLog } = this.tables;

    try {
      const values: any = {
        packet_id: packet.packet_id ?? null,
        timestamp: packet.timestamp,
        from_node: packet.from_node,
        from_node_id: packet.from_node_id ?? null,
        to_node: packet.to_node ?? null,
        to_node_id: packet.to_node_id ?? null,
        channel: packet.channel ?? null,
        portnum: packet.portnum,
        portnum_name: packet.portnum_name ?? null,
        encrypted: packet.encrypted,
        snr: packet.snr ?? null,
        rssi: packet.rssi ?? null,
        hop_limit: packet.hop_limit ?? null,
        hop_start: packet.hop_start ?? null,
        relay_node: packet.relay_node ?? null,
        payload_size: packet.payload_size ?? null,
        want_ack: packet.want_ack ?? false,
        priority: packet.priority ?? null,
        payload_preview: packet.payload_preview ?? null,
        metadata: packet.metadata ?? null,
        direction: packet.direction ?? 'rx',
        created_at: Date.now(),
        transport_mechanism: packet.transport_mechanism ?? null,
        decrypted_by: packet.decrypted_by ?? null,
        decrypted_channel_id: packet.decrypted_channel_id ?? null,
      };
      if (sourceId) {
        values.sourceId = sourceId;
      }

      await this.db.insert(packetLog).values(values);
      return 0;
    } catch (error) {
      logger.error(`[MiscRepository] Failed to insert packet log: ${error}`);
      return 0;
    }
  }

  /**
   * Enforce max count limit on packet logs (deletes oldest entries)
   */
  async enforcePacketLogMaxCount(maxCount: number): Promise<void> {
    try {
      const { packetLog } = this.tables;
      const countResult = await this.db
        .select({ count: sql<number>`count(*)` })
        .from(packetLog);
      const currentCount = Number(countResult[0]?.count ?? 0);

      if (currentCount > maxCount) {
        const deleteCount = currentCount - maxCount;
        // Two-step delete: MariaDB rejects `DELETE ... WHERE id IN (SELECT ... LIMIT ?)`
        // (ER_NOT_SUPPORTED_YET). Select oldest IDs first, then delete by ID list.
        const oldest = await this.db
          .select({ id: packetLog.id })
          .from(packetLog)
          .orderBy(asc(packetLog.timestamp))
          .limit(deleteCount);

        if (oldest.length > 0) {
          const ids = oldest.map((row: { id: number }) => row.id);
          await this.db.delete(packetLog).where(inArray(packetLog.id, ids));
        }
        logger.debug(`[MiscRepository] Deleted ${oldest.length} old packets to enforce max count of ${maxCount}`);
      }
    } catch (error) {
      logger.error('[MiscRepository] Failed to enforce packet log max count:', error);
    }
  }

  /**
   * Get packet logs with optional filters and pagination
   */
  async getPacketLogs(options: PacketLogFilterOptions & { offset?: number; limit?: number }): Promise<DbPacketLog[]> {
    const { offset = 0, limit = 100 } = options;
    const { conditions } = this.buildPacketLogWhere(options);
    const whereClause = this.combineConditions(conditions);

    try {
      const longName = this.col('longName');
      const nodeNum = this.col('nodeNum');
      const sourceIdCol = this.col('sourceId');

      // Join on both nodeNum AND sourceId so that a nodeNum present in multiple
      // sources (composite PK since migration 029) does not produce duplicate rows
      // for the same packet (#3051).
      const joinQuery = sql`
        SELECT pl.*, from_nodes.${longName} as from_node_longName, to_nodes.${longName} as to_node_longName
        FROM packet_log pl
        LEFT JOIN nodes from_nodes ON pl.from_node = from_nodes.${nodeNum} AND pl.${sourceIdCol} = from_nodes.${sourceIdCol}
        LEFT JOIN nodes to_nodes ON pl.to_node = to_nodes.${nodeNum} AND pl.${sourceIdCol} = to_nodes.${sourceIdCol}
        WHERE ${whereClause}
        ORDER BY pl.timestamp DESC, pl.id DESC LIMIT ${limit} OFFSET ${offset}
      `;

      const rows = await this.executeQuery(joinQuery);
      return (rows as any[]).map((row: any) => this.normalizePacketLogRow(row));
    } catch (error) {
      logger.error('[MiscRepository] Failed to get packet logs:', error);
      return [];
    }
  }

  /**
   * Get a single packet log entry by ID
   */
  async getPacketLogById(id: number): Promise<DbPacketLog | null> {
    try {
      const longName = this.col('longName');
      const nodeNum = this.col('nodeNum');
      const sourceIdCol = this.col('sourceId');

      // Join on both nodeNum AND sourceId — same fix as getPacketLogs (#3051).
      const joinQuery = sql`
        SELECT pl.*, from_nodes.${longName} as from_node_longName, to_nodes.${longName} as to_node_longName
        FROM packet_log pl
        LEFT JOIN nodes from_nodes ON pl.from_node = from_nodes.${nodeNum} AND pl.${sourceIdCol} = from_nodes.${sourceIdCol}
        LEFT JOIN nodes to_nodes ON pl.to_node = to_nodes.${nodeNum} AND pl.${sourceIdCol} = to_nodes.${sourceIdCol}
        WHERE pl.id = ${id}
      `;

      const rows = await this.executeQuery(joinQuery);
      if (!rows || rows.length === 0) return null;
      return this.normalizePacketLogRow(rows[0]);
    } catch (error) {
      logger.error('[MiscRepository] Failed to get packet log by id:', error);
      return null;
    }
  }

  /**
   * Get packet log count with optional filters
   */
  async getPacketLogCount(options: PacketLogFilterOptions = {}): Promise<number> {
    const { conditions } = this.buildPacketLogWhere(options);
    const whereClause = this.combineConditions(conditions);

    try {
      const rows = await this.executeQuery(
        sql`SELECT COUNT(*) as count FROM packet_log pl WHERE ${whereClause}`
      );
      return Number(rows[0]?.count ?? 0);
    } catch (error) {
      logger.error('[MiscRepository] Failed to get packet log count:', error);
      return 0;
    }
  }

  /**
   * Clear all packet logs, optionally scoped to a single source.
   */
  async clearPacketLogs(sourceId?: string): Promise<number> {
    try {
      const results = sourceId
        ? await this.executeRun(sql`DELETE FROM packet_log WHERE sourceId = ${sourceId}`)
        : await this.executeRun(sql`DELETE FROM packet_log`);
      const deletedCount = this.getAffectedRows(results);
      logger.debug(`[MiscRepository] Cleared ${deletedCount} packet log entries`);
      return deletedCount;
    } catch (error) {
      logger.error('[MiscRepository] Failed to clear packet logs:', error);
      throw error;
    }
  }

  /**
   * Delete packet log rows that reference a node (as from_node or to_node),
   * optionally scoped to a sourceId. Used when a single node is deleted so
   * the Packet Monitor doesn't keep showing the node's history (#2637).
   */
  async deletePacketLogsForNode(nodeNum: number, sourceId?: string): Promise<number> {
    const { packetLog } = this.tables;
    const condition = sourceId
      ? and(
          or(eq(packetLog.from_node, nodeNum), eq(packetLog.to_node, nodeNum)),
          eq(packetLog.sourceId, sourceId)
        )
      : or(eq(packetLog.from_node, nodeNum), eq(packetLog.to_node, nodeNum));

    try {
      const results = await this.executeRun(
        (this.db as any).delete(packetLog).where(condition)
      );
      const deletedCount = this.getAffectedRows(results);
      if (deletedCount > 0) {
        logger.debug(
          `[MiscRepository] Deleted ${deletedCount} packet log entries for node ${nodeNum}${sourceId ? `@${sourceId}` : ''}`
        );
      }
      return deletedCount;
    } catch (error) {
      logger.error('[MiscRepository] Failed to delete packet logs for node:', error);
      return 0;
    }
  }

  /**
   * Synchronously delete packet log rows for a node (SQLite only).
   */
  deletePacketLogsForNodeSync(nodeNum: number, sourceId?: string): number {
    const db = this.getSqliteDb();
    const { packetLog } = this.tables;
    const condition = sourceId
      ? and(
          or(eq(packetLog.from_node, nodeNum), eq(packetLog.to_node, nodeNum)),
          eq(packetLog.sourceId, sourceId)
        )
      : or(eq(packetLog.from_node, nodeNum), eq(packetLog.to_node, nodeNum));
    const result = (db as any).delete(packetLog).where(condition).run() as any;
    const changes = Number(result?.changes ?? 0);
    if (changes > 0) {
      logger.debug(
        `[MiscRepository] Deleted ${changes} packet log entries for node ${nodeNum}${sourceId ? `@${sourceId}` : ''} (sync)`
      );
    }
    return changes;
  }

  /**
   * Cleanup old packet logs based on max age
   */
  async cleanupOldPacketLogs(maxAgeHours: number): Promise<number> {
    const cutoffTimestamp = Date.now() - (maxAgeHours * 60 * 60 * 1000);

    try {
      const results = await this.executeRun(
        sql`DELETE FROM packet_log WHERE timestamp < ${cutoffTimestamp}`
      );
      const deleted = this.getAffectedRows(results);
      if (deleted > 0) {
        logger.debug(`[MiscRepository] Cleaned up ${deleted} packet log entries older than ${maxAgeHours} hours`);
      }
      return deleted;
    } catch (error) {
      logger.error('[MiscRepository] Failed to cleanup old packet logs:', error);
      return 0;
    }
  }

  /**
   * Get distinct relay_node values from packet_log for filter dropdowns.
   * relay_node is only the last byte of the node ID per the Meshtastic protobuf spec.
   * We match by (nodeNum & 0xFF) to find candidate node names.
   */
  async getDistinctRelayNodes(sourceId?: string): Promise<DbDistinctRelayNode[]> {
    const longName = this.col('longName');
    const shortName = this.col('shortName');
    const nodeNum = this.col('nodeNum');

    try {
      const conditions: any[] = [sql`relay_node IS NOT NULL`];
      if (sourceId !== undefined) conditions.push(sql`${sql.identifier('sourceId')} = ${sourceId}`);
      const whereClause = this.combineConditions(conditions);
      const distinctRows = await this.executeQuery(sql`SELECT DISTINCT relay_node FROM packet_log WHERE ${whereClause}`);
      const relayValues = (distinctRows as any[]).map((r: any) => Number(r.relay_node));

      const results: DbDistinctRelayNode[] = [];
      const hopsAway = this.col('hopsAway');
      for (const rv of relayValues) {
        // Only include nodes that could plausibly be relays:
        // direct neighbors (hopsAway <= 1) or unknown hop distance (NULL)
        const matchRows = await this.executeQuery(
          sql`SELECT ${longName}, ${shortName} FROM nodes WHERE (${nodeNum} & 255) = ${rv} AND (${hopsAway} IS NULL OR ${hopsAway} <= 1)`
        );
        results.push({
          relay_node: rv,
          matching_nodes: (matchRows as any[]).map((r: any) => ({
            longName: r.longName ?? null,
            shortName: r.shortName ?? null,
          })),
        });
      }
      return results;
    } catch (error) {
      logger.error('[MiscRepository] Failed to get distinct relay nodes:', error);
      return [];
    }
  }

  /**
   * Update packet log entry with decryption results (for retroactive decryption)
   */
  async updatePacketLogDecryption(
    id: number,
    decryptedBy: 'server' | 'node',
    decryptedChannelId: number | null,
    portnum: number,
    metadata: string
  ): Promise<void> {
    if (this.isSQLite()) {
      // SQLite uses 0 for false
      await this.executeRun(sql`
        UPDATE packet_log
        SET decrypted_by = ${decryptedBy},
            decrypted_channel_id = ${decryptedChannelId},
            portnum = ${portnum},
            encrypted = 0,
            metadata = ${metadata}
        WHERE id = ${id}
      `);
    } else {
      await this.executeRun(sql`
        UPDATE packet_log
        SET decrypted_by = ${decryptedBy},
            decrypted_channel_id = ${decryptedChannelId},
            portnum = ${portnum},
            encrypted = false,
            metadata = ${metadata}
        WHERE id = ${id}
      `);
    }
  }

  /**
   * Synchronously clear all packet log rows (SQLite only).
   * Returns number of rows deleted.
   */
  clearPacketLogsSync(sourceId?: string): number {
    const db = this.getSqliteDb();
    const result = (sourceId
      ? db.run(sql`DELETE FROM packet_log WHERE sourceId = ${sourceId}`)
      : db.run(sql`DELETE FROM packet_log`)) as any;
    const changes = Number(result?.changes ?? 0);
    logger.debug(`[MiscRepository] Cleared ${changes} packet log entries (sync)`);
    return changes;
  }

  /**
   * Synchronously cleanup packet logs older than cutoffTimestamp (SQLite only).
   * Returns number of rows deleted.
   */
  cleanupOldPacketLogsSync(cutoffTimestamp: number): number {
    const db = this.getSqliteDb();
    const result = db.run(sql`DELETE FROM packet_log WHERE timestamp < ${cutoffTimestamp}`) as any;
    return Number(result?.changes ?? 0);
  }

  /**
   * Synchronously get packet counts per from_node since a given timestamp,
   * excluding internal traffic. (SQLite only.)
   */
  getPacketCountsPerNodeSinceSync(options: {
    since: number;
    localNodeNum: number | null;
  }): Array<{ nodeNum: number; packetCount: number }> {
    const db = this.getSqliteDb();
    const { since, localNodeNum } = options;
    const ln = localNodeNum ?? -1;
    const rows = db.all(sql`
      SELECT from_node as nodeNum, COUNT(*) as packetCount
      FROM packet_log
      WHERE timestamp >= ${since}
        AND NOT (from_node = ${ln} AND to_node = ${ln})
      GROUP BY from_node
    `) as any[];
    return rows.map((r: any) => ({
      nodeNum: Number(r.nodeNum),
      packetCount: Number(r.packetCount),
    }));
  }

  // ============ auto_traceroute_log async methods (all backends) ============

  /**
   * Get the most recent auto-traceroute log rows (all backends).
   * Boolean success is returned (null preserved).
   */
  async getAutoTracerouteLog(limit: number = 10, sourceId?: string): Promise<Array<{
    id: number;
    timestamp: number;
    toNodeNum: number;
    toNodeName: string | null;
    success: boolean | null;
  }>> {
    try {
      const { autoTracerouteLog } = this.tables;
      const query = this.db
        .select({
          id: autoTracerouteLog.id,
          timestamp: autoTracerouteLog.timestamp,
          toNodeNum: autoTracerouteLog.toNodeNum,
          toNodeName: autoTracerouteLog.toNodeName,
          success: autoTracerouteLog.success,
        })
        .from(autoTracerouteLog);
      const scoped = sourceId !== undefined
        ? query.where(eq(autoTracerouteLog.sourceId, sourceId))
        : query;
      const rows = await scoped
        .orderBy(desc(autoTracerouteLog.timestamp))
        .limit(limit);
      return (rows as any[]).map((r: any) => ({
        id: Number(r.id),
        timestamp: Number(r.timestamp),
        toNodeNum: Number(r.toNodeNum),
        toNodeName: r.toNodeName ?? null,
        success: r.success === null || r.success === undefined ? null : Boolean(r.success),
      }));
    } catch (error) {
      logger.error(`[MiscRepository] Failed to get auto traceroute log: ${error}`);
      return [];
    }
  }

  /**
   * Insert an auto-traceroute attempt row and prune to the last 100 entries.
   * Returns the inserted row id. Works for SQLite/Postgres/MySQL.
   */
  async logAutoTracerouteAttempt(toNodeNum: number, toNodeName: string | null, sourceId?: string): Promise<number> {
    try {
      const { autoTracerouteLog } = this.tables;
      const now = Date.now();
      const values: any = {
        timestamp: now,
        toNodeNum,
        toNodeName,
        success: null,
        createdAt: now,
        sourceId: sourceId ?? null,
      };

      let insertedId = 0;
      if (this.isPostgres()) {
        const result = await (this.db.insert(autoTracerouteLog).values(values) as any).returning({ id: autoTracerouteLog.id });
        insertedId = Number((result as any[])[0]?.id ?? 0);
      } else if (this.isMySQL()) {
        const result = await this.db.insert(autoTracerouteLog).values(values);
        insertedId = Number((result as any)?.[0]?.insertId ?? 0);
      } else {
        const result = await this.db.insert(autoTracerouteLog).values(values);
        insertedId = Number((result as any)?.lastInsertRowid ?? 0);
      }

      // Prune older rows beyond the 100 most recent.
      const keepRows = await this.db
        .select({ id: autoTracerouteLog.id })
        .from(autoTracerouteLog)
        .orderBy(desc(autoTracerouteLog.timestamp))
        .limit(100);
      const keepIds = (keepRows as any[]).map((r) => Number(r.id));
      if (keepIds.length > 0) {
        await this.db
          .delete(autoTracerouteLog)
          .where(notInArray(autoTracerouteLog.id, keepIds));
      }

      return insertedId;
    } catch (error) {
      logger.error(`[MiscRepository] Failed to log auto traceroute attempt: ${error}`);
      return 0;
    }
  }

  /**
   * Update the most recent pending auto-traceroute log row for a given
   * destination node across all backends.
   */
  async updateAutoTracerouteResultByNode(toNodeNum: number, success: boolean): Promise<void> {
    try {
      const { autoTracerouteLog } = this.tables;
      const rows = await this.db
        .select({ id: autoTracerouteLog.id })
        .from(autoTracerouteLog)
        .where(and(eq(autoTracerouteLog.toNodeNum, toNodeNum), isNull(autoTracerouteLog.success))!)
        .orderBy(desc(autoTracerouteLog.timestamp))
        .limit(1);
      if ((rows as any[]).length > 0) {
        const id = Number(((rows as any[])[0]).id);
        await this.db
          .update(autoTracerouteLog)
          .set({ success: success ? 1 : 0 } as any)
          .where(eq(autoTracerouteLog.id, id));
      }
    } catch (error) {
      logger.error(`[MiscRepository] Failed to update auto traceroute result: ${error}`);
    }
  }

  // ============ auto_traceroute_nodes sync methods (SQLite only) ============

  /**
   * Synchronously get the list of auto-traceroute node nums ordered by
   * creation time ascending (SQLite only).
   */
  getAutoTracerouteNodesSync(): number[] {
    const db = this.getSqliteDb();
    const { autoTracerouteNodes } = this.tables;
    const rows = db
      .select({ nodeNum: autoTracerouteNodes.nodeNum })
      .from(autoTracerouteNodes)
      .orderBy(asc(autoTracerouteNodes.createdAt))
      .all();
    return (rows as any[]).map((r) => Number(r.nodeNum));
  }

  /**
   * Synchronously replace the auto-traceroute nodes set in a single
   * transaction (SQLite only). Bad nodeNums are skipped.
   */
  setAutoTracerouteNodesSync(nodeNums: number[]): void {
    const db = this.getSqliteDb();
    const { autoTracerouteNodes } = this.tables;
    const now = Date.now();
    db.transaction((tx) => {
      tx.delete(autoTracerouteNodes).run();
      for (const nodeNum of nodeNums) {
        try {
          tx.insert(autoTracerouteNodes)
            .values({ nodeNum, createdAt: now } as any)
            .run();
        } catch (error) {
          logger.debug(`Skipping invalid nodeNum: ${nodeNum}`, error);
        }
      }
    });
  }

  // ============ auto_traceroute_log sync methods (SQLite only) ============

  /**
   * Synchronously insert an auto-traceroute attempt row and prune to the last
   * 100 entries (SQLite only). Returns the inserted row id.
   */
  logAutoTracerouteAttemptSync(toNodeNum: number, toNodeName: string | null, sourceId?: string): number {
    const db = this.getSqliteDb();
    const { autoTracerouteLog } = this.tables;
    const now = Date.now();
    const result = db
      .insert(autoTracerouteLog)
      .values({
        timestamp: now,
        toNodeNum,
        toNodeName,
        success: null,
        createdAt: now,
        sourceId: sourceId ?? null,
      } as any)
      .run() as any;

    // Prune older rows beyond the 100 most recent.
    const keepRows = db
      .select({ id: autoTracerouteLog.id })
      .from(autoTracerouteLog)
      .orderBy(desc(autoTracerouteLog.timestamp))
      .limit(100)
      .all();
    const keepIds = (keepRows as any[]).map((r) => Number(r.id));
    if (keepIds.length > 0) {
      db.delete(autoTracerouteLog)
        .where(sql`id NOT IN (${sql.join(keepIds.map((id) => sql`${id}`), sql`, `)})`)
        .run();
    }

    return Number(result?.lastInsertRowid ?? 0);
  }

  /**
   * Synchronously mark an auto-traceroute log row's success flag (SQLite only).
   */
  updateAutoTracerouteResultSync(logId: number, success: boolean): void {
    const db = this.getSqliteDb();
    const { autoTracerouteLog } = this.tables;
    db.update(autoTracerouteLog)
      .set({ success: success ? 1 : 0 } as any)
      .where(eq(autoTracerouteLog.id, logId))
      .run();
  }

  /**
   * Synchronously update the most recent pending auto-traceroute log row for
   * a given destination node (SQLite only).
   */
  updateAutoTracerouteResultByNodeSync(toNodeNum: number, success: boolean): void {
    const db = this.getSqliteDb();
    const { autoTracerouteLog } = this.tables;
    const rows = db
      .select({ id: autoTracerouteLog.id })
      .from(autoTracerouteLog)
      .where(and(eq(autoTracerouteLog.toNodeNum, toNodeNum), isNull(autoTracerouteLog.success))!)
      .orderBy(desc(autoTracerouteLog.timestamp))
      .limit(1)
      .all();
    if (rows.length > 0) {
      const id = Number((rows[0] as any).id);
      db.update(autoTracerouteLog)
        .set({ success: success ? 1 : 0 } as any)
        .where(eq(autoTracerouteLog.id, id))
        .run();
    }
  }

  /**
   * Synchronously fetch the most recent auto-traceroute log rows (SQLite only).
   * Boolean success is returned (null preserved).
   */
  getAutoTracerouteLogSync(limit: number = 10, sourceId?: string): Array<{
    id: number;
    timestamp: number;
    toNodeNum: number;
    toNodeName: string | null;
    success: boolean | null;
  }> {
    const db = this.getSqliteDb();
    const { autoTracerouteLog } = this.tables;
    const query = db
      .select({
        id: autoTracerouteLog.id,
        timestamp: autoTracerouteLog.timestamp,
        toNodeNum: autoTracerouteLog.toNodeNum,
        toNodeName: autoTracerouteLog.toNodeName,
        success: autoTracerouteLog.success,
      })
      .from(autoTracerouteLog);
    const rows = (sourceId !== undefined
      ? query.where(eq(autoTracerouteLog.sourceId, sourceId))
      : query)
      .orderBy(desc(autoTracerouteLog.timestamp))
      .limit(limit)
      .all();
    return (rows as any[]).map((r: any) => ({
      id: Number(r.id),
      timestamp: Number(r.timestamp),
      toNodeNum: Number(r.toNodeNum),
      toNodeName: r.toNodeName ?? null,
      success: r.success === null || r.success === undefined ? null : r.success === 1,
    }));
  }

  /**
   * Get packet counts per from_node since a given timestamp, excluding internal
   * traffic (packets where both ends are the local node). Used for spam
   * detection / last-hour broadcaster stats.
   */
  async getPacketCountsPerNodeSince(options: {
    since: number;
    localNodeNum: number | null;
    sourceId?: string;
  }): Promise<Array<{ nodeNum: number; packetCount: number }>> {
    const { since, localNodeNum, sourceId } = options;
    const ln = localNodeNum ?? -1;
    try {
      const conditions: any[] = [
        sql`timestamp >= ${since}`,
        sql`NOT (from_node = ${ln} AND to_node = ${ln})`,
      ];
      if (sourceId !== undefined) conditions.push(sql`${sql.identifier('sourceId')} = ${sourceId}`);
      const whereClause = this.combineConditions(conditions);

      const rows = await this.executeQuery(sql`
        SELECT from_node as "nodeNum", COUNT(*) as "packetCount"
        FROM packet_log
        WHERE ${whereClause}
        GROUP BY from_node
      `);

      return (rows as any[]).map((r: any) => ({
        nodeNum: Number(r.nodeNum ?? r.nodenum),
        packetCount: Number(r.packetCount ?? r.packetcount),
      }));
    } catch (error) {
      logger.error('[MiscRepository] Failed to get packet counts per node since:', error);
      return [];
    }
  }

  /**
   * Get top N broadcasters by packet count since a given timestamp, excluding
   * internal traffic (packets where both ends are the local node).
   */
  async getTopBroadcastersSince(options: {
    since: number;
    limit: number;
    localNodeNum: number | null;
    sourceId?: string;
  }): Promise<Array<{ nodeNum: number; shortName: string | null; longName: string | null; packetCount: number }>> {
    const { since, limit, localNodeNum, sourceId } = options;
    const ln = localNodeNum ?? -1;
    try {
      const longName = this.col('longName');
      const shortName = this.col('shortName');
      const nodeNum = this.col('nodeNum');

      const conditions: any[] = [
        sql`p.timestamp >= ${since}`,
        sql`NOT (p.from_node = ${ln} AND p.to_node = ${ln})`,
      ];
      if (sourceId !== undefined) conditions.push(sql`p.${sql.identifier('sourceId')} = ${sourceId}`);
      const whereClause = this.combineConditions(conditions);

      const rows = await this.executeQuery(sql`
        SELECT p.from_node as "nodeNum", n.${shortName} as "shortName", n.${longName} as "longName", COUNT(*) as "packetCount"
        FROM packet_log p
        LEFT JOIN nodes n ON p.from_node = n.${nodeNum}
        WHERE ${whereClause}
        GROUP BY p.from_node, n.${shortName}, n.${longName}
        ORDER BY "packetCount" DESC
        LIMIT ${limit}
      `);

      return (rows as any[]).map((r: any) => ({
        nodeNum: Number(r.nodeNum ?? r.nodenum),
        shortName: r.shortName ?? r.shortname ?? null,
        longName: r.longName ?? r.longname ?? null,
        packetCount: Number(r.packetCount ?? r.packetcount),
      }));
    } catch (error) {
      logger.error('[MiscRepository] Failed to get top broadcasters since:', error);
      return [];
    }
  }

  /**
   * Get packet counts grouped by from_node (for distribution charts).
   * Returns top N nodes by packet count.
   */
  async getPacketCountsByNode(options?: { since?: number; limit?: number; portnum?: number; sourceId?: string }): Promise<DbPacketCountByNode[]> {
    const { since, limit = 10, portnum, sourceId } = options || {};

    try {
      const conditions: any[] = [];
      if (sourceId !== undefined) conditions.push(sql`pl.${sql.identifier('sourceId')} = ${sourceId}`);
      if (since !== undefined) conditions.push(sql`pl.timestamp >= ${since}`);
      if (portnum !== undefined) conditions.push(sql`pl.portnum = ${portnum}`);
      const whereClause = conditions.length > 0 ? this.combineConditions(conditions) : sql`1=1`;

      const longName = this.col('longName');
      const nodeNum = this.col('nodeNum');

      // Aggregate on packet_log alone — joining `nodes` here would multiply
      // COUNT(*) by the number of sources because `nodes` has composite PK
      // (nodeNum, sourceId) since migration 029, so the same nodeNum appears
      // once per source (#2794). Resolve longName via a scalar subquery that
      // prefers the requested sourceId and otherwise picks one deterministically.
      const nameConditions: any[] = [sql`n.${nodeNum} = agg.from_node`];
      if (sourceId !== undefined) {
        nameConditions.push(sql`n.${sql.identifier('sourceId')} = ${sourceId}`);
      }
      const nameWhere = this.combineConditions(nameConditions);

      const query = sql`
        SELECT agg.from_node, agg.from_node_id,
          (SELECT n.${longName} FROM nodes n WHERE ${nameWhere} LIMIT 1) as from_node_longName,
          agg.count
        FROM (
          SELECT pl.from_node, pl.from_node_id, COUNT(*) as count
          FROM packet_log pl
          WHERE ${whereClause}
          GROUP BY pl.from_node, pl.from_node_id
          ORDER BY COUNT(*) DESC
          LIMIT ${limit}
        ) agg
      `;

      const rows = await this.executeQuery(query);
      return (rows as any[]).map((row: any) => ({
        from_node: Number(row.from_node),
        from_node_id: row.from_node_id,
        from_node_longName: row.from_node_longName ?? row.from_node_longname ?? null,
        count: Number(row.count),
      }));
    } catch (error) {
      logger.error('[MiscRepository] Failed to get packet counts by node:', error);
      return [];
    }
  }

  /**
   * Get packet counts grouped by portnum (for distribution charts).
   * Includes port name from meshtastic constants.
   */
  async getPacketCountsByPortnum(options?: { since?: number; from_node?: number; sourceId?: string }): Promise<DbPacketCountByPortnum[]> {
    const { since, from_node, sourceId } = options || {};

    try {
      const conditions: any[] = [];
      if (sourceId !== undefined) conditions.push(sql`${sql.identifier('sourceId')} = ${sourceId}`);
      if (since !== undefined) conditions.push(sql`timestamp >= ${since}`);
      if (from_node !== undefined) conditions.push(sql`from_node = ${from_node}`);
      const whereClause = conditions.length > 0 ? this.combineConditions(conditions) : sql`1=1`;

      const rows = await this.executeQuery(sql`
        SELECT portnum, COUNT(*) as count
        FROM packet_log
        WHERE ${whereClause}
        GROUP BY portnum
        ORDER BY count DESC
      `);

      return (rows as any[]).map((row: any) => ({
        portnum: Number(row.portnum),
        portnum_name: getPortNumName(Number(row.portnum)),
        count: Number(row.count),
      }));
    } catch (error) {
      logger.error('[MiscRepository] Failed to get packet counts by portnum:', error);
      return [];
    }
  }

  // ============ USER MAP PREFERENCES ============

  /**
   * Get map preferences for a user
   */
  async getMapPreferences(userId: number): Promise<Record<string, any> | null> {
    try {
      const table = this.tables.userMapPreferences;
      const rows = await this.db
        .select()
        .from(table)
        .where(eq(table.userId, userId))
        .limit(1);

      if (rows.length === 0) return null;
      const row = rows[0] as any;

      return {
        mapTileset: row.mapTileset ?? null,
        showPaths: row.showPaths ?? false,
        showNeighborInfo: row.showNeighborInfo ?? false,
        showRoute: row.showRoute ?? true,
        showMotion: row.showMotion ?? true,
        showMqttNodes: row.showMqttNodes ?? true,
        showMeshCoreNodes: row.showMeshcoreNodes ?? true,
        showAnimations: row.showAnimations ?? false,
        showAccuracyRegions: row.showAccuracyRegions ?? false,
        showEstimatedPositions: row.showEstimatedPositions ?? false,
        positionHistoryHours: row.positionHistoryHours ?? null,
      };
    } catch (error) {
      logger.error('[MiscRepository] Failed to get map preferences:', error);
      return null;
    }
  }

  /**
   * Save map preferences for a user (upsert).
   */
  async saveMapPreferences(userId: number, preferences: {
    mapTileset?: string;
    showPaths?: boolean;
    showNeighborInfo?: boolean;
    showRoute?: boolean;
    showMotion?: boolean;
    showMqttNodes?: boolean;
    showMeshCoreNodes?: boolean;
    showAnimations?: boolean;
    showAccuracyRegions?: boolean;
    showEstimatedPositions?: boolean;
    positionHistoryHours?: number | null;
  }): Promise<void> {
    try {
      const table = this.tables.userMapPreferences;
      const existing = await this.db
        .select({ id: table.id })
        .from(table)
        .where(eq(table.userId, userId))
        .limit(1);

      if (existing.length > 0) {
        const set: Record<string, any> = {};
        if (preferences.mapTileset !== undefined) set.mapTileset = preferences.mapTileset;
        if (preferences.showPaths !== undefined) set.showPaths = preferences.showPaths;
        if (preferences.showNeighborInfo !== undefined) set.showNeighborInfo = preferences.showNeighborInfo;
        if (preferences.showRoute !== undefined) set.showRoute = preferences.showRoute;
        if (preferences.showMotion !== undefined) set.showMotion = preferences.showMotion;
        if (preferences.showMqttNodes !== undefined) set.showMqttNodes = preferences.showMqttNodes;
        if (preferences.showMeshCoreNodes !== undefined) set.showMeshcoreNodes = preferences.showMeshCoreNodes;
        if (preferences.showAnimations !== undefined) set.showAnimations = preferences.showAnimations;
        if (preferences.showAccuracyRegions !== undefined) set.showAccuracyRegions = preferences.showAccuracyRegions;
        if (preferences.showEstimatedPositions !== undefined) set.showEstimatedPositions = preferences.showEstimatedPositions;
        if (preferences.positionHistoryHours !== undefined) set.positionHistoryHours = preferences.positionHistoryHours;

        if (Object.keys(set).length > 0) {
          await this.db.update(table).set(set).where(eq(table.userId, userId));
        }
      } else {
        const now = Date.now();
        await this.db.insert(table).values({
          userId,
          mapTileset: preferences.mapTileset ?? null,
          showPaths: preferences.showPaths ?? false,
          showNeighborInfo: preferences.showNeighborInfo ?? false,
          showRoute: preferences.showRoute ?? true,
          showMotion: preferences.showMotion ?? true,
          showMqttNodes: preferences.showMqttNodes ?? true,
          showMeshcoreNodes: preferences.showMeshCoreNodes ?? true,
          showAnimations: preferences.showAnimations ?? false,
          showAccuracyRegions: preferences.showAccuracyRegions ?? false,
          showEstimatedPositions: preferences.showEstimatedPositions ?? true,
          positionHistoryHours: preferences.positionHistoryHours ?? null,
          createdAt: now,
          updatedAt: now,
        });
      }
    } catch (error) {
      logger.error('[MiscRepository] Failed to save map preferences:', error);
      throw error;
    }
  }

  // =============================================================================
  // Key Repair State / Log — SQLite sync variants
  // (async multi-dialect versions still live on DatabaseService for now)
  // =============================================================================

  /**
   * SQLite-only sync fetch of key repair state.
   */
  getKeyRepairStateSqlite(nodeNum: number): {
    nodeNum: number;
    attemptCount: number;
    lastAttemptTime: number | null;
    exhausted: boolean;
    startedAt: number;
  } | null {
    if (!this.sqliteDb) throw new Error('getKeyRepairStateSqlite is SQLite-only');
    const db = this.sqliteDb;
    const t = (this.tables as any).autoKeyRepairState;
    const rows = db
      .select({
        nodeNum: t.nodeNum,
        attemptCount: t.attemptCount,
        lastAttemptTime: t.lastAttemptTime,
        exhausted: t.exhausted,
        startedAt: t.startedAt,
      })
      .from(t)
      .where(eq(t.nodeNum, nodeNum))
      .limit(1)
      .all() as Array<{
        nodeNum: number;
        attemptCount: number;
        lastAttemptTime: number | null;
        exhausted: number;
        startedAt: number;
      }>;
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      nodeNum: Number(r.nodeNum),
      attemptCount: Number(r.attemptCount ?? 0),
      lastAttemptTime: r.lastAttemptTime != null ? Number(r.lastAttemptTime) : null,
      exhausted: Number(r.exhausted) === 1,
      startedAt: Number(r.startedAt),
    };
  }

  /**
   * SQLite-only sync upsert of key repair state (mirrors legacy facade logic).
   */
  setKeyRepairStateSqlite(
    nodeNum: number,
    state: { attemptCount?: number; lastAttemptTime?: number; exhausted?: boolean; startedAt?: number },
    existing: { attemptCount: number; lastAttemptTime: number | null; exhausted: boolean } | null,
  ): void {
    if (!this.sqliteDb) throw new Error('setKeyRepairStateSqlite is SQLite-only');
    const db = this.sqliteDb;
    const t = (this.tables as any).autoKeyRepairState;
    const now = Date.now();

    if (existing) {
      db.update(t)
        .set({
          attemptCount: state.attemptCount ?? existing.attemptCount,
          lastAttemptTime: state.lastAttemptTime ?? existing.lastAttemptTime,
          exhausted: (state.exhausted ?? existing.exhausted) ? 1 : 0,
        })
        .where(eq(t.nodeNum, nodeNum))
        .run();
    } else {
      db.insert(t).values({
        nodeNum,
        attemptCount: state.attemptCount ?? 0,
        lastAttemptTime: state.lastAttemptTime ?? null,
        exhausted: (state.exhausted ?? false) ? 1 : 0,
        startedAt: state.startedAt ?? now,
      }).run();
    }
  }

  /**
   * SQLite-only sync delete of key repair state.
   */
  clearKeyRepairStateSqlite(nodeNum: number): void {
    if (!this.sqliteDb) throw new Error('clearKeyRepairStateSqlite is SQLite-only');
    const db = this.sqliteDb;
    const t = (this.tables as any).autoKeyRepairState;
    db.delete(t).where(eq(t.nodeNum, nodeNum)).run();
  }

  /**
   * SQLite-only sync list of nodes needing key repair — joins the nodes table
   * to pick up nodeId/longName/shortName.
   */
  getNodesNeedingKeyRepairSqlite(): Array<{
    nodeNum: number;
    nodeId: string;
    longName: string | null;
    shortName: string | null;
    attemptCount: number;
    lastAttemptTime: number | null;
    startedAt: number | null;
  }> {
    if (!this.sqliteDb) throw new Error('getNodesNeedingKeyRepairSqlite is SQLite-only');
    const db = this.sqliteDb;
    const n = (this.tables as any).nodes;
    const s = (this.tables as any).autoKeyRepairState;
    // Drizzle's leftJoin sugar
    const rows = db
      .select({
        nodeNum: n.nodeNum,
        nodeId: n.nodeId,
        longName: n.longName,
        shortName: n.shortName,
        attemptCount: s.attemptCount,
        lastAttemptTime: s.lastAttemptTime,
        startedAt: s.startedAt,
        exhausted: s.exhausted,
      })
      .from(n)
      .leftJoin(s, eq(n.nodeNum, s.nodeNum))
      .where(eq(n.keyMismatchDetected, true))
      .all() as any[];
    return rows
      .filter(r => r.exhausted == null || Number(r.exhausted) === 0)
      .map(r => ({
        nodeNum: Number(r.nodeNum),
        nodeId: r.nodeId,
        longName: r.longName ?? null,
        shortName: r.shortName ?? null,
        attemptCount: Number(r.attemptCount ?? 0),
        lastAttemptTime: r.lastAttemptTime != null ? Number(r.lastAttemptTime) : null,
        startedAt: r.startedAt != null ? Number(r.startedAt) : null,
      }));
  }

  /**
   * SQLite-only sync append to key repair log + cleanup.
   * Uses the full v084 column set (oldKeyFragment, newKeyFragment, sourceId).
   * The schema's SQLite table only includes timestamp/nodeNum/nodeName/action/success
   * etc.; for the extended columns we drop down to raw SQL at a tagged site
   * (this repo doesn't know about columns added via migrations at runtime).
   */
  logKeyRepairAttemptSqlite(
    nodeNum: number,
    nodeName: string | null,
    action: string,
    success: boolean | null,
    oldKeyFragment: string | null,
    newKeyFragment: string | null,
    sourceId: string | null,
  ): number {
    if (!this.sqliteDb) throw new Error('logKeyRepairAttemptSqlite is SQLite-only');
    const betterSqlite = (this.sqliteDb as any).$client as import('better-sqlite3').Database;
    const now = Date.now();
    const info = betterSqlite
      .prepare(`
        INSERT INTO auto_key_repair_log (timestamp, nodeNum, nodeName, action, success, created_at, oldKeyFragment, newKeyFragment, sourceId)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(now, nodeNum, nodeName, action, success === null ? null : (success ? 1 : 0), now, oldKeyFragment, newKeyFragment, sourceId);
    betterSqlite
      .prepare('DELETE FROM auto_key_repair_log WHERE id NOT IN (SELECT id FROM auto_key_repair_log ORDER BY timestamp DESC LIMIT 100)')
      .run();
    return Number(info.lastInsertRowid);
  }

  /**
   * SQLite-only — probe introspection used by getKeyRepairLogAsync fallback.
   * Returns an object describing column / table presence so the caller can
   * build the correct SELECT list without raw SQL on the facade.
   */
  getKeyRepairLogIntrospectionSqlite(): { tableExists: boolean; hasOldKeyCol: boolean; hasSourceId: boolean } {
    if (!this.sqliteDb) throw new Error('getKeyRepairLogIntrospectionSqlite is SQLite-only');
    const betterSqlite = (this.sqliteDb as any).$client as import('better-sqlite3').Database;
    try {
      const table = betterSqlite
        .prepare("SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name='auto_key_repair_log'")
        .get() as { count: number };
      if (table.count === 0) return { tableExists: false, hasOldKeyCol: false, hasSourceId: false };
      const oldKey = betterSqlite
        .prepare("SELECT COUNT(*) as count FROM pragma_table_info('auto_key_repair_log') WHERE name='oldKeyFragment'")
        .get() as { count: number };
      const src = betterSqlite
        .prepare("SELECT COUNT(*) as count FROM pragma_table_info('auto_key_repair_log') WHERE name='sourceId'")
        .get() as { count: number };
      return { tableExists: true, hasOldKeyCol: oldKey.count > 0, hasSourceId: src.count > 0 };
    } catch {
      return { tableExists: false, hasOldKeyCol: false, hasSourceId: false };
    }
  }

  /**
   * SQLite-only — fetch key repair log rows with optional sourceId filter.
   * Assumes introspection has already confirmed the table and columns exist.
   */
  getKeyRepairLogSqlite(limit: number, sourceId: string | undefined, hasOldKeyCol: boolean, hasSourceId: boolean): Array<{
    id: number;
    timestamp: number;
    nodeNum: number;
    nodeName: string | null;
    action: string;
    success: boolean | null;
    oldKeyFragment: string | null;
    newKeyFragment: string | null;
  }> {
    if (!this.sqliteDb) throw new Error('getKeyRepairLogSqlite is SQLite-only');
    const betterSqlite = (this.sqliteDb as any).$client as import('better-sqlite3').Database;
    const selectCols = hasOldKeyCol
      ? 'id, timestamp, nodeNum, nodeName, action, success, oldKeyFragment, newKeyFragment'
      : 'id, timestamp, nodeNum, nodeName, action, success';
    const useSourceFilter = !!sourceId && hasSourceId;
    const whereClause = useSourceFilter ? 'WHERE sourceId = ?' : '';
    const params: any[] = useSourceFilter ? [sourceId, limit] : [limit];
    const rows = betterSqlite
      .prepare(`SELECT ${selectCols} FROM auto_key_repair_log ${whereClause} ORDER BY timestamp DESC LIMIT ?`)
      .all(...params) as any[];
    return rows.map(row => ({
      id: row.id,
      timestamp: Number(row.timestamp),
      nodeNum: Number(row.nodeNum),
      nodeName: row.nodeName,
      action: row.action,
      success: row.success === null ? null : Boolean(row.success),
      oldKeyFragment: row.oldKeyFragment || null,
      newKeyFragment: row.newKeyFragment || null,
    }));
  }
}

/**
 * Filter options for packet log queries
 */
export interface PacketLogFilterOptions {
  portnum?: number;
  from_node?: number;
  to_node?: number;
  channel?: number;
  encrypted?: boolean;
  since?: number;
  relay_node?: number | 'unknown';
  sourceId?: string;
}
