/**
 * Ignored Nodes Repository
 *
 * Handles persistence of node ignored status per source. Supports SQLite,
 * PostgreSQL, and MySQL through Drizzle ORM.
 *
 * **Scoping model (migration 048)**
 *
 * The `ignored_nodes` table is PER-SOURCE. Keyed on composite `(nodeNum,
 * sourceId)`, with `sourceId` as a foreign key to `sources(id)` ON DELETE
 * CASCADE. Each source has its own independent blocklist. Ignoring a node on
 * source A does NOT affect the same nodeNum's state on source B. This matches
 * the per-source node identity model introduced by migration 029.
 *
 * The table persists ignored status independently of `nodes.isIgnored` so
 * that when a node is pruned by `cleanupInactiveNodes` on a given source and
 * later reappears on THAT SAME source, its ignored flag is restored. Cross-
 * source propagation is intentionally absent — callers that want to ignore a
 * node on every source must iterate sources themselves.
 */
import { and, eq } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';
import { logger } from '../../utils/logger.js';

export interface IgnoredNodeRecord {
  nodeNum: number;
  sourceId: string;
  nodeId: string;
  longName: string | null;
  shortName: string | null;
  ignoredAt: number;
  ignoredBy: string | null;
  reason: 'manual' | 'geo';
}

/**
 * Repository for ignored nodes operations. All lookup/mutation methods are
 * scoped to a `sourceId`, matching the per-source PK introduced by
 * migration 048.
 */
export class IgnoredNodesRepository extends BaseRepository {
  /**
   * In-memory mirror of the per-source blocklist, keyed by `${sourceId}:${nodeNum}`.
   *
   * `upsertNode` runs on the hot packet path (potentially every packet from
   * every node) and must decide synchronously whether to re-apply the ignore
   * flag — issuing a DB query per upsert is not viable, especially for the
   * PostgreSQL/MySQL round-trip cost. This Set is primed once at startup
   * (`primeCacheAsync` / `primeCacheSqlite`) and kept in lock-step by every
   * add/remove below, so `isIgnoredCached` is an O(1) lookup. All mutations to
   * `ignored_nodes` route through this repository, so the cache cannot drift.
   */
  private ignoredCache = new Set<string>();

  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  /** Build the composite cache key. nodeNum is always the trailing numeric
   *  segment, so a ':' separator can never produce an ambiguous key. */
  private cacheKey(nodeNum: number, sourceId: string): string {
    return `${sourceId}:${nodeNum}`;
  }

  /**
   * Load the entire blocklist into the in-memory cache. Used by PostgreSQL/MySQL
   * (and any async caller) at startup. Safe to call repeatedly — it rebuilds the
   * set from scratch. Returns false if the table can't be read yet.
   */
  async primeCacheAsync(): Promise<boolean> {
    try {
      const rows = await this.getIgnoredNodesAsync();
      this.ignoredCache.clear();
      for (const row of rows) {
        this.ignoredCache.add(this.cacheKey(row.nodeNum, row.sourceId));
      }
      logger.debug(`Primed ignored-node cache with ${this.ignoredCache.size} entr${this.ignoredCache.size === 1 ? 'y' : 'ies'}`);
      return true;
    } catch (err) {
      logger.debug('Could not prime ignored-node cache (table may not exist yet):', err);
      return false;
    }
  }

  /**
   * Synchronous cache prime for the SQLite path, where the constructor builds
   * repositories and runs migrations synchronously and the hot upsert path is
   * fully synchronous. Returns false if the table doesn't exist yet.
   */
  primeCacheSqlite(): boolean {
    if (!this.sqliteDb) throw new Error('primeCacheSqlite is SQLite-only');
    const db = this.sqliteDb;
    const { ignoredNodes } = this.tables;
    try {
      const rows = db
        .select({ nodeNum: ignoredNodes.nodeNum, sourceId: ignoredNodes.sourceId })
        .from(ignoredNodes)
        .all() as Array<{ nodeNum: number; sourceId: string }>;
      this.ignoredCache.clear();
      for (const row of rows) {
        this.ignoredCache.add(this.cacheKey(Number(row.nodeNum), row.sourceId));
      }
      logger.debug(`Primed ignored-node cache (SQLite) with ${this.ignoredCache.size} entr${this.ignoredCache.size === 1 ? 'y' : 'ies'}`);
      return true;
    } catch (err) {
      logger.debug('Could not prime ignored-node cache, table may not exist yet:', err);
      return false;
    }
  }

