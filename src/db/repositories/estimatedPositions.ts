/**
 * Estimated Positions Repository
 *
 * GLOBAL store of estimated node positions (one row per physical `nodeNum`).
 * There is intentionally no `sourceId` scoping — see schema/estimatedPositions.ts
 * and the CLAUDE.md global-by-design note. Rows are produced in bulk by the
 * scheduled positionEstimationService and consumed identically by every source.
 *
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, inArray, desc } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

/**
 * How an estimate's uncertainty radius was derived (issue #4609). Mirrors the
 * branch taken in `solveNodePosition`:
 *  - `single_anchor`  — one anchor (or weights so lopsided they behave as one):
 *                       the flat radio-range default, no triangulation.
 *  - `blended`        — partial convergence; the default blended toward the
 *                       statistical radius.
 *  - `convergence`    — a balanced multi-anchor solve; purely statistical.
 */
export type RadiusMethod = 'single_anchor' | 'blended' | 'convergence';

/** A single estimated position row. */
export interface EstimatedPosition {
  nodeNum: number;
  nodeId: string;
  latitude: number;
  longitude: number;
  uncertaintyKm: number | null;
  observationCount: number;
  updatedAt: number;
  /** Kish effective sample size of the solve. Null on pre-#4609 rows. */
  nEff: number | null;
  /** How `uncertaintyKm` was derived. Null on pre-#4609 rows. */
  radiusMethod: RadiusMethod | null;
}

/** Input for upserting an estimate (updatedAt is stamped by the caller). */
export interface EstimatedPositionInput {
  nodeNum: number;
  nodeId: string;
  latitude: number;
  longitude: number;
  uncertaintyKm?: number | null;
  observationCount?: number;
  updatedAt: number;
  nEff?: number | null;
  radiusMethod?: RadiusMethod | null;
}

/** A stored anchor that contributed to one node's estimate (issue #4609). */
export interface EstimatedPositionAnchor {
  id: number;
  nodeNum: number;
  anchorNodeNum: number;
  anchorNodeId: string;
  anchorLat: number;
  anchorLon: number;
  kind: 'traceroute' | 'neighbor';
  snrDb: number | null;
  observedAt: number;
  weight: number;
  createdAt: number;
}

/** Input for recording one contributing anchor. */
export type EstimatedPositionAnchorInput = Omit<EstimatedPositionAnchor, 'id'>;

/**
 * Rows written per `insert()` round trip when replacing anchors. Keeps the
 * statement well under SQLite's default 999-variable bind limit (11 columns per
 * row => 1,100 variables at 100 rows would exceed it, so 50 is the safe step).
 */
const ANCHOR_INSERT_BATCH = 50;

