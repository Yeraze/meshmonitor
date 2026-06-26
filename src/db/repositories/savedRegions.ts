/**
 * MeshCore Saved Regions Repository (#3770)
 *
 * CRUD for the GLOBAL `meshcore_saved_regions` catalog — a user-maintained,
 * de-duplicated list of MeshCore region names. A "scope" is a transport code
 * derived purely from a region name (sha256("#region")[:16]), so the catalog is
 * NOT source-scoped (mirrors `channel_database` / `automations`).
 *
 * Names are normalized on the way in (strip leading '#', lowercase, keep only
 * letters/digits/hyphen) and stored UNIQUE, so the same region can't be saved
 * twice and lookups are stable.
 */
import { eq, asc } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';
import { logger } from '../../utils/logger.js';

export interface SavedRegion {
  id: number;
  name: string;
  note: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Normalize a region name for storage / comparison: strip a leading '#', lower-
 * case, and keep only letters, digits and hyphens. Returns '' if nothing valid
 * remains (callers should reject empty). Mirrors the scope normalization used in
 * the MeshCore manager so saved names match what gets hashed into a scope.
 */
export function normalizeRegionName(raw: string): string {
  return (raw ?? '')
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
}

export class SavedRegionsRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  private map(row: any): SavedRegion {
    return this.normalizeBigInts({
      id: Number(row.id),
      name: row.name,
      note: row.note ?? null,
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
    });
  }

  /** List all saved regions, ordered by name. */
  async getAllAsync(): Promise<SavedRegion[]> {
    const { meshcoreSavedRegions } = this.tables;
    const rows = await this.db
      .select()
      .from(meshcoreSavedRegions)
      .orderBy(asc(meshcoreSavedRegions.name));
    return rows.map((r: any) => this.map(r));
  }

  /** Look up a saved region by (normalized) name. Returns null if not found. */
  async getByNameAsync(name: string): Promise<SavedRegion | null> {
    const normalized = normalizeRegionName(name);
    if (!normalized) return null;
    const { meshcoreSavedRegions } = this.tables;
    const rows = await this.db
      .select()
      .from(meshcoreSavedRegions)
      .where(eq(meshcoreSavedRegions.name, normalized))
      .limit(1);
    return rows.length ? this.map(rows[0]) : null;
  }

  /**
   * Add a region to the catalog (idempotent). Normalizes the name; if the name
   * already exists, returns the existing row (optionally updating the note).
   * Throws on an empty/invalid name so callers can surface a 400.
   */
  async addAsync(name: string, note?: string | null): Promise<SavedRegion> {
    const normalized = normalizeRegionName(name);
    if (!normalized) {
      throw new Error('Invalid region name (letters, digits and hyphens only)');
    }
    const trimmedNote = (note ?? '').trim() || null;

    const existing = await this.getByNameAsync(normalized);
    if (existing) {
      if (trimmedNote !== null && trimmedNote !== existing.note) {
        await this.updateNoteAsync(existing.id, trimmedNote);
        return { ...existing, note: trimmedNote };
      }
      return existing;
    }

    const now = this.now();
    const { meshcoreSavedRegions } = this.tables;
    const values: any = {
      name: normalized,
      note: trimmedNote,
      createdAt: now,
      updatedAt: now,
    };

    if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db.insert(meshcoreSavedRegions).values(values);
      const id = Number(result[0].insertId);
      logger.debug(`Added saved region "${normalized}" (ID: ${id})`);
      return { id, name: normalized, note: trimmedNote, createdAt: now, updatedAt: now };
    }

    const result = await (this.db as any)
      .insert(meshcoreSavedRegions)
      .values(values)
      .returning({ id: meshcoreSavedRegions.id });
    const id = Number(result[0].id);
    logger.debug(`Added saved region "${normalized}" (ID: ${id})`);
    return { id, name: normalized, note: trimmedNote, createdAt: now, updatedAt: now };
  }

  /** Update a saved region's note. */
  async updateNoteAsync(id: number, note: string | null): Promise<void> {
    const { meshcoreSavedRegions } = this.tables;
    await this.db
      .update(meshcoreSavedRegions)
      .set({ note: note || null, updatedAt: this.now() })
      .where(eq(meshcoreSavedRegions.id, id));
  }

  /** Delete a saved region by id. */
  async deleteAsync(id: number): Promise<void> {
    const { meshcoreSavedRegions } = this.tables;
    await this.db.delete(meshcoreSavedRegions).where(eq(meshcoreSavedRegions.id, id));
    logger.debug(`Deleted saved region ID: ${id}`);
  }
}
