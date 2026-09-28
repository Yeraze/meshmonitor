/**
 * MeshCore Ignore / Block repository (#5408).
 *
 * Two per-source tables: `meshcore_ignored_nodes` (keyed by publicKey) and
 * `meshcore_message_filters` (text rules). Every method is source-scoped via
 * `withSourceScope`, which throws on a missing sourceId.
 *
 * Matching and the in-memory cache live in
 * `src/server/services/meshcoreMessageFilter.ts`; this file is persistence only.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

export type MeshCoreFilterMode = 'ignore' | 'block';
export type MeshCoreFilterMatchType = 'exact' | 'wildcard' | 'regex';
export type MeshCoreFilterFields = 'name' | 'body' | 'both';

export interface MeshCoreIgnoredNodeRow {
  sourceId: string;
  publicKey: string;
  name: string | null;
  mode: MeshCoreFilterMode;
  createdAt: number;
  createdBy: number | null;
  hitCount: number;
  lastHitAt: number | null;
}

export interface MeshCoreMessageFilterRow {
  id: string;
  sourceId: string;
  mode: MeshCoreFilterMode;
  matchType: MeshCoreFilterMatchType;
  pattern: string;
  caseSensitive: boolean;
  fields: MeshCoreFilterFields;
  enabled: boolean;
  createdAt: number;
  createdBy: number | null;
  hitCount: number;
  lastHitAt: number | null;
}

export interface MeshCoreMessageFilterInput {
  mode: MeshCoreFilterMode;
  matchType: MeshCoreFilterMatchType;
  pattern: string;
  caseSensitive: boolean;
  fields: MeshCoreFilterFields;
  enabled: boolean;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toMode(v: unknown): MeshCoreFilterMode {
  return v === 'block' ? 'block' : 'ignore';
}

function toMatchType(v: unknown): MeshCoreFilterMatchType {
  return v === 'wildcard' || v === 'regex' ? v : 'exact';
}

function toFields(v: unknown): MeshCoreFilterFields {
  return v === 'name' || v === 'body' ? v : 'both';
}

/** SQLite hands booleans back as 0/1 when read raw; normalize every backend. */
function toBool(v: unknown): boolean {
  return v === true || v === 1 || v === '1';
}