export class EstimatedPositionsRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  /** Upsert a single estimate keyed by nodeNum. */
  async upsertEstimate(input: EstimatedPositionInput): Promise<void> {
    const { estimatedPositions } = this.tables;
    const values = {
      nodeNum: input.nodeNum,
      nodeId: input.nodeId,
      latitude: input.latitude,
      longitude: input.longitude,
      uncertaintyKm: input.uncertaintyKm ?? null,
      observationCount: input.observationCount ?? 0,
      updatedAt: input.updatedAt,
      nEff: input.nEff ?? null,
      radiusMethod: input.radiusMethod ?? null,
    };
    await this.upsert(estimatedPositions, values, estimatedPositions.nodeNum, {
      nodeId: values.nodeId,
      latitude: values.latitude,
      longitude: values.longitude,
      uncertaintyKm: values.uncertaintyKm,
      observationCount: values.observationCount,
      updatedAt: values.updatedAt,
      nEff: values.nEff,
      radiusMethod: values.radiusMethod,
    });
  }

  /** Bulk upsert. Each row is keyed by nodeNum. */
  async upsertManyEstimates(inputs: EstimatedPositionInput[]): Promise<void> {
    for (const input of inputs) {
      await this.upsertEstimate(input);
    }
  }

  /** Get the estimate for a single node, or null. */
  async getByNodeNum(nodeNum: number): Promise<EstimatedPosition | null> {
    const { estimatedPositions } = this.tables;
    const rows = await this.db
      .select()
      .from(estimatedPositions)
      .where(eq(estimatedPositions.nodeNum, nodeNum))
      .limit(1);
    if (rows.length === 0) return null;
    return this.normalizeBigInts(rows[0]) as EstimatedPosition;
  }

  /** Get all estimates. */
  async getAll(): Promise<EstimatedPosition[]> {
    const { estimatedPositions } = this.tables;
    const rows = await this.db.select().from(estimatedPositions);
    return this.normalizeBigInts(rows) as EstimatedPosition[];
  }

  /**
   * Delete estimates for the given node numbers. No-op on empty input.
   *
   * Also drops those nodes' anchor rows: there is no database-level FK (the
   * table is intentionally FK-free, like its parent), so the cascade is done
   * here. Leaving anchors behind would let a node that regained a real GPS fix
   * still serve rationale for an estimate that no longer exists.
   */
  async deleteByNodeNums(nodeNums: number[]): Promise<number> {
    if (nodeNums.length === 0) return 0;
    const { estimatedPositions } = this.tables;
    await this.deleteAnchorsByNodeNums(nodeNums);
    const result = await this.db
      .delete(estimatedPositions)
      .where(inArray(estimatedPositions.nodeNum, nodeNums));
    return this.getAffectedRows(result);
  }

  /** Delete every estimate (and every anchor). Returns estimates removed. */
  async deleteAll(): Promise<number> {
    const { estimatedPositions, estimatedPositionAnchors } = this.tables;
    await this.db.delete(estimatedPositionAnchors);
    const result = await this.db.delete(estimatedPositions);
    return this.getAffectedRows(result);
  }

  // ------------------------------------------------------------------
  // Anchor rationale (issue #4609)
  // ------------------------------------------------------------------

  /**
   * Replace the stored anchors for the given nodes.
   *
   * Delete-then-insert, scoped to `nodeNums` — the estimator recomputes a
   * node's whole observation set each run, so partial updates would leave
   * anchors from a previous run mixed with the current one and misrepresent the
   * estimate. Nodes absent from `nodeNums` are untouched.
   *
   * `nodeNums` is passed separately from `anchors` on purpose: a node can solve
   * with zero retained anchors, and its stale rows must still be cleared.
   *
   * **Contract when `nodeNums` is empty (#4614).** An empty `nodeNums` with a
   * non-empty `anchors` is legal and means "replace exactly the nodes these
   * anchors belong to" — the target set is derived from `anchors`. It does NOT
   * mean "clear everything"; use `deleteAll()` for that. Both empty is a no-op.
   *
   * **Atomic (#4614).** The delete and the inserts run in one transaction, so a
   * concurrent reader never observes the window between them. Without it a read
   * landing mid-write sees zero anchors for a node whose estimate still exists,
   * and the API reports "no rationale" for a pin that has one. Per-backend
   * branch rather than `this.db.transaction`, matching
   * `meshcorePathfindingTargets.setTargets` — better-sqlite3's transaction
   * callback is synchronous while the PG and MySQL drivers are async.
   */
  async replaceAnchors(nodeNums: number[], anchors: EstimatedPositionAnchorInput[]): Promise<void> {
    if (nodeNums.length === 0 && anchors.length === 0) return;

    const targets = nodeNums.length > 0
      ? nodeNums
      : [...new Set(anchors.map((a) => a.nodeNum))];

    const { estimatedPositionAnchors } = this.tables;
    const batches: EstimatedPositionAnchorInput[][] = [];
    for (let i = 0; i < anchors.length; i += ANCHOR_INSERT_BATCH) {
      batches.push(anchors.slice(i, i + ANCHOR_INSERT_BATCH));
    }

    if (this.isSQLite()) {
      this.getSqliteDb().transaction((tx) => {
        if (targets.length > 0) {
          tx.delete(estimatedPositionAnchors)
            .where(inArray(estimatedPositionAnchors.nodeNum, targets))
            .run();
        }
        for (const batch of batches) {
          tx.insert(estimatedPositionAnchors).values(batch).run();
        }
      });
    } else if (this.isPostgres()) {
      await this.getPostgresDb().transaction(async (tx) => {
        if (targets.length > 0) {
          await tx.delete(estimatedPositionAnchors)
            .where(inArray(estimatedPositionAnchors.nodeNum, targets));
        }
        for (const batch of batches) {
          await tx.insert(estimatedPositionAnchors).values(batch);
        }
      });
    } else {
      await this.getMysqlDb().transaction(async (tx) => {
        if (targets.length > 0) {
          await tx.delete(estimatedPositionAnchors)
            .where(inArray(estimatedPositionAnchors.nodeNum, targets));
        }
        for (const batch of batches) {
          await tx.insert(estimatedPositionAnchors).values(batch);
        }
      });
    }
  }

  /**
   * Anchors for one node, strongest contribution first. `limit` caps the reply
   * independently of what is stored.
   */
  async getAnchorsByNodeNum(nodeNum: number, limit?: number): Promise<EstimatedPositionAnchor[]> {
    const { estimatedPositionAnchors } = this.tables;
    let query = this.db
      .select()
      .from(estimatedPositionAnchors)
      .where(eq(estimatedPositionAnchors.nodeNum, nodeNum))
      .orderBy(desc(estimatedPositionAnchors.weight));
    if (limit != null && limit > 0) query = query.limit(limit);
    const rows = await query;
    return this.normalizeBigInts(rows) as EstimatedPositionAnchor[];
  }

  /** Delete anchors for the given node numbers. No-op on empty input. */
  async deleteAnchorsByNodeNums(nodeNums: number[]): Promise<number> {
    if (nodeNums.length === 0) return 0;
    const { estimatedPositionAnchors } = this.tables;
    const result = await this.db
      .delete(estimatedPositionAnchors)
      .where(inArray(estimatedPositionAnchors.nodeNum, nodeNums));
    return this.getAffectedRows(result);
  }
}
