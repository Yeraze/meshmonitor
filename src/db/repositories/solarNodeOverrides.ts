/**
 * Solar Node Overrides Repository (#3195)
 *
 * The operator's manual solar classification for a node, overriding the
 * telemetry pattern detector. GLOBAL — keyed by the physical `nodeNum`, not
 * scoped by source; see `src/db/schema/solarNodeOverrides.ts` for why.
 *
 * At most one row per node, so a write is an upsert. Clearing an override
 * deletes the row, which returns the node to auto-detection.
 */
import { eq } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';
import { logger } from '../../utils/logger.js';

export interface SolarNodeOverride {
  nodeNum: number;
  isSolar: boolean;
  updatedBy: string | null;
  updatedAt: number;
}

export class SolarNodeOverridesRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- row shape varies by dialect; mirrors sibling repositories
  private map(row: any): SolarNodeOverride {
    return {
      // nodeNum is BIGINT on PG/MySQL; coerce so comparisons against a JS number work.
      nodeNum: Number(row.nodeNum),
      // SQLite returns 0/1 unless Drizzle's boolean mode mapped it; accept both.
      isSolar: row.isSolar === true || row.isSolar === 1,
      updatedBy: row.updatedBy ?? null,
      updatedAt: Number(row.updatedAt),
    };
  }

  /** Every override. Small table — one row per manually classified node. */
  async getAllAsync(): Promise<SolarNodeOverride[]> {
    const { solarNodeOverrides } = this.tables;
    const rows = await this.db.select().from(solarNodeOverrides);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see map()
    return rows.map((r: any) => this.map(r));
  }

  /** nodeNum → isSolar, the shape the solar analysis consumes. */
  async getMapAsync(): Promise<Map<number, boolean>> {
    const all = await this.getAllAsync();
    return new Map(all.map((o) => [o.nodeNum, o.isSolar]));
  }

  /** Force a node to be treated as solar (`true`) or not solar (`false`). */
  async setAsync(nodeNum: number, isSolar: boolean, updatedBy?: string | null): Promise<SolarNodeOverride> {
    const { solarNodeOverrides } = this.tables;
    const num = Number(nodeNum) >>> 0;
    const now = this.now();
    const author = (updatedBy ?? '').trim() || null;

    const existing = await this.db
      .select()
      .from(solarNodeOverrides)
      .where(eq(solarNodeOverrides.nodeNum, num))
      .limit(1);

    if (existing.length > 0) {
      await this.db
        .update(solarNodeOverrides)
        .set({ isSolar, updatedBy: author, updatedAt: now })
        .where(eq(solarNodeOverrides.nodeNum, num));
    } else {
      await this.db
        .insert(solarNodeOverrides)
        .values({ nodeNum: num, isSolar, updatedBy: author, updatedAt: now });
    }
    logger.debug(`Set solar override for node ${num} → ${isSolar ? 'solar' : 'not solar'}`);
    return { nodeNum: num, isSolar, updatedBy: author, updatedAt: now };
  }

  /** Return a node to auto-detection. Silent when no override existed. */
  async clearAsync(nodeNum: number): Promise<void> {
    const { solarNodeOverrides } = this.tables;
    const num = Number(nodeNum) >>> 0;
    await this.db.delete(solarNodeOverrides).where(eq(solarNodeOverrides.nodeNum, num));
    logger.debug(`Cleared solar override for node ${num}`);
  }
}
