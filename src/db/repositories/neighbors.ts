/**
 * Neighbors Repository
 *
 * Handles neighbor info database operations.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, desc, and, gte, sql, count } from 'drizzle-orm';
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
   * Insert or update neighbor info
   */
  async upsertNeighborInfo(neighborData: DbNeighborInfo): Promise<void> {
    const { neighborInfo } = this.tables;
    const values = {
      nodeNum: neighborData.nodeNum,
      neighborNodeNum: neighborData.neighborNodeNum,
      snr: neighborData.snr ?? null,
      lastRxTime: neighborData.lastRxTime ?? null,
      timestamp: neighborData.timestamp,
      createdAt: neighborData.createdAt,
    };

    await this.db.insert(neighborInfo).values(values);
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
  async deleteNeighborInfoForNode(nodeNum: number): Promise<number> {
    const { neighborInfo } = this.tables;
    const [{ deletedCount }] = await this.db
      .select({ deletedCount: count() })
      .from(neighborInfo)
      .where(eq(neighborInfo.nodeNum, nodeNum));
    await this.db.delete(neighborInfo).where(eq(neighborInfo.nodeNum, nodeNum));
    return deletedCount;
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
   * Delete all neighbor info
   */
  async deleteAllNeighborInfo(): Promise<number> {
    const { neighborInfo } = this.tables;
    const result = await this.db.select({ count: count() }).from(neighborInfo);
    const deleteCount = Number(result[0].count);
    await this.db.delete(neighborInfo);
    return deleteCount;
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
    const cutoffTime = Math.floor(Date.now() / 1000) - (hoursBack * 60 * 60);
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
