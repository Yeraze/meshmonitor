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
}

/**
 * Repository for ignored nodes operations. All lookup/mutation methods are
 * scoped to a `sourceId`, matching the per-source PK introduced by
 * migration 048.
 */
export class IgnoredNodesRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
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
    };
    const insertData: any = { nodeNum, sourceId, ...setData };

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
    await this.db
      .delete(ignoredNodes)
      .where(and(eq(ignoredNodes.nodeNum, nodeNum), eq(ignoredNodes.sourceId, sourceId)));
    logger.debug(`Removed node ${nodeNum} from ignore list for source ${sourceId}`);
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

  /**
   * SQLite-only synchronous check — used by upsertNode legacy sync path
   * to decide whether to restore the `isIgnored` flag on a returning node.
   * Returns false if the table doesn't exist yet (initial setup).
   */
  isNodeIgnoredSqlite(nodeNum: number, sourceId: string): boolean {
    if (!this.sqliteDb) throw new Error('isNodeIgnoredSqlite is SQLite-only');
    const db = this.sqliteDb;
    const { ignoredNodes } = this.tables;
    try {
      const rows = db
        .select({ nodeNum: ignoredNodes.nodeNum })
        .from(ignoredNodes)
        .where(and(eq(ignoredNodes.nodeNum, nodeNum), eq(ignoredNodes.sourceId, sourceId)))
        .limit(1)
        .all();
      return rows.length > 0;
    } catch {
      // Table may not exist yet during initial setup
      return false;
    }
  }
}