  /**
   * Synchronous O(1) check against the in-memory blocklist mirror. Used by the
   * `upsertNode` hot path to decide whether to re-apply the ignore flag to a
   * node the device just reported as un-ignored (issue #2601). Reflects the
   * cache state, which is primed at startup and updated on every add/remove.
   */
  isIgnoredCached(nodeNum: number, sourceId: string): boolean {
    return this.ignoredCache.has(this.cacheKey(nodeNum, sourceId));
  }

  /**
   * Add a node to the per-source ignore list (upsert on (nodeNum, sourceId)).
   */
  async addIgnoredNodeAsync(
    nodeNum: number,
    sourceId: string,
    nodeId: string,
    longName?: string | null,
    shortName?: string | null,
    ignoredBy?: string | null,
  ): Promise<void> {
    const now = Date.now();
    const { ignoredNodes } = this.tables;
    const setData: any = {
      nodeId,
      longName: longName ?? null,
      shortName: shortName ?? null,
      ignoredAt: now,
      ignoredBy: ignoredBy ?? null,
      // A manual ignore always wins: it upgrades a pre-existing geo-filter
      // row (reason: 'geo') to 'manual', matching operator intent — an
      // explicit block should never silently revert to auto-managed.
      reason: 'manual',
    };
    const insertData: any = { nodeNum, sourceId, ...setData };

    // Update the in-memory mirror before the DB write so fire-and-forget callers
    // (e.g. DatabaseService.setNodeIgnored) make the change visible to the
    // synchronous upsert path immediately, with no microtask-window race.
    this.ignoredCache.add(this.cacheKey(nodeNum, sourceId));

    await this.upsert(
      ignoredNodes,
      insertData,
      [ignoredNodes.nodeNum, ignoredNodes.sourceId],
      setData,
    );

    logger.debug(`Added node ${nodeNum} (${nodeId}) to ignore list for source ${sourceId}`);
  }

  /**
   * Remove a node from the per-source ignore list.
   */
  async removeIgnoredNodeAsync(nodeNum: number, sourceId: string): Promise<void> {
    const { ignoredNodes } = this.tables;
    // Mirror update first (see addIgnoredNodeAsync) so the un-ignore is visible
    // to the synchronous upsert path without waiting on the DB round-trip.
    this.ignoredCache.delete(this.cacheKey(nodeNum, sourceId));
    await this.db
      .delete(ignoredNodes)
      .where(and(eq(ignoredNodes.nodeNum, nodeNum), eq(ignoredNodes.sourceId, sourceId)));
    logger.debug(`Removed node ${nodeNum} from ignore list for source ${sourceId}`);
  }

  /**
   * Add a node to the per-source ignore list on behalf of the geo-fence
   * filter (MQTT Geo-Ignore epic, Phase 1). Insert-if-absent only — unlike
   * `addIgnoredNodeAsync`, this MUST NOT clobber a pre-existing row. A node
   * a human already blocklisted manually (`reason: 'manual'`) stays manual;
   * re-running the geo filter against an already-geo-ignored node is a
   * harmless no-op (idempotent).
   */
  async addGeoIgnoreAsync(
    nodeNum: number,
    sourceId: string,
    nodeId: string,
    longName?: string,
    shortName?: string,
  ): Promise<void> {
    const { ignoredNodes } = this.tables;
    const insertData = {
      nodeNum,
      sourceId,
      nodeId,
      longName: longName ?? null,
      shortName: shortName ?? null,
      ignoredAt: Date.now(),
      ignoredBy: 'geo-filter',
      reason: 'geo',
    };

    // Mirror update first (see addIgnoredNodeAsync) so the ignore is visible
    // to the synchronous upsert path without waiting on the DB round-trip.
    // Safe even when the insert below is a no-op (row already existed): the
    // node was already ignored under either reason, so the cache was already
    // set (or is being correctly set for the very first time here).
    this.ignoredCache.add(this.cacheKey(nodeNum, sourceId));

    await this.insertIgnore(ignoredNodes, insertData);

    logger.debug(`Geo-ignored node ${nodeNum} (${nodeId}) for source ${sourceId}`);
  }

