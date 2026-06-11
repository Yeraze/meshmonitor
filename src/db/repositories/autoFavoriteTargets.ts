/**
 * Auto-Favorite Targets Repository (issue #2608)
 *
 * CRUD for the per-source, per-target Automated Remote Favorites Management
 * config (auto_favorite_targets) and its assignment ledger
 * (auto_favorite_assignments).
 *
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, and, asc } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType, DbAutoFavoriteTarget, DbAutoFavoriteAssignment } from '../types.js';

export interface AutoFavoriteTargetInput {
  sourceId: string;
  targetNodeNum: number;
  enabled: boolean;
  useNeighborInfo: boolean;
  useTraceroutes: boolean;
  intervalHours: number;
  maxNewPerCycle: number;
  maxRefavoritePerCycle: number;
  maxNeighborAgeHours: number;
  eligibleRoles: string;
}

export class AutoFavoriteTargetsRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  /** Fetch the config row for one target, or null. */
  async getTarget(sourceId: string, targetNodeNum: number): Promise<DbAutoFavoriteTarget | null> {
    const { autoFavoriteTargets } = this.tables;
    const result = await this.db
      .select()
      .from(autoFavoriteTargets)
      .where(and(eq(autoFavoriteTargets.sourceId, sourceId), eq(autoFavoriteTargets.targetNodeNum, targetNodeNum)))
      .limit(1);
    const rows = this.normalizeBigInts(result) as DbAutoFavoriteTarget[];
    return rows[0] ?? null;
  }

  /** All target configs for a source (enabled and disabled). */
  async getTargetsForSource(sourceId: string): Promise<DbAutoFavoriteTarget[]> {
    const { autoFavoriteTargets } = this.tables;
    const result = await this.db
      .select()
      .from(autoFavoriteTargets)
      .where(eq(autoFavoriteTargets.sourceId, sourceId));
    return this.normalizeBigInts(result) as DbAutoFavoriteTarget[];
  }

  /** All enabled target configs across every source — drives the scheduler. */
  async getEnabledTargets(): Promise<DbAutoFavoriteTarget[]> {
    const { autoFavoriteTargets } = this.tables;
    const result = await this.db
      .select()
      .from(autoFavoriteTargets)
      .where(eq(autoFavoriteTargets.enabled, true));
    return this.normalizeBigInts(result) as DbAutoFavoriteTarget[];
  }

  /** Insert or update a target config (keyed on sourceId + targetNodeNum). */
  async upsertTarget(input: AutoFavoriteTargetInput): Promise<void> {
    const { autoFavoriteTargets } = this.tables;
    const now = Date.now();
    const values = {
      sourceId: input.sourceId,
      targetNodeNum: input.targetNodeNum,
      enabled: input.enabled,
      useNeighborInfo: input.useNeighborInfo,
      useTraceroutes: input.useTraceroutes,
      intervalHours: input.intervalHours,
      maxNewPerCycle: input.maxNewPerCycle,
      maxRefavoritePerCycle: input.maxRefavoritePerCycle,
      maxNeighborAgeHours: input.maxNeighborAgeHours,
      eligibleRoles: input.eligibleRoles,
      createdAt: now,
      updatedAt: now,
    };
    const updateSet = {
      enabled: input.enabled,
      useNeighborInfo: input.useNeighborInfo,
      useTraceroutes: input.useTraceroutes,
      intervalHours: input.intervalHours,
      maxNewPerCycle: input.maxNewPerCycle,
      maxRefavoritePerCycle: input.maxRefavoritePerCycle,
      maxNeighborAgeHours: input.maxNeighborAgeHours,
      eligibleRoles: input.eligibleRoles,
      updatedAt: now,
    };
    await this.upsert(
      autoFavoriteTargets,
      values,
      [autoFavoriteTargets.sourceId, autoFavoriteTargets.targetNodeNum],
      updateSet,
    );
  }

  /** Remove a target config and its assignment ledger. */
  async deleteTarget(sourceId: string, targetNodeNum: number): Promise<void> {
    const { autoFavoriteTargets, autoFavoriteAssignments } = this.tables;
    await this.db
      .delete(autoFavoriteAssignments)
      .where(and(eq(autoFavoriteAssignments.sourceId, sourceId), eq(autoFavoriteAssignments.targetNodeNum, targetNodeNum)));
    await this.db
      .delete(autoFavoriteTargets)
      .where(and(eq(autoFavoriteTargets.sourceId, sourceId), eq(autoFavoriteTargets.targetNodeNum, targetNodeNum)));
  }

  /** Record that a cycle ran for a target (lastRunAt). */
  async touchLastRun(sourceId: string, targetNodeNum: number, ts: number): Promise<void> {
    const { autoFavoriteTargets } = this.tables;
    await this.db
      .update(autoFavoriteTargets)
      .set({ lastRunAt: ts })
      .where(and(eq(autoFavoriteTargets.sourceId, sourceId), eq(autoFavoriteTargets.targetNodeNum, targetNodeNum)));
  }

  /** Record when a neighbor-info request was last sent to a target. */
  async touchLastNeighborRequest(sourceId: string, targetNodeNum: number, ts: number): Promise<void> {
    const { autoFavoriteTargets } = this.tables;
    await this.db
      .update(autoFavoriteTargets)
      .set({ lastNeighborRequestAt: ts })
      .where(and(eq(autoFavoriteTargets.sourceId, sourceId), eq(autoFavoriteTargets.targetNodeNum, targetNodeNum)));
  }

  /** Assignment ledger for a target, oldest re-favorite first. */
  async getAssignments(sourceId: string, targetNodeNum: number): Promise<DbAutoFavoriteAssignment[]> {
    const { autoFavoriteAssignments } = this.tables;
    const result = await this.db
      .select()
      .from(autoFavoriteAssignments)
      .where(and(eq(autoFavoriteAssignments.sourceId, sourceId), eq(autoFavoriteAssignments.targetNodeNum, targetNodeNum)))
      .orderBy(asc(autoFavoriteAssignments.lastAssignedAt));
    return this.normalizeBigInts(result) as DbAutoFavoriteAssignment[];
  }

  /**
   * Record a brand-new favorite assignment. On conflict (already assigned),
   * just bump lastAssignedAt — used both for first assignment and re-favorite.
   */
  async recordAssignment(
    sourceId: string,
    targetNodeNum: number,
    favoriteNodeNum: number,
    discoverySource: string | null,
    ts: number,
    ack?: { status: string | null; at: number },
  ): Promise<void> {
    const { autoFavoriteAssignments } = this.tables;
    const values = {
      sourceId,
      targetNodeNum,
      favoriteNodeNum,
      discoverySource: discoverySource ?? null,
      firstAssignedAt: ts,
      lastAssignedAt: ts,
      lastAckStatus: ack?.status ?? null,
      lastAckAt: ack?.at ?? null,
    };
    const updateSet: Record<string, unknown> = { lastAssignedAt: ts };
    if (ack) {
      updateSet.lastAckStatus = ack.status ?? null;
      updateSet.lastAckAt = ack.at;
    }
    await this.upsert(
      autoFavoriteAssignments,
      values,
      [autoFavoriteAssignments.sourceId, autoFavoriteAssignments.targetNodeNum, autoFavoriteAssignments.favoriteNodeNum],
      updateSet,
    );
  }

  /** Bump lastAssignedAt for an existing assignment (re-favorite), optionally recording its ACK result. */
  async touchAssignment(
    sourceId: string,
    targetNodeNum: number,
    favoriteNodeNum: number,
    ts: number,
    ack?: { status: string | null; at: number },
  ): Promise<void> {
    const { autoFavoriteAssignments } = this.tables;
    const set: Record<string, unknown> = { lastAssignedAt: ts };
    if (ack) {
      set.lastAckStatus = ack.status ?? null;
      set.lastAckAt = ack.at;
    }
    await this.db
      .update(autoFavoriteAssignments)
      .set(set)
      .where(and(
        eq(autoFavoriteAssignments.sourceId, sourceId),
        eq(autoFavoriteAssignments.targetNodeNum, targetNodeNum),
        eq(autoFavoriteAssignments.favoriteNodeNum, favoriteNodeNum),
      ));
  }
}