export class MeshCoreFiltersRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  private mapNode(r: Record<string, unknown>): MeshCoreIgnoredNodeRow {
    return {
      sourceId: String(r.sourceId),
      publicKey: String(r.publicKey),
      name: (r.name as string | null) ?? null,
      mode: toMode(r.mode),
      createdAt: Number(r.createdAt),
      createdBy: numOrNull(r.createdBy),
      hitCount: Number(r.hitCount ?? 0),
      lastHitAt: numOrNull(r.lastHitAt),
    };
  }

  private mapFilter(r: Record<string, unknown>): MeshCoreMessageFilterRow {
    return {
      id: String(r.id),
      sourceId: String(r.sourceId),
      mode: toMode(r.mode),
      matchType: toMatchType(r.matchType),
      pattern: String(r.pattern ?? ''),
      caseSensitive: toBool(r.caseSensitive),
      fields: toFields(r.fields),
      enabled: toBool(r.enabled),
      createdAt: Number(r.createdAt),
      createdBy: numOrNull(r.createdBy),
      hitCount: Number(r.hitCount ?? 0),
      lastHitAt: numOrNull(r.lastHitAt),
    };
  }

  // ============ IGNORED NODES ============

  async listIgnoredNodes(sourceId: string): Promise<MeshCoreIgnoredNodeRow[]> {
    const t = this.tables.meshcoreIgnoredNodes;
    const rows = await this.db
      .select()
      .from(t)
      .where(this.withSourceScope(t, sourceId))
      .orderBy(asc(t.createdAt));
    return (this.normalizeBigInts(rows) as Array<Record<string, unknown>>).map((r) => this.mapNode(r));
  }

  async getIgnoredNode(sourceId: string, publicKey: string): Promise<MeshCoreIgnoredNodeRow | null> {
    const t = this.tables.meshcoreIgnoredNodes;
    const rows = await this.db
      .select()
      .from(t)
      .where(and(this.withSourceScope(t, sourceId), eq(t.publicKey, publicKey)))
      .limit(1);
    const normalized = this.normalizeBigInts(rows) as Array<Record<string, unknown>>;
    return normalized[0] ? this.mapNode(normalized[0]) : null;
  }

  /**
   * Add a node, or change the mode / name of an existing entry. Keeps the
   * original `createdAt` and the hit counter when the row already exists.
   */
  async upsertIgnoredNode(entry: {
    sourceId: string;
    publicKey: string;
    name: string | null;
    mode: MeshCoreFilterMode;
    createdBy: number | null;
  }): Promise<MeshCoreIgnoredNodeRow> {
    if (!entry.sourceId) throw new Error('upsertIgnoredNode: sourceId is required');
    const t = this.tables.meshcoreIgnoredNodes;
    const now = this.now();
    await this.upsert(
      t,
      {
        sourceId: entry.sourceId,
        publicKey: entry.publicKey,
        name: entry.name,
        mode: entry.mode,
        createdAt: now,
        createdBy: entry.createdBy,
        hitCount: 0,
        lastHitAt: null,
      },
      [t.sourceId, t.publicKey],
      { name: entry.name, mode: entry.mode },
    );
    const row = await this.getIgnoredNode(entry.sourceId, entry.publicKey);
    if (!row) throw new Error('upsertIgnoredNode: row missing after write');
    return row;
  }

  async removeIgnoredNode(sourceId: string, publicKey: string): Promise<number> {
    const t = this.tables.meshcoreIgnoredNodes;
    const result = await this.db
      .delete(t)
      .where(and(this.withSourceScope(t, sourceId), eq(t.publicKey, publicKey)));
    return this.getAffectedRows(result);
  }

  async updateIgnoredNodeName(sourceId: string, publicKey: string, name: string): Promise<void> {
    const t = this.tables.meshcoreIgnoredNodes;
    await this.db
      .update(t)
      .set({ name })
      .where(and(this.withSourceScope(t, sourceId), eq(t.publicKey, publicKey)));
  }

  async addIgnoredNodeHits(sourceId: string, publicKey: string, count: number, lastHitAt: number): Promise<void> {
    if (count <= 0) return;
    const t = this.tables.meshcoreIgnoredNodes;
    await this.db
      .update(t)
      .set({ hitCount: sql`${t.hitCount} + ${count}`, lastHitAt })
      .where(and(this.withSourceScope(t, sourceId), eq(t.publicKey, publicKey)));
  }

  // ============ MESSAGE FILTERS ============

  async listMessageFilters(sourceId: string): Promise<MeshCoreMessageFilterRow[]> {
    const t = this.tables.meshcoreMessageFilters;
    const rows = await this.db
      .select()
      .from(t)
      .where(this.withSourceScope(t, sourceId))
      .orderBy(asc(t.createdAt));
    return (this.normalizeBigInts(rows) as Array<Record<string, unknown>>).map((r) => this.mapFilter(r));
  }

  async getMessageFilter(sourceId: string, id: string): Promise<MeshCoreMessageFilterRow | null> {
    const t = this.tables.meshcoreMessageFilters;
    const rows = await this.db
      .select()
      .from(t)
      .where(and(this.withSourceScope(t, sourceId), eq(t.id, id)))
      .limit(1);
    const normalized = this.normalizeBigInts(rows) as Array<Record<string, unknown>>;
    return normalized[0] ? this.mapFilter(normalized[0]) : null;
  }

  async createMessageFilter(
    sourceId: string,
    input: MeshCoreMessageFilterInput,
    createdBy: number | null,
  ): Promise<MeshCoreMessageFilterRow> {
    if (!sourceId) throw new Error('createMessageFilter: sourceId is required');
    const t = this.tables.meshcoreMessageFilters;
    const id = randomUUID();
    await this.db.insert(t).values({
      id,
      sourceId,
      ...input,
      createdAt: this.now(),
      createdBy,
      hitCount: 0,
      lastHitAt: null,
    });
    const row = await this.getMessageFilter(sourceId, id);
    if (!row) throw new Error('createMessageFilter: row missing after write');
    return row;
  }

  /** Returns the updated row, or null when no rule with that id exists on this source. */
  async updateMessageFilter(
    sourceId: string,
    id: string,
    patch: Partial<MeshCoreMessageFilterInput>,
  ): Promise<MeshCoreMessageFilterRow | null> {
    const t = this.tables.meshcoreMessageFilters;
    const existing = await this.getMessageFilter(sourceId, id);
    if (!existing) return null;
    const set: Record<string, unknown> = {};
    for (const key of ['mode', 'matchType', 'pattern', 'caseSensitive', 'fields', 'enabled'] as const) {
      if (patch[key] !== undefined) set[key] = patch[key];
    }
    if (Object.keys(set).length > 0) {
      await this.db
        .update(t)
        .set(set)
        .where(and(this.withSourceScope(t, sourceId), eq(t.id, id)));
    }
    return this.getMessageFilter(sourceId, id);
  }

  async deleteMessageFilter(sourceId: string, id: string): Promise<number> {
    const t = this.tables.meshcoreMessageFilters;
    const result = await this.db
      .delete(t)
      .where(and(this.withSourceScope(t, sourceId), eq(t.id, id)));
    return this.getAffectedRows(result);
  }

  async addMessageFilterHits(sourceId: string, id: string, count: number, lastHitAt: number): Promise<void> {
    if (count <= 0) return;
    const t = this.tables.meshcoreMessageFilters;
    await this.db
      .update(t)
      .set({ hitCount: sql`${t.hitCount} + ${count}`, lastHitAt })
      .where(and(this.withSourceScope(t, sourceId), eq(t.id, id)));
  }
}
