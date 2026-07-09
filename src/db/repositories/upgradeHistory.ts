/**
 * Upgrade History Repository
 *
 * Handles upgrade history database operations.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, desc, and, gte, lt, inArray, sql } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

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

export class UpgradeHistoryRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

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
   * Find the most recent in-progress upgrade, regardless of age.
   * Used for boot-time status sync only — do not use for the stale-timeout
   * path, which uses findStaleUpgrades / findActiveUpgrade with a threshold.
   */
  async findMostRecentPendingUpgrade(): Promise<UpgradeHistoryRecord | null> {
    const { upgradeHistory } = this.tables;
    const results = await this.db
      .select()
      .from(upgradeHistory)
      .where(inArray(upgradeHistory.status, this.IN_PROGRESS_STATUSES))
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
}
