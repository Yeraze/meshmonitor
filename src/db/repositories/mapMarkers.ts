/**
 * Repository for `map_markers` (issue #5686, local map markers).
 *
 * Planning notes on the map, stored here and never transmitted. PER-SOURCE —
 * every read and write takes a `sourceId`, and an id from one source cannot
 * reach a row on another.
 */
import { and, asc, eq, count } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';
import type { MapMarker, MapMarkerColor, MapMarkerIcon, MapMarkerInput } from '../../types/mapMarker.js';

export class MapMarkersRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  private requireSource(sourceId: string, op: string): void {
    if (!sourceId) throw new Error(`MapMarkersRepository.${op} requires a sourceId`);
  }

  private toMarker(raw: Record<string, unknown>): MapMarker {
    const r = this.normalizeBigInts(raw) as Record<string, unknown>;
    const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
    return {
      id: Number(r.id),
      sourceId: String(r.sourceId),
      label: String(r.label),
      description: (r.description as string | null) ?? null,
      latitude: Number(r.latitude),
      longitude: Number(r.longitude),
      altitude: num(r.altitude),
      icon: r.icon as MapMarkerIcon,
      color: r.color as MapMarkerColor,
      createdByUserId: num(r.createdByUserId),
      createdAt: Number(r.createdAt),
      updatedAt: Number(r.updatedAt),
    };
  }

  async listBySource(sourceId: string): Promise<MapMarker[]> {
    this.requireSource(sourceId, 'listBySource');
    const t = this.tables.mapMarkers;
    const rows = await this.db.select().from(t).where(this.withSourceScope(t, sourceId)).orderBy(asc(t.id));
    return rows.map((r: Record<string, unknown>) => this.toMarker(r));
  }

  async getById(sourceId: string, id: number): Promise<MapMarker | null> {
    this.requireSource(sourceId, 'getById');
    const t = this.tables.mapMarkers;
    const rows = await this.db.select().from(t)
      .where(and(this.withSourceScope(t, sourceId), eq(t.id, id))).limit(1);
    return rows[0] ? this.toMarker(rows[0]) : null;
  }

  async countBySource(sourceId: string): Promise<number> {
    this.requireSource(sourceId, 'countBySource');
    const t = this.tables.mapMarkers;
    const rows = await this.db.select({ n: count() }).from(t).where(this.withSourceScope(t, sourceId));
    return Number(rows[0]?.n ?? 0);
  }

  async create(sourceId: string, input: Required<MapMarkerInput>, createdByUserId: number | null): Promise<MapMarker> {
    this.requireSource(sourceId, 'create');
    const t = this.tables.mapMarkers;
    const now = this.now();
    const values = {
      sourceId,
      label: input.label,
      description: input.description,
      latitude: input.latitude,
      longitude: input.longitude,
      altitude: input.altitude,
      icon: input.icon,
      color: input.color,
      createdByUserId,
      createdAt: now,
      updatedAt: now,
    };
    let id: number;
    if (this.isMySQL()) {
      const result = await this.getMysqlDb().insert(t).values(values);
      id = Number(result[0].insertId);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- #5686 the active-schema table union has no common returning() type; same as savedRegions
      const result = await (this.db as any).insert(t).values(values).returning({ id: t.id });
      id = Number(result[0].id);
    }
    return { id, ...values, createdByUserId };
  }

  /** Replace a marker's editable fields. Returns null when it is not on this source. */
  async update(sourceId: string, id: number, input: Required<MapMarkerInput>): Promise<MapMarker | null> {
    this.requireSource(sourceId, 'update');
    const existing = await this.getById(sourceId, id);
    if (!existing) return null;
    const t = this.tables.mapMarkers;
    const updatedAt = this.now();
    await this.db.update(t).set({ ...input, updatedAt })
      .where(and(this.withSourceScope(t, sourceId), eq(t.id, id)));
    return { ...existing, ...input, updatedAt };
  }

  /** Returns false when the marker is not on this source. */
  async delete(sourceId: string, id: number): Promise<boolean> {
    this.requireSource(sourceId, 'delete');
    const existing = await this.getById(sourceId, id);
    if (!existing) return false;
    const t = this.tables.mapMarkers;
    await this.db.delete(t).where(and(this.withSourceScope(t, sourceId), eq(t.id, id)));
    return true;
  }

  async deleteBySourceId(sourceId: string): Promise<void> {
    this.requireSource(sourceId, 'deleteBySourceId');
    const t = this.tables.mapMarkers;
    await this.db.delete(t).where(this.withSourceScope(t, sourceId));
  }
}
