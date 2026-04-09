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
  async findPendingTraceroute(fromNodeNum: number, toNodeNum: number, sinceTimestamp: number, sourceId?: string): Promise<{ id: number } | null> {
    const { traceroutes } = this.tables;
    const conditions = [
      eq(traceroutes.fromNodeNum, fromNodeNum),
      eq(traceroutes.toNodeNum, toNodeNum),
      isNull(traceroutes.route),
      gte(traceroutes.timestamp, sinceTimestamp),
    ];
    if (sourceId !== undefined) {
      conditions.push(eq(traceroutes.sourceId, sourceId));
    }
    const result = await this.db
      .select({ id: traceroutes.id })
      .from(traceroutes)
      .where(and(...conditions))
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
  async cleanupOldTraceroutesForPair(fromNodeNum: number, toNodeNum: number, keepCount: number, sourceId?: string): Promise<void> {
    const { traceroutes } = this.tables;
    const baseConditions = [
      eq(traceroutes.fromNodeNum, fromNodeNum),
      eq(traceroutes.toNodeNum, toNodeNum),
    ];
    if (sourceId !== undefined) {
      baseConditions.push(eq(traceroutes.sourceId, sourceId));
    }
    // Get IDs to keep (most recent N)
    const toKeep = await this.db
      .select({ id: traceroutes.id })
      .from(traceroutes)
      .where(and(...baseConditions))
      .orderBy(desc(traceroutes.timestamp))
      .limit(keepCount);
    const keepIds = toKeep.map((r: any) => r.id);
    if (keepIds.length > 0) {
      // Delete all except the ones to keep in a single statement
      await this.db.delete(traceroutes).where(and(
        ...baseConditions,
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
   * Get traceroutes between two nodes, optionally scoped to a source.
   *
   * When sourceId is provided, only traceroutes recorded on that source are
   * returned — this prevents history for a node pair on one source (e.g. a
   * local TCP mesh) from bleeding into a view scoped to a different source
   * (e.g. an MQTT feed) where the same nodeNums may also be present.
   */
  async getTraceroutesByNodes(fromNodeNum: number, toNodeNum: number, limit: number = 10, sourceId?: string): Promise<DbTraceroute[]> {
    const { traceroutes } = this.tables;
    // Search bidirectionally to capture traceroutes initiated from either direction
    // This is especially important for 3rd party traceroutes (e.g., via Virtual Node)
    // where the stored direction might be reversed from what's being queried
    const result = await this.db
      .select()
      .from(traceroutes)
      .where(
        and(
          or(
            and(
              eq(traceroutes.fromNodeNum, fromNodeNum),
              eq(traceroutes.toNodeNum, toNodeNum)
            ),
            and(
              eq(traceroutes.fromNodeNum, toNodeNum),
              eq(traceroutes.toNodeNum, fromNodeNum)
            )
          ),
          this.withSourceScope(traceroutes, sourceId)
        )
      )
      .orderBy(desc(traceroutes.timestamp))
      .limit(limit);

    return this.normalizeBigInts(result) as DbTraceroute[];
  }

  /**
   * Delete traceroutes for a node, optionally scoped to a source.
   * When sourceId is provided, only rows for that source are removed so
   * deleting a node from one source does not wipe traceroutes for the same
   * nodeNum on other sources.
   * Uses .returning() for SQLite/Postgres, count-then-delete for MySQL.
   */
  async deleteTraceroutesForNode(nodeNum: number, sourceId?: string): Promise<number> {
    const { traceroutes } = this.tables;
    const condition = and(
      or(eq(traceroutes.fromNodeNum, nodeNum), eq(traceroutes.toNodeNum, nodeNum)),
      this.withSourceScope(traceroutes, sourceId)
    );

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
   * Insert a new route segment. When sourceId is provided it is written to
   * the row so downstream queries can scope segments to the source that
   * received the originating traceroute.
   */
  async insertRouteSegment(segmentData: DbRouteSegment, sourceId?: string): Promise<void> {
    const { routeSegments } = this.tables;
    const values: any = {
      fromNodeNum: segmentData.fromNodeNum,
      toNodeNum: segmentData.toNodeNum,
      fromNodeId: segmentData.fromNodeId,
      toNodeId: segmentData.toNodeId,
      distanceKm: segmentData.distanceKm,
      isRecordHolder: segmentData.isRecordHolder ?? false,
      timestamp: segmentData.timestamp,
      createdAt: segmentData.createdAt,
    };
    if (sourceId !== undefined) {
      values.sourceId = sourceId;
    }

    await this.db.insert(routeSegments).values(values);
  }

  /**
   * Get the longest currently-stored route segment, optionally scoped to a
   * single source so each source tracks its own longest link independently.
   */
  async getLongestActiveRouteSegment(sourceId?: string): Promise<DbRouteSegment | null> {
    const { routeSegments } = this.tables;
    const result = await this.db
      .select()
      .from(routeSegments)
      .where(this.withSourceScope(routeSegments, sourceId))
      .orderBy(desc(routeSegments.distanceKm))
      .limit(1);

    if (result.length === 0) return null;
    return this.normalizeBigInts(result[0]) as DbRouteSegment;
  }

  /**
   * Get the record-holder segment, optionally scoped to a single source so
   * each source maintains its own all-time record.
   */
  async getRecordHolderRouteSegment(sourceId?: string): Promise<DbRouteSegment | null> {
    const { routeSegments } = this.tables;
    const result = await this.db
      .select()
      .from(routeSegments)
      .where(and(
        eq(routeSegments.isRecordHolder, true),
        this.withSourceScope(routeSegments, sourceId),
      ))
      .orderBy(desc(routeSegments.distanceKm))
      .limit(1);

    if (result.length === 0) return null;
    return this.normalizeBigInts(result[0]) as DbRouteSegment;
  }

  /**
   * Delete route segments for a node, optionally scoped to a source so a
   * node disappearing from one source does not wipe segment history
   * belonging to another source.
   *
   * Uses .returning() for SQLite/Postgres, count-then-delete for MySQL.
   */
  async deleteRouteSegmentsForNode(nodeNum: number, sourceId?: string): Promise<number> {
    const { routeSegments } = this.tables;
    const condition = and(
      or(eq(routeSegments.fromNodeNum, nodeNum), eq(routeSegments.toNodeNum, nodeNum)),
      this.withSourceScope(routeSegments, sourceId),
    );

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
   * Clear record holder flags for a specific source (or all global/NULL
   * segments when sourceId is undefined). Used by updateRecordHolderSegment
   * so each source maintains its own record independently — unseating one
   * source's record holder must not touch another source's.
   */
  async clearRecordHolderBySource(sourceId?: string): Promise<void> {
    const { routeSegments } = this.tables;
    await this.db
      .update(routeSegments)
      .set({ isRecordHolder: false })
      .where(and(
        eq(routeSegments.isRecordHolder, true),
        this.withSourceScope(routeSegments, sourceId),
      ));
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
   * Delete old route segments that are not record holders, optionally
   * scoped to a single source.
   */
  async cleanupOldRouteSegments(days: number = 30, sourceId?: string): Promise<number> {
    const cutoff = this.now() - (days * 24 * 60 * 60 * 1000);
    const { routeSegments } = this.tables;
    const condition = and(
      lt(routeSegments.timestamp, cutoff),
      eq(routeSegments.isRecordHolder, false),
      this.withSourceScope(routeSegments, sourceId),
    );
    const toDelete = await this.db
      .select({ count: count() })
      .from(routeSegments)
      .where(condition);
    const total = Number(toDelete[0].count);
    if (total > 0) {
      await this.db.delete(routeSegments).where(condition);
    }
    return total;
  }

  /**
   * Delete all route segments, optionally scoped to a single source.
   */
  async deleteAllRouteSegments(sourceId?: string): Promise<number> {
    const { routeSegments } = this.tables;
    const scope = this.withSourceScope(routeSegments, sourceId);
    const result = await this.db
      .select({ count: count() })
      .from(routeSegments)
      .where(scope);
    const total = Number(result[0].count);
    if (scope) {
      await this.db.delete(routeSegments).where(scope);
    } else {
      await this.db.delete(routeSegments);
    }
    return total;
  }
}
