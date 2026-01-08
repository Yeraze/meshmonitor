/**
 * Traceroutes Repository
 *
 * Handles traceroute and route segment database operations.
 * Supports both SQLite and PostgreSQL through Drizzle ORM.
 */
import { eq, and, desc, lt, or } from 'drizzle-orm';
import {
  traceroutesSqlite, traceroutesPostgres,
  routeSegmentsSqlite, routeSegmentsPostgres,
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
    } else {
      const db = this.getPostgresDb();
      await db.insert(traceroutesPostgres).values(values);
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
}
