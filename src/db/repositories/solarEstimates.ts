/**
 * Solar Estimates Repository
 *
 * Handles solar estimate database operations.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { and, gte, lte, asc, desc } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

export interface SolarEstimate {
  id?: number;
  timestamp: number;
  watt_hours: number;
  fetched_at: number;
  created_at?: number | null;
}

export class SolarEstimatesRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  /**
   * Upsert a solar estimate (insert or update on conflict).
   * Keeps branching: MySQL uses onDuplicateKeyUpdate vs onConflictDoUpdate.
   */
  async upsertSolarEstimate(estimate: SolarEstimate): Promise<void> {
    const { solarEstimates } = this.tables;
    const values = {
      timestamp: estimate.timestamp,
      watt_hours: estimate.watt_hours,
      fetched_at: estimate.fetched_at,
      created_at: estimate.created_at ?? this.now(),
    };
    const setData = {
      watt_hours: estimate.watt_hours,
      fetched_at: estimate.fetched_at,
    };

    await this.upsert(solarEstimates, values, solarEstimates.timestamp, setData);
  }

  /**
   * Get recent solar estimates
   */
  async getRecentSolarEstimates(limit: number = 100): Promise<SolarEstimate[]> {
    const { solarEstimates } = this.tables;
    const results = await this.db
      .select()
      .from(solarEstimates)
      .orderBy(desc(solarEstimates.timestamp))
      .limit(limit);
    return this.normalizeBigInts(results);
  }

  /**
   * Get solar estimates within a time range
   */
  async getSolarEstimatesInRange(startTimestamp: number, endTimestamp: number): Promise<SolarEstimate[]> {
    const { solarEstimates } = this.tables;
    const results = await this.db
      .select()
      .from(solarEstimates)
      .where(
        and(
          gte(solarEstimates.timestamp, startTimestamp),
          lte(solarEstimates.timestamp, endTimestamp)
        )
      )
      .orderBy(asc(solarEstimates.timestamp));
    return this.normalizeBigInts(results);
  }
}
