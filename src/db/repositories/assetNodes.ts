/**
 * Asset Nodes Repository (#5354, Asset Tracking)
 *
 * The operator's "tracked asset" flag for a node, with its telemetry retention
 * in days. GLOBAL — keyed by the physical `nodeNum`, not scoped by source; see
 * `src/db/schema/assetNodes.ts` for why.
 *
 * At most one row per node, so a write is an upsert. Clearing the flag deletes
 * the row.
 */
import { eq } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';
import { logger } from '../../utils/logger.js';

export interface AssetNode {
  nodeNum: number;
  retentionDays: number;
  updatedBy: number | null;
  updatedAt: number;
}

/** The per-node settings the payload overlay and the purge consume. */
export interface AssetNodeSettings {
  retentionDays: number;
}

export class AssetNodesRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- row shape varies by dialect; mirrors sibling repositories
  private map(row: any): AssetNode {
    return {
      // nodeNum is BIGINT on PG/MySQL; coerce so comparisons against a JS number work.
      nodeNum: Number(row.nodeNum),
      retentionDays: Number(row.retentionDays),
      updatedBy: row.updatedBy === null || row.updatedBy === undefined ? null : Number(row.updatedBy),
      updatedAt: Number(row.updatedAt),
    };
  }

  /** Every asset. Small table — one row per flagged node. */
  async getAllAsync(): Promise<AssetNode[]> {
    const { assetNodes } = this.tables;
    const rows = await this.db.select().from(assetNodes);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see map()
    return rows.map((r: any) => this.map(r));
  }

  /** nodeNum → { retentionDays }, the shape the payload overlay and purge consume. */
  async getMapAsync(): Promise<Map<number, AssetNodeSettings>> {
    const all = await this.getAllAsync();
    return new Map(all.map((a) => [a.nodeNum, { retentionDays: a.retentionDays }]));
  }

  /** One node's asset row, or null when it is not an asset. */
  async getAsync(nodeNum: number): Promise<AssetNode | null> {
    const { assetNodes } = this.tables;
    const num = Number(nodeNum) >>> 0;
    const rows = await this.db.select().from(assetNodes).where(eq(assetNodes.nodeNum, num)).limit(1);
    return rows.length > 0 ? this.map(rows[0]) : null;
  }

  /** Mark a node as an asset, or change its retention. An upsert. */
  async setAsync(nodeNum: number, retentionDays: number, updatedBy?: number | null): Promise<AssetNode> {
    const { assetNodes } = this.tables;
    const num = Number(nodeNum) >>> 0;
    const now = this.now();
    const author = typeof updatedBy === 'number' && Number.isFinite(updatedBy) ? updatedBy : null;

    const existing = await this.db
      .select()
      .from(assetNodes)
      .where(eq(assetNodes.nodeNum, num))
      .limit(1);

    const update = () => this.db
      .update(assetNodes)
      .set({ retentionDays, updatedBy: author, updatedAt: now })
      .where(eq(assetNodes.nodeNum, num));

    if (existing.length > 0) {
      await update();
    } else {
      try {
        await this.db
          .insert(assetNodes)
          .values({ nodeNum: num, retentionDays, updatedBy: author, updatedAt: now });
      } catch (err) {
        // Two first writes for the same node can both miss the SELECT above; the
        // loser hits the primary key. If the row now exists that is the race, so
        // apply this write as an update. Otherwise surface the real failure.
        const raced = await this.db
          .select()
          .from(assetNodes)
          .where(eq(assetNodes.nodeNum, num))
          .limit(1);
        if (raced.length === 0) throw err;
        logger.debug(`Asset insert for node ${num} lost a race, updating instead`);
        await update();
      }
    }
    logger.debug(`Set node ${num} as a tracked asset (${retentionDays} days)`);
    return { nodeNum: num, retentionDays, updatedBy: author, updatedAt: now };
  }

  /** Clear the asset flag. Silent when the node was not an asset. */
  async clearAsync(nodeNum: number): Promise<void> {
    const { assetNodes } = this.tables;
    const num = Number(nodeNum) >>> 0;
    await this.db.delete(assetNodes).where(eq(assetNodes.nodeNum, num));
    logger.debug(`Cleared asset flag for node ${num}`);
  }
}
