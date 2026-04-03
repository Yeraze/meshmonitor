/**
 * Neighbors Repository
 *
 * Handles neighbor info database operations.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, desc, and, gte, lt, sql, count } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType, DbNeighborInfo } from '../types.js';

/**
 * Statistics for direct neighbor (zero-hop) packets
 */
export interface DirectNeighborStats {
  nodeNum: number;
  avgRssi: number;
  packetCount: number;
  lastHeard: number;
}

/**
 * Repository for neighbor info operations
 */
export class NeighborsRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  /**
   * Insert a neighbor info record.
   * Callers must delete old records for the node first to avoid duplicates
   * (there is no unique constraint on nodeNum + neighborNodeNum).
   */
  async insertNeighborInfo(neighborData: DbNeighborInfo, sourceId?: string): Promise<void> {
    const { neighborInfo } = this.tables;
    const values: any = {
      nodeNum: neighborData.nodeNum,
      neighborNodeNum: neighborData.neighborNodeNum,
      snr: neighborData.snr ?? null,
      lastRxTime: neighborData.lastRxTime ?? null,
      timestamp: neighborData.timestamp,
      createdAt: neighborData.createdAt,
    };
    if (sourceId) {
      values.sourceId = sourceId;
    }

    await this.db.insert(neighborInfo).values(values);
  }

  /**
   * Insert multiple neighbor info records in a single query.
   * Callers must delete old records for the node first.
   */
  async insertNeighborInfoBatch(records: DbNeighborInfo[], sourceId?: string): Promise<void> {
    if (records.length === 0) return;
    const { neighborInfo } = this.tables;
    const values = records.map(r => {
      const row: any = {
        nodeNum: r.nodeNum,
        neighborNodeNum: r.neighborNodeNum,
        snr: r.snr ?? null,
        lastRxTime: r.lastRxTime ?? null,
        timestamp: r.timestamp,
        createdAt: r.createdAt,
      };
      if (sourceId) {
        row.sourceId = sourceId;
      }
      return row;
    });

    await this.db.insert(neighborInfo).values(values);
  }

  /**
   * Backwards-compatible alias for insertNeighborInfo
   * @deprecated Use insertNeighborInfo instead
   */
  async upsertNeighborInfo(neighborData: DbNeighborInfo, sourceId?: string): Promise<void> {
    return this.insertNeighborInfo(neighborData, sourceId);
  }

  /**
   * Get neighbors for a node
   */
  async getNeighborsForNode(nodeNum: number): Promise<DbNeighborInfo[]> {
    const { neighborInfo } = this.tables;
    const result = await this.db
      .select()
      .from(neighborInfo)
      .where(eq(neighborInfo.nodeNum, nodeNum))
      .orderBy(desc(neighborInfo.timestamp));

    return this.normalizeBigInts(result) as DbNeighborInfo[];
  }

  /**
   * Get all neighbor info
   */
  async getAllNeighborInfo(): Promise<DbNeighborInfo[]> {
    const { neighborInfo } = this.tables;
    const result = await this.db
      .select()
      .from(neighborInfo)
      .orderBy(desc(neighborInfo.timestamp));

    return this.normalizeBigInts(result) as DbNeighborInfo[];
  }

  /**
   * Delete neighbor info for a node
   */
  async deleteNeighborInfoForNode(nodeNum: number): Promise<void> {
    const { neighborInfo } = this.tables;
    await this.db.delete(neighborInfo).where(eq(neighborInfo.nodeNum, nodeNum));
  }

  /**
   * Get neighbor count
   */
  async getNeighborCount(): Promise<number> {
    const { neighborInfo } = this.tables;
    const result = await this.db.select({ count: count() }).from(neighborInfo);
    return Number(result[0].count);
  }

  /**
   * Get neighbor count for a specific node
   */
  async getNeighborCountForNode(nodeNum: number): Promise<number> {
    const { neighborInfo } = this.tables;
    const result = await this.db
      .select({ count: count() })
      .from(neighborInfo)
      .where(eq(neighborInfo.nodeNum, nodeNum));
    return Number(result[0].count);
  }

  /**
   * Delete all neighbor info
   */
  async deleteAllNeighborInfo(): Promise<void> {
    const { neighborInfo } = this.tables;
    await this.db.delete(neighborInfo);
  }

  /**
   * Delete neighbor info records older than the specified number of days
   */
  async cleanupOldNeighborInfo(days: number = 30): Promise<number> {
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    const { neighborInfo } = this.tables;
    const toDelete = await this.db
      .select({ count: count() })
      .from(neighborInfo)
      .where(lt(neighborInfo.timestamp, cutoff));
    const total = Number(toDelete[0].count);
    if (total > 0) {
      await this.db.delete(neighborInfo).where(lt(neighborInfo.timestamp, cutoff));
    }
    return total;
  }

  /**
   * Get direct neighbor RSSI statistics from zero-hop packets
   *
   * Queries packet_log for packets received directly (hop_start == hop_limit),
   * aggregating RSSI values to help identify likely relay nodes.
   *
   * @param hoursBack Number of hours to look back (default 24)
   * @returns Map of nodeNum to DirectNeighborStats
   */
  async getDirectNeighborRssiAsync(hoursBack: number = 24): Promise<Map<number, DirectNeighborStats>> {
    const cutoffTime = Date.now() - (hoursBack * 60 * 60 * 1000);
    const resultMap = new Map<number, DirectNeighborStats>();
    const { packetLog } = this.tables;

    const rows = await this.db
      .select({
        nodeNum: packetLog.from_node,
        avgRssi: sql<number>`AVG(${packetLog.rssi})`,
        packetCount: sql<number>`COUNT(*)`,
        lastHeard: sql<number>`MAX(${packetLog.timestamp})`,
      })
      .from(packetLog)
      .where(
        and(
          gte(packetLog.timestamp, cutoffTime),
          sql`${packetLog.hop_start} = ${packetLog.hop_limit}`,
          sql`${packetLog.rssi} IS NOT NULL`,
          sql`${packetLog.direction} = 'rx'`
        )
      )
      .groupBy(packetLog.from_node);

    for (const row of rows) {
      resultMap.set(Number(row.nodeNum), {
        nodeNum: Number(row.nodeNum),
        avgRssi: row.avgRssi,
        packetCount: row.packetCount,
        lastHeard: row.lastHeard,
      });
    }

    return resultMap;
  }
}
