/**
 * Misc Repository
 *
 * Handles solar estimates and auto-traceroute nodes database operations.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, desc, asc, and, gte, lte } from 'drizzle-orm';
import {
  solarEstimatesSqlite,
  solarEstimatesPostgres,
  solarEstimatesMysql,
  autoTracerouteNodesSqlite,
  autoTracerouteNodesPostgres,
  autoTracerouteNodesMysql,
} from '../schema/misc.js';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

export interface SolarEstimate {
  id?: number;
  timestamp: number;
  watt_hours: number;
  fetched_at: number;
  created_at?: number | null;
}

export interface AutoTracerouteNode {
  id?: number;
  nodeNum: number;
  enabled?: boolean;
  createdAt: number;
}

/**
 * Repository for miscellaneous operations (solar estimates, auto-traceroute nodes)
 */
export class MiscRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  // ============ SOLAR ESTIMATES ============

  /**
   * Upsert a solar estimate (insert or update on conflict)
   */
  async upsertSolarEstimate(estimate: SolarEstimate): Promise<void> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db
        .insert(solarEstimatesSqlite)
        .values({
          timestamp: estimate.timestamp,
          watt_hours: estimate.watt_hours,
          fetched_at: estimate.fetched_at,
          created_at: estimate.created_at ?? this.now(),
        })
        .onConflictDoUpdate({
          target: solarEstimatesSqlite.timestamp,
          set: {
            watt_hours: estimate.watt_hours,
            fetched_at: estimate.fetched_at,
          },
        });
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      await db
        .insert(solarEstimatesMysql)
        .values({
          timestamp: estimate.timestamp,
          watt_hours: estimate.watt_hours,
          fetched_at: estimate.fetched_at,
          created_at: estimate.created_at ?? this.now(),
        })
        .onDuplicateKeyUpdate({
          set: {
            watt_hours: estimate.watt_hours,
            fetched_at: estimate.fetched_at,
          },
        });
    } else {
      const db = this.getPostgresDb();
      await db
        .insert(solarEstimatesPostgres)
        .values({
          timestamp: estimate.timestamp,
          watt_hours: estimate.watt_hours,
          fetched_at: estimate.fetched_at,
          created_at: estimate.created_at ?? this.now(),
        })
        .onConflictDoUpdate({
          target: solarEstimatesPostgres.timestamp,
          set: {
            watt_hours: estimate.watt_hours,
            fetched_at: estimate.fetched_at,
          },
        });
    }
  }

  /**
   * Get recent solar estimates
   */
  async getRecentSolarEstimates(limit: number = 100): Promise<SolarEstimate[]> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const results = await db
        .select()
        .from(solarEstimatesSqlite)
        .orderBy(desc(solarEstimatesSqlite.timestamp))
        .limit(limit);
      return this.normalizeBigInts(results);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const results = await db
        .select()
        .from(solarEstimatesMysql)
        .orderBy(desc(solarEstimatesMysql.timestamp))
        .limit(limit);
      return this.normalizeBigInts(results);
    } else {
      const db = this.getPostgresDb();
      const results = await db
        .select()
        .from(solarEstimatesPostgres)
        .orderBy(desc(solarEstimatesPostgres.timestamp))
        .limit(limit);
      return this.normalizeBigInts(results);
    }
  }

  /**
   * Get solar estimates within a time range
   */
  async getSolarEstimatesInRange(startTimestamp: number, endTimestamp: number): Promise<SolarEstimate[]> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const results = await db
        .select()
        .from(solarEstimatesSqlite)
        .where(
          and(
            gte(solarEstimatesSqlite.timestamp, startTimestamp),
            lte(solarEstimatesSqlite.timestamp, endTimestamp)
          )
        )
        .orderBy(asc(solarEstimatesSqlite.timestamp));
      return this.normalizeBigInts(results);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const results = await db
        .select()
        .from(solarEstimatesMysql)
        .where(
          and(
            gte(solarEstimatesMysql.timestamp, startTimestamp),
            lte(solarEstimatesMysql.timestamp, endTimestamp)
          )
        )
        .orderBy(asc(solarEstimatesMysql.timestamp));
      return this.normalizeBigInts(results);
    } else {
      const db = this.getPostgresDb();
      const results = await db
        .select()
        .from(solarEstimatesPostgres)
        .where(
          and(
            gte(solarEstimatesPostgres.timestamp, startTimestamp),
            lte(solarEstimatesPostgres.timestamp, endTimestamp)
          )
        )
        .orderBy(asc(solarEstimatesPostgres.timestamp));
      return this.normalizeBigInts(results);
    }
  }

  // ============ AUTO-TRACEROUTE NODES ============

  /**
   * Get all auto-traceroute nodes
   */
  async getAutoTracerouteNodes(): Promise<number[]> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const results = await db
        .select({ nodeNum: autoTracerouteNodesSqlite.nodeNum })
        .from(autoTracerouteNodesSqlite)
        .orderBy(asc(autoTracerouteNodesSqlite.createdAt));
      return results.map(r => Number(r.nodeNum));
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const results = await db
        .select({ nodeNum: autoTracerouteNodesMysql.nodeNum })
        .from(autoTracerouteNodesMysql)
        .orderBy(asc(autoTracerouteNodesMysql.createdAt));
      return results.map(r => Number(r.nodeNum));
    } else {
      const db = this.getPostgresDb();
      const results = await db
        .select({ nodeNum: autoTracerouteNodesPostgres.nodeNum })
        .from(autoTracerouteNodesPostgres)
        .orderBy(asc(autoTracerouteNodesPostgres.createdAt));
      return results.map(r => Number(r.nodeNum));
    }
  }

  /**
   * Set auto-traceroute nodes (replaces all existing entries)
   */
  async setAutoTracerouteNodes(nodeNums: number[]): Promise<void> {
    const now = this.now();

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      // Delete all existing entries
      await db.delete(autoTracerouteNodesSqlite);
      // Insert new entries
      for (const nodeNum of nodeNums) {
        await db
          .insert(autoTracerouteNodesSqlite)
          .values({ nodeNum, createdAt: now })
          .onConflictDoNothing();
      }
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      // Delete all existing entries
      await db.delete(autoTracerouteNodesMysql);
      // Insert new entries
      for (const nodeNum of nodeNums) {
        await db
          .insert(autoTracerouteNodesMysql)
          .values({ nodeNum, createdAt: now });
      }
    } else {
      const db = this.getPostgresDb();
      // Delete all existing entries
      await db.delete(autoTracerouteNodesPostgres);
      // Insert new entries
      for (const nodeNum of nodeNums) {
        await db
          .insert(autoTracerouteNodesPostgres)
          .values({ nodeNum, createdAt: now })
          .onConflictDoNothing();
      }
    }
  }

  /**
   * Add a single auto-traceroute node
   */
  async addAutoTracerouteNode(nodeNum: number): Promise<void> {
    const now = this.now();

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db
        .insert(autoTracerouteNodesSqlite)
        .values({ nodeNum, createdAt: now })
        .onConflictDoNothing();
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      // MySQL doesn't have onConflictDoNothing, use INSERT IGNORE via raw
      try {
        await db
          .insert(autoTracerouteNodesMysql)
          .values({ nodeNum, createdAt: now });
      } catch {
        // Ignore duplicate key errors
      }
    } else {
      const db = this.getPostgresDb();
      await db
        .insert(autoTracerouteNodesPostgres)
        .values({ nodeNum, createdAt: now })
        .onConflictDoNothing();
    }
  }

  /**
   * Remove a single auto-traceroute node
   */
  async removeAutoTracerouteNode(nodeNum: number): Promise<void> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db.delete(autoTracerouteNodesSqlite).where(eq(autoTracerouteNodesSqlite.nodeNum, nodeNum));
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      await db.delete(autoTracerouteNodesMysql).where(eq(autoTracerouteNodesMysql.nodeNum, nodeNum));
    } else {
      const db = this.getPostgresDb();
      await db.delete(autoTracerouteNodesPostgres).where(eq(autoTracerouteNodesPostgres.nodeNum, nodeNum));
    }
  }
}
