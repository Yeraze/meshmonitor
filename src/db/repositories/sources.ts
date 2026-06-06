/**
 * Sources Repository
 *
 * Handles CRUD operations for data sources (Meshtastic TCP nodes, MQTT brokers, MeshCore devices).
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { asc, eq, sql } from 'drizzle-orm';
import { BaseRepository } from './base.js';
import { logger } from '../../utils/logger.js';

export interface Source {
  id: string;
  name: string;
  type: 'meshtastic_tcp' | 'mqtt_broker' | 'mqtt_bridge' | 'meshcore';
  config: Record<string, unknown>;
  enabled: boolean;
  /** User-controlled sort rank for the source list (issue #3338). Lower first. */
  displayOrder: number;
  createdAt: number;
  updatedAt: number;
  createdBy: number | null;
}

export interface CreateSourceInput {
  id: string;
  name: string;
  type: Source['type'];
  config: Record<string, unknown>;
  enabled?: boolean;
  createdBy?: number;
}

export class SourcesRepository extends BaseRepository {

  async getAllSources(): Promise<Source[]> {
    const rows = await this.executeQuery(
      this.db.select().from(this.tables.sources)
        .orderBy(asc(this.tables.sources.displayOrder), asc(this.tables.sources.createdAt))
    );
    return rows.map((r: any) => this.toSource(r));
  }

  async getEnabledSources(): Promise<Source[]> {
    const rows = await this.executeQuery(
      this.db.select().from(this.tables.sources).where(eq(this.tables.sources.enabled, true))
        .orderBy(asc(this.tables.sources.displayOrder), asc(this.tables.sources.createdAt))
    );
    return rows.map((r: any) => this.toSource(r));
  }

  async getSource(id: string): Promise<Source | null> {
    const rows = await this.executeQuery(
      this.db.select().from(this.tables.sources).where(eq(this.tables.sources.id, id))
    );
    return rows.length > 0 ? this.toSource(rows[0]) : null;
  }

  async createSource(input: CreateSourceInput): Promise<Source> {
    const now = Date.now();
    // Append new sources to the end of the list (issue #3338). Default-0 rows
    // would otherwise sort ahead of any source that has been explicitly
    // reordered (1..N), making new sources jump to the top.
    const existing = await this.getAllSources();
    const maxOrder = existing.reduce((max, s) => Math.max(max, s.displayOrder), 0);
    const row = {
      id: input.id,
      name: input.name,
      type: input.type,
      config: JSON.stringify(input.config),
      enabled: input.enabled ?? true,
      displayOrder: maxOrder + 1,
      createdAt: now,
      updatedAt: now,
      createdBy: input.createdBy ?? null,
    };
    await this.executeRun(
      this.db.insert(this.tables.sources).values(row)
    );
    logger.info(`Created source: ${input.name} (${input.type})`);
    return this.toSource(row);
  }

  async updateSource(id: string, updates: Partial<Pick<Source, 'name' | 'config' | 'enabled'>>): Promise<Source | null> {
    const setValues: any = { updatedAt: Date.now() };
    if (updates.name !== undefined) setValues.name = updates.name;
    if (updates.config !== undefined) setValues.config = JSON.stringify(updates.config);
    if (updates.enabled !== undefined) setValues.enabled = updates.enabled;

    await this.executeRun(
      this.db.update(this.tables.sources).set(setValues).where(eq(this.tables.sources.id, id))
    );
    return this.getSource(id);
  }

  async deleteSource(id: string): Promise<boolean> {
    const result = await this.executeRun(
      this.db.delete(this.tables.sources).where(eq(this.tables.sources.id, id))
    );
    const affected = this.getAffectedRows(result);
    if (affected > 0) {
      logger.info(`Deleted source: ${id}`);
    }
    return affected > 0;
  }

  async getSourceCount(): Promise<number> {
    const rows = await this.getAllSources();
    return rows.length;
  }

  /**
   * Reorder the source list (issue #3338).
   *
   * `orderedIds` MUST be a permutation of all current source IDs — every
   * existing source appears exactly once and no unknown IDs are present.
   * Rejecting partial payloads prevents a stale/buggy client from silently
   * collapsing omitted sources to displayOrder 0 (the analogue of the #3335
   * channel-reorder scoping bug). Writes displayOrder = index + 1 per id.
   *
   * @throws Error with a descriptive message when `orderedIds` is not a
   *   complete permutation of the existing source IDs.
   */
  async reorderSources(orderedIds: string[]): Promise<Source[]> {
    if (!Array.isArray(orderedIds)) {
      throw new Error('orderedIds must be an array of source IDs');
    }

    const existing = await this.getAllSources();
    const existingIds = new Set(existing.map((s) => s.id));

    if (orderedIds.length !== existingIds.size) {
      throw new Error(
        `orderedIds must contain every source exactly once (expected ${existingIds.size}, got ${orderedIds.length})`
      );
    }

    const seen = new Set<string>();
    for (const id of orderedIds) {
      if (!existingIds.has(id)) {
        throw new Error(`Unknown source id in reorder payload: ${id}`);
      }
      if (seen.has(id)) {
        throw new Error(`Duplicate source id in reorder payload: ${id}`);
      }
      seen.add(id);
    }

    const now = Date.now();
    for (let i = 0; i < orderedIds.length; i++) {
      await this.executeRun(
        this.db.update(this.tables.sources)
          .set({ displayOrder: i + 1, updatedAt: now })
          .where(eq(this.tables.sources.id, orderedIds[i]))
      );
    }

    logger.info(`Reordered ${orderedIds.length} sources`);
    return this.getAllSources();
  }

  /**
   * Assign all rows with NULL sourceId to the specified source.
   *
   * Called during server startup after the default source is confirmed, to tag
   * legacy data from single-source mode. Safe to call multiple times — subsequent
   * calls update 0 rows.
   */
  async assignNullSourceIds(sourceId: string): Promise<void> {
    // `channel_database` was in this list pre-migration-063 but its sourceId
    // column has since been dropped — the channel DB is global.
    const dataTables = [
      'nodes', 'messages', 'telemetry', 'traceroutes',
      'channels', 'neighbor_info', 'packet_log', 'ignored_nodes',
    ];

    for (const table of dataTables) {
      try {
        if (this.isPostgres()) {
          await this.executeRun(
            sql`UPDATE ${sql.raw(table)} SET "sourceId" = ${sourceId} WHERE "sourceId" IS NULL`
          );
        } else {
          await this.executeRun(
            sql`UPDATE ${sql.raw(table)} SET sourceId = ${sourceId} WHERE sourceId IS NULL`
          );
        }
      } catch (err: any) {
        // Column may not exist on first boot before migration 021 runs
        if (err?.message?.includes('no column named sourceId') ||
            err?.message?.includes('Unknown column')) {
          logger.debug(`assignNullSourceIds: sourceId column not yet in ${table}, skipping`);
        } else {
          logger.warn(`assignNullSourceIds: unexpected error on ${table}:`, err?.message);
        }
      }
    }
  }

  private toSource(row: any): Source {
    return {
      id: row.id,
      name: row.name,
      type: row.type as Source['type'],
      config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config,
      enabled: Boolean(row.enabled),
      displayOrder: row.displayOrder != null ? Number(row.displayOrder) : 0,
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
      createdBy: row.createdBy ? Number(row.createdBy) : null,
    };
  }
}
