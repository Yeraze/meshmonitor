/**
 * Ignored Nodes Repository
 *
 * Handles persistence of node ignored status independently of the nodes table.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 *
 * **IMPORTANT — scoping model**
 *
 * The `ignored_nodes` table is intentionally GLOBAL, not per-source. Ignoring a
 * node hides it across every source the user has access to. The rationale:
 * node identity (nodeNum) is globally unique on the mesh, so a spammer or
 * misbehaving device should be silenced regardless of which transport surfaced
 * them.
 *
 * The `sourceId` column on this table is informational only — it records which
 * source first flagged the node. The upsert conflict target is `nodeNum` alone,
 * so re-ignoring the same node from a different source updates the existing row
 * in place and does NOT create a second record. Callers must treat lookup,
 * removal, and iteration as global operations.
 *
 * When a node is un-ignored via the API, `server.ts` sweeps every source's
 * `nodes` row for that nodeNum to clear per-source ignore flags — see the
 * `DELETE /api/ignored-nodes/:nodeId` handler for the full pattern.
 */
import { eq } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';
import { logger } from '../../utils/logger.js';

export interface IgnoredNodeRecord {
  nodeNum: number;
  nodeId: string;
  longName: string | null;
  shortName: string | null;
  ignoredAt: number;
  ignoredBy: string | null;
}

/**
 * Repository for ignored nodes operations
 */
export class IgnoredNodesRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  /**
   * Add a node to the persistent ignore list (upsert)
   */
  async addIgnoredNodeAsync(
    nodeNum: number,
    nodeId: string,
    longName?: string | null,
    shortName?: string | null,
    ignoredBy?: string | null,
    sourceId?: string,
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
    const insertData: any = { nodeNum, ...setData };
    if (sourceId) {
      insertData.sourceId = sourceId;
    }

    await this.upsert(
      ignoredNodes,
      insertData,
      ignoredNodes.nodeNum,
      setData,
    );

    logger.debug(`Added node ${nodeNum} (${nodeId}) to persistent ignore list`);
  }

  /**
   * Remove a node from the persistent ignore list
   */
  async removeIgnoredNodeAsync(nodeNum: number): Promise<void> {
    const { ignoredNodes } = this.tables;
    await this.db.delete(ignoredNodes).where(eq(ignoredNodes.nodeNum, nodeNum));
    logger.debug(`Removed node ${nodeNum} from persistent ignore list`);
  }

  /**
   * Get all persistently ignored nodes
   */
  async getIgnoredNodesAsync(): Promise<IgnoredNodeRecord[]> {
    const { ignoredNodes } = this.tables;
    const rows = await this.db.select().from(ignoredNodes);
    return this.normalizeBigInts(rows) as IgnoredNodeRecord[];
  }

  /**
   * Check if a node is in the persistent ignore list
   */
  async isNodeIgnoredAsync(nodeNum: number): Promise<boolean> {
    const { ignoredNodes } = this.tables;
    const rows = await this.db
      .select({ nodeNum: ignoredNodes.nodeNum })
      .from(ignoredNodes)
      .where(eq(ignoredNodes.nodeNum, nodeNum));
    return rows.length > 0;
  }

  /**
   * SQLite-only synchronous check — used by upsertNode legacy sync path
   * to decide whether to restore the `isIgnored` flag on a returning node.
   * Returns false if the table doesn't exist yet (initial setup).
   */
  isNodeIgnoredSqlite(nodeNum: number): boolean {
    if (!this.sqliteDb) throw new Error('isNodeIgnoredSqlite is SQLite-only');
    const db = this.sqliteDb;
    const { ignoredNodes } = this.tables;
    try {
      const rows = db
        .select({ nodeNum: ignoredNodes.nodeNum })
        .from(ignoredNodes)
        .where(eq(ignoredNodes.nodeNum, nodeNum))
        .limit(1)
        .all();
      return rows.length > 0;
    } catch {
      // Table may not exist yet during initial setup
      return false;
    }
  }
}
