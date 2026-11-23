/**
 * Solar irradiance repository (#6523).
 *
 * Global Open-Meteo cell cache (see `src/db/schema/solarIrradiance.ts`). A
 * refresh replaces one cell's rows in its fetched window (delete + insert), so
 * no backend-specific composite upsert is needed.
 */
import { and, eq, gte, lte, lt, asc, inArray, max } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

export interface SolarIrradianceRow {
  timestamp: number;
  shortwaveRadiation: number | null;
  cloudCover: number | null;
}

/** Rows per INSERT; keeps every backend well under its bound-parameter limit. */
const INSERT_CHUNK = 200;

export class SolarIrradianceRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  /** Replace `cellKey`'s rows between the first and last timestamp in `rows`. */
  async replaceCellRows(cellKey: string, rows: SolarIrradianceRow[], fetchedAt: number): Promise<void> {
    if (rows.length === 0) return;
    const { solarIrradiance } = this.tables;
    const timestamps = rows.map(r => r.timestamp);
    await this.db
      .delete(solarIrradiance)
      .where(and(
        eq(solarIrradiance.cellKey, cellKey),
        gte(solarIrradiance.timestamp, Math.min(...timestamps)),
        lte(solarIrradiance.timestamp, Math.max(...timestamps)),
      ));
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      await this.db.insert(solarIrradiance).values(
        rows.slice(i, i + INSERT_CHUNK).map(r => ({ cellKey, ...r, fetchedAt })),
      );
    }
  }

  /** Latest `fetchedAt` per cell, for the given keys. Cells never fetched are absent. */
  async getLastFetchedAt(cellKeys: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (cellKeys.length === 0) return out;
    const { solarIrradiance } = this.tables;
    for (let i = 0; i < cellKeys.length; i += INSERT_CHUNK) {
      const rows = await this.db
        .select({ cellKey: solarIrradiance.cellKey, fetchedAt: max(solarIrradiance.fetchedAt) })
        .from(solarIrradiance)
        .where(inArray(solarIrradiance.cellKey, cellKeys.slice(i, i + INSERT_CHUNK)))
        .groupBy(solarIrradiance.cellKey);
      for (const r of rows as Array<{ cellKey: string; fetchedAt: unknown }>) {
        if (r.fetchedAt != null) out.set(r.cellKey, Number(r.fetchedAt));
      }
    }
    return out;
  }

  async getCellRange(cellKey: string, start: number, end: number): Promise<SolarIrradianceRow[]> {
    const { solarIrradiance } = this.tables;
    const rows = await this.db
      .select({
        timestamp: solarIrradiance.timestamp,
        shortwaveRadiation: solarIrradiance.shortwaveRadiation,
        cloudCover: solarIrradiance.cloudCover,
      })
      .from(solarIrradiance)
      .where(and(
        eq(solarIrradiance.cellKey, cellKey),
        gte(solarIrradiance.timestamp, start),
        lte(solarIrradiance.timestamp, end),
      ))
      .orderBy(asc(solarIrradiance.timestamp));
    return (rows as SolarIrradianceRow[]).map(r => ({
      timestamp: Number(r.timestamp),
      shortwaveRadiation: r.shortwaveRadiation,
      cloudCover: r.cloudCover,
    }));
  }

  /** Retention sweep: delete rows older than `cutoff` (Unix seconds). */
  async deleteOlderThan(cutoff: number): Promise<void> {
    const { solarIrradiance } = this.tables;
    await this.db.delete(solarIrradiance).where(lt(solarIrradiance.timestamp, cutoff));
  }
}
