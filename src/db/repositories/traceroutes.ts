/**
 * Traceroutes Repository
 *
 * Handles traceroute and route segment database operations.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, and, desc, lt, or, isNull, gte } from 'drizzle-orm';
import {
  traceroutesSqlite, traceroutesPostgres, traceroutesMysql,
  routeSegmentsSqlite, routeSegmentsPostgres, routeSegmentsMysql,
} from '../schema/traceroutes.js';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType, DbTraceroute, DbRouteSegment } from '../types.js';

/**
 * Repository for traceroute operations
 */
export class TraceroutesRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  // ============ TRACEROUTES ============

  /**
   * Insert a new traceroute
   */
  async insertTraceroute(tracerouteData: DbTraceroute): Promise<void> {
    const values = {
      fromNodeNum: tracerouteData.fromNodeNum,
      toNodeNum: tracerouteData.toNodeNum,
      fromNodeId: tracerouteData.fromNodeId,
      toNodeId: tracerouteData.toNodeId,
      route: tracerouteData.route,
      routeBack: tracerouteData.routeBack,
      snrTowards: tracerouteData.snrTowards,
      snrBack: tracerouteData.snrBack,
      timestamp: tracerouteData.timestamp,
      createdAt: tracerouteData.createdAt,
    };

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db.insert(traceroutesSqlite).values(values);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      await db.insert(traceroutesMysql).values(values);
    } else {
      const db = this.getPostgresDb();
      await db.insert(traceroutesPostgres).values(values);
    }
  }

  /**
   * Find a pending traceroute (with null route) within a timeout window
   */
  async findPendingTraceroute(fromNodeNum: number, toNodeNum: number, sinceTimestamp: number): Promise<{ id: number } | null> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db
        .select({ id: traceroutesSqlite.id })
        .from(traceroutesSqlite)
        .where(
          and(
            eq(traceroutesSqlite.fromNodeNum, fromNodeNum),
            eq(traceroutesSqlite.toNodeNum, toNodeNum),
            isNull(traceroutesSqlite.route),
            gte(traceroutesSqlite.timestamp, sinceTimestamp)
          )
        )
        .orderBy(desc(traceroutesSqlite.timestamp))
        .limit(1);
      return result.length > 0 ? { id: result[0].id } : null;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db
        .select({ id: traceroutesMysql.id })
        .from(traceroutesMysql)
        .where(
          and(
            eq(traceroutesMysql.fromNodeNum, fromNodeNum),
            eq(traceroutesMysql.toNodeNum, toNodeNum),
            isNull(traceroutesMysql.route),
            gte(traceroutesMysql.timestamp, sinceTimestamp)
          )
        )
        .orderBy(desc(traceroutesMysql.timestamp))
        .limit(1);
      return result.length > 0 ? { id: result[0].id } : null;
    } else {
      const db = this.getPostgresDb();
      const result = await db
        .select({ id: traceroutesPostgres.id })
        .from(traceroutesPostgres)
        .where(
          and(
            eq(traceroutesPostgres.fromNodeNum, fromNodeNum),
            eq(traceroutesPostgres.toNodeNum, toNodeNum),
            isNull(traceroutesPostgres.route),
            gte(traceroutesPostgres.timestamp, sinceTimestamp)
          )
        )
        .orderBy(desc(traceroutesPostgres.timestamp))
        .limit(1);
      return result.length > 0 ? { id: result[0].id } : null;
    }
  }

  /**
   * Update a pending traceroute with response data
   */
  async updateTracerouteResponse(id: number, route: string | null, routeBack: string | null, snrTowards: string | null, snrBack: string | null, timestamp: number): Promise<void> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db
        .update(traceroutesSqlite)
        .set({ route, routeBack, snrTowards, snrBack, timestamp })
        .where(eq(traceroutesSqlite.id, id));
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      await db
        .update(traceroutesMysql)
        .set({ route, routeBack, snrTowards, snrBack, timestamp })
        .where(eq(traceroutesMysql.id, id));
    } else {
      const db = this.getPostgresDb();
      await db
        .update(traceroutesPostgres)
        .set({ route, routeBack, snrTowards, snrBack, timestamp })
        .where(eq(traceroutesPostgres.id, id));
    }
  }

  /**
   * Delete old traceroutes for a node pair, keeping only the most recent N
   */
  async cleanupOldTraceroutesForPair(fromNodeNum: number, toNodeNum: number, keepCount: number): Promise<void> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      // Get IDs to keep
      const toKeep = await db
        .select({ id: traceroutesSqlite.id })
        .from(traceroutesSqlite)
        .where(
          and(
            eq(traceroutesSqlite.fromNodeNum, fromNodeNum),
            eq(traceroutesSqlite.toNodeNum, toNodeNum)
          )
        )
        .orderBy(desc(traceroutesSqlite.timestamp))
        .limit(keepCount);
      const keepIds = toKeep.map(r => r.id);
      if (keepIds.length > 0) {
        // Delete all except the ones to keep
        const allForPair = await db
          .select({ id: traceroutesSqlite.id })
          .from(traceroutesSqlite)
          .where(
            and(
              eq(traceroutesSqlite.fromNodeNum, fromNodeNum),
              eq(traceroutesSqlite.toNodeNum, toNodeNum)
            )
          );
        for (const row of allForPair) {
          if (!keepIds.includes(row.id)) {
            await db.delete(traceroutesSqlite).where(eq(traceroutesSqlite.id, row.id));
          }
        }
      }
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const toKeep = await db
        .select({ id: traceroutesMysql.id })
        .from(traceroutesMysql)
        .where(
          and(
            eq(traceroutesMysql.fromNodeNum, fromNodeNum),
            eq(traceroutesMysql.toNodeNum, toNodeNum)
          )
        )
        .orderBy(desc(traceroutesMysql.timestamp))
        .limit(keepCount);
      const keepIds = toKeep.map(r => r.id);
      if (keepIds.length > 0) {
        const allForPair = await db
          .select({ id: traceroutesMysql.id })
          .from(traceroutesMysql)
          .where(
            and(
              eq(traceroutesMysql.fromNodeNum, fromNodeNum),
              eq(traceroutesMysql.toNodeNum, toNodeNum)
            )
          );
        for (const row of allForPair) {
          if (!keepIds.includes(row.id)) {
            await db.delete(traceroutesMysql).where(eq(traceroutesMysql.id, row.id));
          }
        }
      }
    } else {
      const db = this.getPostgresDb();
      const toKeep = await db
        .select({ id: traceroutesPostgres.id })
        .from(traceroutesPostgres)
        .where(
          and(
            eq(traceroutesPostgres.fromNodeNum, fromNodeNum),
            eq(traceroutesPostgres.toNodeNum, toNodeNum)
          )
        )
        .orderBy(desc(traceroutesPostgres.timestamp))
        .limit(keepCount);
      const keepIds = toKeep.map(r => r.id);
      if (keepIds.length > 0) {
        const allForPair = await db
          .select({ id: traceroutesPostgres.id })
          .from(traceroutesPostgres)
          .where(
            and(
              eq(traceroutesPostgres.fromNodeNum, fromNodeNum),
              eq(traceroutesPostgres.toNodeNum, toNodeNum)
            )
          );
        for (const row of allForPair) {
          if (!keepIds.includes(row.id)) {
            await db.delete(traceroutesPostgres).where(eq(traceroutesPostgres.id, row.id));
          }
        }
      }
    }
  }

  /**
   * Get all traceroutes with pagination
   */
  async getAllTraceroutes(limit: number = 100): Promise<DbTraceroute[]> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db
        .select()
        .from(traceroutesSqlite)
        .orderBy(desc(traceroutesSqlite.timestamp))
        .limit(limit);

      return result.map(t => this.normalizeBigInts(t) as DbTraceroute);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db
        .select()
        .from(traceroutesMysql)
        .orderBy(desc(traceroutesMysql.timestamp))
        .limit(limit);

      return result as DbTraceroute[];
    } else {
      const db = this.getPostgresDb();
      const result = await db
        .select()
        .from(traceroutesPostgres)
        .orderBy(desc(traceroutesPostgres.timestamp))
        .limit(limit);

      return result as DbTraceroute[];
    }
  }

  /**
   * Get traceroutes between two nodes
   */
  async getTraceroutesByNodes(fromNodeNum: number, toNodeNum: number, limit: number = 10): Promise<DbTraceroute[]> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db
        .select()
        .from(traceroutesSqlite)
        .where(
          and(
            eq(traceroutesSqlite.fromNodeNum, fromNodeNum),
            eq(traceroutesSqlite.toNodeNum, toNodeNum)
          )
        )
        .orderBy(desc(traceroutesSqlite.timestamp))
        .limit(limit);

      return result.map(t => this.normalizeBigInts(t) as DbTraceroute);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db
        .select()
        .from(traceroutesMysql)
        .where(
          and(
            eq(traceroutesMysql.fromNodeNum, fromNodeNum),
            eq(traceroutesMysql.toNodeNum, toNodeNum)
          )
        )
        .orderBy(desc(traceroutesMysql.timestamp))
        .limit(limit);

      return result as DbTraceroute[];
    } else {
      const db = this.getPostgresDb();
      const result = await db
        .select()
        .from(traceroutesPostgres)
        .where(
          and(
            eq(traceroutesPostgres.fromNodeNum, fromNodeNum),
            eq(traceroutesPostgres.toNodeNum, toNodeNum)
          )
        )
        .orderBy(desc(traceroutesPostgres.timestamp))
        .limit(limit);

      return result as DbTraceroute[];
    }
  }

  /**
   * Delete traceroutes for a node
   */
  async deleteTraceroutesForNode(nodeNum: number): Promise<number> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const toDelete = await db
        .select({ id: traceroutesSqlite.id })
        .from(traceroutesSqlite)
        .where(
          or(
            eq(traceroutesSqlite.fromNodeNum, nodeNum),
            eq(traceroutesSqlite.toNodeNum, nodeNum)
          )
        );

      for (const tr of toDelete) {
        await db.delete(traceroutesSqlite).where(eq(traceroutesSqlite.id, tr.id));
      }
      return toDelete.length;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const toDelete = await db
        .select({ id: traceroutesMysql.id })
        .from(traceroutesMysql)
        .where(
          or(
            eq(traceroutesMysql.fromNodeNum, nodeNum),
            eq(traceroutesMysql.toNodeNum, nodeNum)
          )
        );

      for (const tr of toDelete) {
        await db.delete(traceroutesMysql).where(eq(traceroutesMysql.id, tr.id));
      }
      return toDelete.length;
    } else {
      const db = this.getPostgresDb();
      const toDelete = await db
        .select({ id: traceroutesPostgres.id })
        .from(traceroutesPostgres)
        .where(
          or(
            eq(traceroutesPostgres.fromNodeNum, nodeNum),
            eq(traceroutesPostgres.toNodeNum, nodeNum)
          )
        );

      for (const tr of toDelete) {
        await db.delete(traceroutesPostgres).where(eq(traceroutesPostgres.id, tr.id));
      }
      return toDelete.length;
    }
  }

  /**
   * Cleanup old traceroutes
   */
  async cleanupOldTraceroutes(hours: number = 24): Promise<number> {
    const cutoff = this.now() - (hours * 60 * 60 * 1000);

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const toDelete = await db
        .select({ id: traceroutesSqlite.id })
        .from(traceroutesSqlite)
        .where(lt(traceroutesSqlite.timestamp, cutoff));

      for (const tr of toDelete) {
        await db.delete(traceroutesSqlite).where(eq(traceroutesSqlite.id, tr.id));
      }
      return toDelete.length;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const toDelete = await db
        .select({ id: traceroutesMysql.id })
        .from(traceroutesMysql)
        .where(lt(traceroutesMysql.timestamp, cutoff));

      for (const tr of toDelete) {
        await db.delete(traceroutesMysql).where(eq(traceroutesMysql.id, tr.id));
      }
      return toDelete.length;
    } else {
      const db = this.getPostgresDb();
      const toDelete = await db
        .select({ id: traceroutesPostgres.id })
        .from(traceroutesPostgres)
        .where(lt(traceroutesPostgres.timestamp, cutoff));

      for (const tr of toDelete) {
        await db.delete(traceroutesPostgres).where(eq(traceroutesPostgres.id, tr.id));
      }
      return toDelete.length;
    }
  }

  /**
   * Get traceroute count
   */
  async getTracerouteCount(): Promise<number> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db.select().from(traceroutesSqlite);
      return result.length;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db.select().from(traceroutesMysql);
      return result.length;
    } else {
      const db = this.getPostgresDb();
      const result = await db.select().from(traceroutesPostgres);
      return result.length;
    }
  }

  // ============ ROUTE SEGMENTS ============

  /**
   * Insert a new route segment
   */
  async insertRouteSegment(segmentData: DbRouteSegment): Promise<void> {
    const values = {
      fromNodeNum: segmentData.fromNodeNum,
      toNodeNum: segmentData.toNodeNum,
      fromNodeId: segmentData.fromNodeId,
      toNodeId: segmentData.toNodeId,
      distanceKm: segmentData.distanceKm,
      isRecordHolder: segmentData.isRecordHolder ?? false,
      timestamp: segmentData.timestamp,
      createdAt: segmentData.createdAt,
    };

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db.insert(routeSegmentsSqlite).values(values);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      await db.insert(routeSegmentsMysql).values(values);
    } else {
      const db = this.getPostgresDb();
      await db.insert(routeSegmentsPostgres).values(values);
    }
  }

  /**
   * Get longest active route segment
   */
  async getLongestActiveRouteSegment(): Promise<DbRouteSegment | null> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db
        .select()
        .from(routeSegmentsSqlite)
        .orderBy(desc(routeSegmentsSqlite.distanceKm))
        .limit(1);

      if (result.length === 0) return null;
      return this.normalizeBigInts(result[0]) as DbRouteSegment;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db
        .select()
        .from(routeSegmentsMysql)
        .orderBy(desc(routeSegmentsMysql.distanceKm))
        .limit(1);

      if (result.length === 0) return null;
      return result[0] as DbRouteSegment;
    } else {
      const db = this.getPostgresDb();
      const result = await db
        .select()
        .from(routeSegmentsPostgres)
        .orderBy(desc(routeSegmentsPostgres.distanceKm))
        .limit(1);

      if (result.length === 0) return null;
      return result[0] as DbRouteSegment;
    }
  }

  /**
   * Get record holder route segment
   */
  async getRecordHolderRouteSegment(): Promise<DbRouteSegment | null> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db
        .select()
        .from(routeSegmentsSqlite)
        .where(eq(routeSegmentsSqlite.isRecordHolder, true))
        .orderBy(desc(routeSegmentsSqlite.distanceKm))
        .limit(1);

      if (result.length === 0) return null;
      return this.normalizeBigInts(result[0]) as DbRouteSegment;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db
        .select()
        .from(routeSegmentsMysql)
        .where(eq(routeSegmentsMysql.isRecordHolder, true))
        .orderBy(desc(routeSegmentsMysql.distanceKm))
        .limit(1);

      if (result.length === 0) return null;
      return result[0] as DbRouteSegment;
    } else {
      const db = this.getPostgresDb();
      const result = await db
        .select()
        .from(routeSegmentsPostgres)
        .where(eq(routeSegmentsPostgres.isRecordHolder, true))
        .orderBy(desc(routeSegmentsPostgres.distanceKm))
        .limit(1);

      if (result.length === 0) return null;
      return result[0] as DbRouteSegment;
    }
  }

  /**
   * Delete route segments for a node
   */
  async deleteRouteSegmentsForNode(nodeNum: number): Promise<number> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const toDelete = await db
        .select({ id: routeSegmentsSqlite.id })
        .from(routeSegmentsSqlite)
        .where(
          or(
            eq(routeSegmentsSqlite.fromNodeNum, nodeNum),
            eq(routeSegmentsSqlite.toNodeNum, nodeNum)
          )
        );

      for (const seg of toDelete) {
        await db.delete(routeSegmentsSqlite).where(eq(routeSegmentsSqlite.id, seg.id));
      }
      return toDelete.length;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const toDelete = await db
        .select({ id: routeSegmentsMysql.id })
        .from(routeSegmentsMysql)
        .where(
          or(
            eq(routeSegmentsMysql.fromNodeNum, nodeNum),
            eq(routeSegmentsMysql.toNodeNum, nodeNum)
          )
        );

      for (const seg of toDelete) {
        await db.delete(routeSegmentsMysql).where(eq(routeSegmentsMysql.id, seg.id));
      }
      return toDelete.length;
    } else {
      const db = this.getPostgresDb();
      const toDelete = await db
        .select({ id: routeSegmentsPostgres.id })
        .from(routeSegmentsPostgres)
        .where(
          or(
            eq(routeSegmentsPostgres.fromNodeNum, nodeNum),
            eq(routeSegmentsPostgres.toNodeNum, nodeNum)
          )
        );

      for (const seg of toDelete) {
        await db.delete(routeSegmentsPostgres).where(eq(routeSegmentsPostgres.id, seg.id));
      }
      return toDelete.length;
    }
  }

  /**
   * Set record holder status
   */
  async setRecordHolder(id: number, isRecordHolder: boolean): Promise<void> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db
        .update(routeSegmentsSqlite)
        .set({ isRecordHolder })
        .where(eq(routeSegmentsSqlite.id, id));
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      await db
        .update(routeSegmentsMysql)
        .set({ isRecordHolder })
        .where(eq(routeSegmentsMysql.id, id));
    } else {
      const db = this.getPostgresDb();
      await db
        .update(routeSegmentsPostgres)
        .set({ isRecordHolder })
        .where(eq(routeSegmentsPostgres.id, id));
    }
  }

  /**
   * Clear all record holder flags
   */
  async clearAllRecordHolders(): Promise<void> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const holders = await db
        .select({ id: routeSegmentsSqlite.id })
        .from(routeSegmentsSqlite)
        .where(eq(routeSegmentsSqlite.isRecordHolder, true));

      for (const h of holders) {
        await db
          .update(routeSegmentsSqlite)
          .set({ isRecordHolder: false })
          .where(eq(routeSegmentsSqlite.id, h.id));
      }
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const holders = await db
        .select({ id: routeSegmentsMysql.id })
        .from(routeSegmentsMysql)
        .where(eq(routeSegmentsMysql.isRecordHolder, true));

      for (const h of holders) {
        await db
          .update(routeSegmentsMysql)
          .set({ isRecordHolder: false })
          .where(eq(routeSegmentsMysql.id, h.id));
      }
    } else {
      const db = this.getPostgresDb();
      const holders = await db
        .select({ id: routeSegmentsPostgres.id })
        .from(routeSegmentsPostgres)
        .where(eq(routeSegmentsPostgres.isRecordHolder, true));

      for (const h of holders) {
        await db
          .update(routeSegmentsPostgres)
          .set({ isRecordHolder: false })
          .where(eq(routeSegmentsPostgres.id, h.id));
      }
    }
  }

  /**
   * Delete all traceroutes
   */
  async deleteAllTraceroutes(): Promise<number> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const count = await db
        .select({ id: traceroutesSqlite.id })
        .from(traceroutesSqlite);
      await db.delete(traceroutesSqlite);
      return count.length;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const count = await db
        .select({ id: traceroutesMysql.id })
        .from(traceroutesMysql);
      await db.delete(traceroutesMysql);
      return count.length;
    } else {
      const db = this.getPostgresDb();
      const count = await db
        .select({ id: traceroutesPostgres.id })
        .from(traceroutesPostgres);
      await db.delete(traceroutesPostgres);
      return count.length;
    }
  }

  /**
   * Delete all route segments
   */
  async deleteAllRouteSegments(): Promise<number> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const count = await db
        .select({ id: routeSegmentsSqlite.id })
        .from(routeSegmentsSqlite);
      await db.delete(routeSegmentsSqlite);
      return count.length;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const count = await db
        .select({ id: routeSegmentsMysql.id })
        .from(routeSegmentsMysql);
      await db.delete(routeSegmentsMysql);
      return count.length;
    } else {
      const db = this.getPostgresDb();
      const count = await db
        .select({ id: routeSegmentsPostgres.id })
        .from(routeSegmentsPostgres);
      await db.delete(routeSegmentsPostgres);
      return count.length;
    }
  }
}
