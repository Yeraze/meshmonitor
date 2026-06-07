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
import { eq, inArray } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

/** A single estimated position row. */
export interface EstimatedPosition {
  nodeNum: number;
  nodeId: string;
  latitude: number;
  longitude: number;
  uncertaintyKm: number | null;
  observationCount: number;
  updatedAt: number;
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
}

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
    };
    await this.upsert(estimatedPositions, values, estimatedPositions.nodeNum, {
      nodeId: values.nodeId,
      latitude: values.latitude,
      longitude: values.longitude,
      uncertaintyKm: values.uncertaintyKm,
      observationCount: values.observationCount,
      updatedAt: values.updatedAt,
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

  /** Delete estimates for the given node numbers. No-op on empty input. */
  async deleteByNodeNums(nodeNums: number[]): Promise<number> {
    if (nodeNums.length === 0) return 0;
    const { estimatedPositions } = this.tables;
    const result = await this.db
      .delete(estimatedPositions)
      .where(inArray(estimatedPositions.nodeNum, nodeNums));
    return this.getAffectedRows(result);
  }

  /** Delete every estimate. Returns the number of rows removed. */
  async deleteAll(): Promise<number> {
    const { estimatedPositions } = this.tables;
    const result = await this.db.delete(estimatedPositions);
    return this.getAffectedRows(result);
  }
}
