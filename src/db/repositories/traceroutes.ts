/**
 * Traceroutes Repository
 *
 * Handles traceroute and route segment database operations.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, and, desc, lt, or, isNull, gte, notInArray, count } from 'drizzle-orm';
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
  async insertTraceroute(tracerouteData: DbTraceroute, sourceId?: string): Promise<void> {
    const { traceroutes } = this.tables;
    const values: any = {
      fromNodeNum: tracerouteData.fromNodeNum,
      toNodeNum: tracerouteData.toNodeNum,
      fromNodeId: tracerouteData.fromNodeId,
      toNodeId: tracerouteData.toNodeId,
      route: tracerouteData.route,
      routeBack: tracerouteData.routeBack,
      snrTowards: tracerouteData.snrTowards,
      snrBack: tracerouteData.snrBack,
      routePositions: tracerouteData.routePositions ?? null,
      channel: tracerouteData.channel ?? null,
      timestamp: tracerouteData.timestamp,
      createdAt: tracerouteData.createdAt,
    };
    if (sourceId) {
      values.sourceId = sourceId;
    }

    await this.db.insert(traceroutes).values(values);
  }

  /**
   * Find a pending traceroute (with null route) within a timeout window
   */
  async findPendingTraceroute(fromNodeNum: number, toNodeNum: number, sinceTimestamp: number): Promise<{ id: number } | null> {
    const { traceroutes } = this.tables;
    const result = await this.db
      .select({ id: traceroutes.id })
      .from(traceroutes)
      .where(
        and(
          eq(traceroutes.fromNodeNum, fromNodeNum),
          eq(traceroutes.toNodeNum, toNodeNum),
          isNull(traceroutes.route),
          gte(traceroutes.timestamp, sinceTimestamp)
        )
      )
      .orderBy(desc(traceroutes.timestamp))
      .limit(1);
    return result.length > 0 ? { id: result[0].id } : null;
  }

  /**
   * Update a pending traceroute with response data
   */
  async updateTracerouteResponse(id: number, route: string | null, routeBack: string | null, snrTowards: string | null, snrBack: string | null, timestamp: number): Promise<void> {
    const { traceroutes } = this.tables;
    await this.db
      .update(traceroutes)
      .set({ route, routeBack, snrTowards, snrBack, timestamp })
      .where(eq(traceroutes.id, id));
  }

  /**
   * Delete old traceroutes for a node pair, keeping only the most recent N.
   * Uses direct DELETE WHERE with notInArray for optimal performance.
   */
  async cleanupOldTraceroutesForPair(fromNodeNum: number, toNodeNum: number, keepCount: number): Promise<void> {
    const { traceroutes } = this.tables;
    // Get IDs to keep (most recent N)
    const toKeep = await this.db
      .select({ id: traceroutes.id })
      .from(traceroutes)
      .where(and(
        eq(traceroutes.fromNodeNum, fromNodeNum),
        eq(traceroutes.toNodeNum, toNodeNum)
      ))
      .orderBy(desc(traceroutes.timestamp))
      .limit(keepCount);
    const keepIds = toKeep.map((r: any) => r.id);
    if (keepIds.length > 0) {
      // Delete all except the ones to keep in a single statement
      await this.db.delete(traceroutes).where(and(
        eq(traceroutes.fromNodeNum, fromNodeNum),
        eq(traceroutes.toNodeNum, toNodeNum),
        notInArray(traceroutes.id, keepIds)
      ));
    }
  }

  /**
   * Get all traceroutes with pagination
   */
  async getAllTraceroutes(limit: number = 100, sourceId?: string): Promise<DbTraceroute[]> {
    const { traceroutes } = this.tables;
    const result = await this.db
      .select()
      .from(traceroutes)
      .where(this.withSourceScope(traceroutes, sourceId))
      .orderBy(desc(traceroutes.timestamp))
      .limit(limit);

    return this.normalizeBigInts(result) as DbTraceroute[];
  }

  /**
   * Get traceroutes between two nodes
   */
  async getTraceroutesByNodes(fromNodeNum: number, toNodeNum: number, limit: number = 10): Promise<DbTraceroute[]> {
    const { traceroutes } = this.tables;
    // Search bidirectionally to capture traceroutes initiated from either direction
    // This is especially important for 3rd party traceroutes (e.g., via Virtual Node)
    // where the stored direction might be reversed from what's being queried
    const result = await this.db
      .select()
      .from(traceroutes)
      .where(
        or(
          and(
            eq(traceroutes.fromNodeNum, fromNodeNum),
            eq(traceroutes.toNodeNum, toNodeNum)
          ),
          and(
            eq(traceroutes.fromNodeNum, toNodeNum),
            eq(traceroutes.toNodeNum, fromNodeNum)
          )
        )
      )
      .orderBy(desc(traceroutes.timestamp))
      .limit(limit);

    return this.normalizeBigInts(result) as DbTraceroute[];
  }

  /**
   * Delete traceroutes for a node.
   * Uses .returning() for SQLite/Postgres, count-then-delete for MySQL.
   */
  async deleteTraceroutesForNode(nodeNum: number): Promise<number> {
    const { traceroutes } = this.tables;
    const condition = or(eq(traceroutes.fromNodeNum, nodeNum), eq(traceroutes.toNodeNum, nodeNum));

    if (this.isMySQL()) {
      // MySQL doesn't support .returning(), so count first
      const countResult = await this.db
        .select({ id: traceroutes.id })
        .from(traceroutes)
        .where(condition);
      const cnt = countResult.length;
      await this.db.delete(traceroutes).where(condition);
      return cnt;
    } else {
      // SQLite and PostgreSQL support .returning()
      const deleted = await (this.db as any)
        .delete(traceroutes)
        .where(condition)
        .returning({ id: traceroutes.id });
      return deleted.length;
    }
  }

  /**
   * Cleanup old traceroutes.
   * Uses .returning() for SQLite/Postgres, count-then-delete for MySQL.
   */
  async cleanupOldTraceroutes(hours: number = 24): Promise<number> {
    const cutoff = this.now() - (hours * 60 * 60 * 1000);
    const { traceroutes } = this.tables;

    if (this.isMySQL()) {
      // MySQL doesn't support .returning(), so count first
      const countResult = await this.db
        .select({ id: traceroutes.id })
        .from(traceroutes)
        .where(lt(traceroutes.timestamp, cutoff));
      const cnt = countResult.length;
      await this.db.delete(traceroutes).where(lt(traceroutes.timestamp, cutoff));
      return cnt;
    } else {
      // SQLite and PostgreSQL support .returning()
      const deleted = await (this.db as any)
        .delete(traceroutes)
        .where(lt(traceroutes.timestamp, cutoff))
        .returning({ id: traceroutes.id });
      return deleted.length;
    }
  }

  /**
   * Get traceroute count
   */
  async getTracerouteCount(): Promise<number> {
    const { traceroutes } = this.tables;
    const result = await this.db.select({ count: count() }).from(traceroutes);
    return Number(result[0].count);
  }

  // ============ ROUTE SEGMENTS ============

  /**
   * Insert a new route segment
   */
  async insertRouteSegment(segmentData: DbRouteSegment): Promise<void> {
    const { routeSegments } = this.tables;
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

    await this.db.insert(routeSegments).values(values);
  }

  /**
   * Get longest active route segment
   */
  async getLongestActiveRouteSegment(): Promise<DbRouteSegment | null> {
    const { routeSegments } = this.tables;
    const result = await this.db
      .select()
      .from(routeSegments)
      .orderBy(desc(routeSegments.distanceKm))
      .limit(1);

    if (result.length === 0) return null;
    return this.normalizeBigInts(result[0]) as DbRouteSegment;
  }

  /**
   * Get record holder route segment
   */
  async getRecordHolderRouteSegment(): Promise<DbRouteSegment | null> {
    const { routeSegments } = this.tables;
    const result = await this.db
      .select()
      .from(routeSegments)
      .where(eq(routeSegments.isRecordHolder, true))
      .orderBy(desc(routeSegments.distanceKm))
      .limit(1);

    if (result.length === 0) return null;
    return this.normalizeBigInts(result[0]) as DbRouteSegment;
  }

  /**
   * Delete route segments for a node.
   * Uses .returning() for SQLite/Postgres, count-then-delete for MySQL.
   */
  async deleteRouteSegmentsForNode(nodeNum: number): Promise<number> {
    const { routeSegments } = this.tables;
    const condition = or(eq(routeSegments.fromNodeNum, nodeNum), eq(routeSegments.toNodeNum, nodeNum));

    if (this.isMySQL()) {
      // MySQL doesn't support .returning(), so count first
      const countResult = await this.db
        .select({ id: routeSegments.id })
        .from(routeSegments)
        .where(condition);
      const cnt = countResult.length;
      await this.db.delete(routeSegments).where(condition);
      return cnt;
    } else {
      // SQLite and PostgreSQL support .returning()
      const deleted = await (this.db as any)
        .delete(routeSegments)
        .where(condition)
        .returning({ id: routeSegments.id });
      return deleted.length;
    }
  }

  /**
   * Set record holder status
   */
  async setRecordHolder(id: number, isRecordHolder: boolean): Promise<void> {
    const { routeSegments } = this.tables;
    await this.db
      .update(routeSegments)
      .set({ isRecordHolder })
      .where(eq(routeSegments.id, id));
  }

  /**
   * Clear all record holder flags
   */
  async clearAllRecordHolders(): Promise<void> {
    const { routeSegments } = this.tables;
    await this.db
      .update(routeSegments)
      .set({ isRecordHolder: false })
      .where(eq(routeSegments.isRecordHolder, true));
  }

  /**
   * Delete all traceroutes
   */
  async deleteAllTraceroutes(): Promise<number> {
    const { traceroutes } = this.tables;
    const result = await this.db.select({ count: count() }).from(traceroutes);
    const total = Number(result[0].count);
    await this.db.delete(traceroutes);
    return total;
  }

  /**
   * Delete old route segments that are not record holders
   */
  async cleanupOldRouteSegments(days: number = 30): Promise<number> {
    const cutoff = this.now() - (days * 24 * 60 * 60 * 1000);
    const { routeSegments } = this.tables;
    const toDelete = await this.db
      .select({ count: count() })
      .from(routeSegments)
      .where(and(lt(routeSegments.timestamp, cutoff), eq(routeSegments.isRecordHolder, false)));
    const total = Number(toDelete[0].count);
    if (total > 0) {
      await this.db.delete(routeSegments)
        .where(and(lt(routeSegments.timestamp, cutoff), eq(routeSegments.isRecordHolder, false)));
    }
    return total;
  }

  /**
   * Delete all route segments
   */
  async deleteAllRouteSegments(): Promise<number> {
    const { routeSegments } = this.tables;
    const result = await this.db.select({ count: count() }).from(routeSegments);
    const total = Number(result[0].count);
    await this.db.delete(routeSegments);
    return total;
  }
}