  /**
   * Lift a geo-fence ignore (MQTT Geo-Ignore epic, Phase 1). Only removes
   * rows with `reason: 'geo'` — a manually-ignored node is left untouched
   * (the geo filter must never silently un-block an operator's explicit
   * decision). Returns whether a geo-ignore row was actually removed.
   */
  async liftGeoIgnoreAsync(nodeNum: number, sourceId: string): Promise<boolean> {
    const { ignoredNodes } = this.tables;
    const rowScope = and(eq(ignoredNodes.nodeNum, nodeNum), eq(ignoredNodes.sourceId, sourceId));

    const rows = await this.db
      .select({ reason: ignoredNodes.reason })
      .from(ignoredNodes)
      .where(rowScope);

    const reason = rows[0]?.reason;
    if (reason !== 'geo') {
      // Absent, or a manual ignore the geo filter must not touch.
      return false;
    }

    await this.db
      .delete(ignoredNodes)
      .where(and(
        eq(ignoredNodes.nodeNum, nodeNum),
        eq(ignoredNodes.sourceId, sourceId),
        eq(ignoredNodes.reason, 'geo'),
      ));

    // Cache eviction happens AFTER the delete is confirmed — deliberately
    // opposite to the mirror-first convention used by the add paths. Adds are
    // safe to mirror early (worst case: the node is briefly ignored a moment
    // sooner). A removal is not: between the SELECT above and the DELETE, a
    // concurrent addIgnoredNodeAsync may have upgraded the row to 'manual',
    // making our reason='geo'-guarded DELETE a no-op. Evicting the cache
    // first would then leave a live 'manual' DB row invisible to
    // isIgnoredCached until the next prime (phantom un-ignore). So we
    // re-check the row after the delete; MySQL lacks .returning(), so a
    // dialect-agnostic re-SELECT is used instead of delete-returning (see
    // the same constraint noted in nodes.ts).
    const remaining = await this.db
      .select({ nodeNum: ignoredNodes.nodeNum })
      .from(ignoredNodes)
      .where(rowScope);

    if (remaining.length > 0) {
      // A concurrent manual upgrade won the race — the node is still (and
      // must remain) ignored. Leave the cache entry in place.
      logger.debug(`Geo-ignore lift for node ${nodeNum} on source ${sourceId} lost race to a manual upgrade; leaving ignore in place`);
      return false;
    }

    this.ignoredCache.delete(this.cacheKey(nodeNum, sourceId));
    logger.debug(`Lifted geo-ignore for node ${nodeNum} on source ${sourceId}`);
    return true;
  }

  /**
   * Get persistently ignored nodes. If `sourceId` is provided, scopes to that
   * source; otherwise returns all entries across every source (for admin
   * dashboards / aggregated views).
   */
  async getIgnoredNodesAsync(sourceId?: string): Promise<IgnoredNodeRecord[]> {
    const { ignoredNodes } = this.tables;
    const rows = sourceId
      ? await this.db.select().from(ignoredNodes).where(eq(ignoredNodes.sourceId, sourceId))
      : await this.db.select().from(ignoredNodes);
    return this.normalizeBigInts(rows) as IgnoredNodeRecord[];
  }

  /**
   * Check if a node is in the ignore list for a given source.
   */
  async isNodeIgnoredAsync(nodeNum: number, sourceId: string): Promise<boolean> {
    const { ignoredNodes } = this.tables;
    const rows = await this.db
      .select({ nodeNum: ignoredNodes.nodeNum })
      .from(ignoredNodes)
      .where(and(eq(ignoredNodes.nodeNum, nodeNum), eq(ignoredNodes.sourceId, sourceId)));
    return rows.length > 0;
  }

}
