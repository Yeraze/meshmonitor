/**
 * Repository for `node_name_history` (issue #5862): one row per rename a
 * source saw. PER-SOURCE — every write takes a `sourceId`, and reads take the
 * list of sources the caller may see the node on.
 *
 * Rows are written from the two node upserts (`NodesRepository.upsertNode`,
 * `MeshCoreRepository.upsertNode`), which already hold the stored row, so a
 * rename costs one insert and an occasional trim. Each (source, node) keeps
 * its newest `NODE_NAME_HISTORY_CAP` rows.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';
import { isPlaceholderLongName, isPlaceholderShortName } from '../../utils/nodeFieldBlanks.js';

export type NodeNameProtocol = 'meshtastic' | 'meshcore';

/** Renames kept per node per source; older rows are trimmed on write. */
export const NODE_NAME_HISTORY_CAP = 50;

export interface NodeNameHistoryRow {
  id?: number;
  sourceId: string;
  protocol: NodeNameProtocol;
  /** Decimal nodeNum (Meshtastic) or public key hex (MeshCore). */
  nodeKey: string;
  oldLongName: string | null;
  newLongName: string | null;
  oldShortName: string | null;
  newShortName: string | null;
  /** ms since epoch */
  changedAt: number;
}

export interface NodeNames {
  longName?: string | null;
  shortName?: string | null;
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

/**
 * Long names that are not a name the node chose: blank, MeshMonitor's own
 * stubs (`Node !aabbccdd`, `Unknown`), and the firmware default
 * `Meshtastic abcd`.
 */
export function isPlaceholderLongNameForHistory(value: unknown): boolean {
  if (isBlank(value)) return true;
  if (isPlaceholderLongName(value)) return true;
  const name = String(value);
  return name === 'Unknown' || /^Meshtastic [0-9a-f]{4}$/i.test(name);
}

/** Short names that are not chosen: blank, `UNK`, or the node id's last 4 hex. */
export function isPlaceholderShortNameForHistory(value: unknown, nodeId?: string | null): boolean {
  if (isBlank(value)) return true;
  return value === 'UNK' || isPlaceholderShortName(value, nodeId);
}

/**
 * Should a Meshtastic name change be logged? Only a change from one real name
 * to another counts (#5862): a node's first real name replacing a stub is not
 * a rename. `before` is the stored row, `after` the values about to be stored.
 */
export function isMeshtasticRename(before: NodeNames, after: NodeNames, nodeId?: string | null): boolean {
  const longChanged = (before.longName ?? null) !== (after.longName ?? null)
    && !isPlaceholderLongNameForHistory(before.longName)
    && !isPlaceholderLongNameForHistory(after.longName);
  const shortChanged = (before.shortName ?? null) !== (after.shortName ?? null)
    && !isPlaceholderShortNameForHistory(before.shortName, nodeId)
    && !isPlaceholderShortNameForHistory(after.shortName, nodeId);
  return longChanged || shortChanged;
}

/** MeshCore nodes have one name; a rename is one non-blank name replacing another. */
export function isMeshCoreRename(before: string | null | undefined, after: string | null | undefined): boolean {
  return !isBlank(before) && !isBlank(after) && before !== after;
}

export class NodeNameHistoryRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  /** Insert one rename, then trim this (source, node) to its newest rows. */
  async record(row: Omit<NodeNameHistoryRow, 'id'>, cap: number = NODE_NAME_HISTORY_CAP): Promise<void> {
    const { nodeNameHistory } = this.tables;
    await this.db.insert(nodeNameHistory).values({
      sourceId: row.sourceId,
      protocol: row.protocol,
      nodeKey: row.nodeKey,
      oldLongName: row.oldLongName,
      newLongName: row.newLongName,
      oldShortName: row.oldShortName,
      newShortName: row.newShortName,
      changedAt: row.changedAt,
    });

    const scope = and(
      eq(nodeNameHistory.sourceId, row.sourceId),
      eq(nodeNameHistory.protocol, row.protocol),
      eq(nodeNameHistory.nodeKey, row.nodeKey),
    );
    const stale = await this.db
      .select({ id: nodeNameHistory.id })
      .from(nodeNameHistory)
      .where(scope)
      .orderBy(desc(nodeNameHistory.changedAt), desc(nodeNameHistory.id))
      .limit(1000)
      .offset(cap);
    const ids = (stale as Array<{ id: number }>).map(r => Number(r.id));
    if (ids.length > 0) {
      await this.db.delete(nodeNameHistory).where(inArray(nodeNameHistory.id, ids));
    }
  }

  /** A node's renames on the given sources, newest first. */
  async listForNode(protocol: NodeNameProtocol, nodeKey: string, sourceIds: string[]): Promise<NodeNameHistoryRow[]> {
    if (sourceIds.length === 0) return [];
    const { nodeNameHistory } = this.tables;
    const rows = await this.db
      .select()
      .from(nodeNameHistory)
      .where(and(
        eq(nodeNameHistory.protocol, protocol),
        eq(nodeNameHistory.nodeKey, nodeKey),
        inArray(nodeNameHistory.sourceId, sourceIds),
      ))
      .orderBy(desc(nodeNameHistory.changedAt), desc(nodeNameHistory.id));
    return (rows as Record<string, unknown>[]).map(r => this.normalizeBigInts({
      id: r.id,
      sourceId: r.sourceId,
      protocol: r.protocol,
      nodeKey: r.nodeKey,
      oldLongName: r.oldLongName ?? null,
      newLongName: r.newLongName ?? null,
      oldShortName: r.oldShortName ?? null,
      newShortName: r.newShortName ?? null,
      changedAt: Number(r.changedAt),
    }) as NodeNameHistoryRow);
  }

  /** Drop one node's history on one source (the node was deleted there). */
  async deleteForNode(protocol: NodeNameProtocol, nodeKey: string, sourceId: string): Promise<void> {
    const { nodeNameHistory } = this.tables;
    await this.db.delete(nodeNameHistory).where(and(
      eq(nodeNameHistory.protocol, protocol),
      eq(nodeNameHistory.nodeKey, nodeKey),
      eq(nodeNameHistory.sourceId, sourceId),
    ));
  }

  /** Drop a source's history for one protocol (its nodes were purged). */
  async deleteForSourceProtocol(sourceId: string, protocol: NodeNameProtocol): Promise<void> {
    const { nodeNameHistory } = this.tables;
    await this.db.delete(nodeNameHistory).where(and(
      eq(nodeNameHistory.sourceId, sourceId),
      eq(nodeNameHistory.protocol, protocol),
    ));
  }

  /** Drop everything a source recorded (the source was deleted). */
  async deleteBySourceId(sourceId: string): Promise<void> {
    if (!sourceId) throw new Error('NodeNameHistoryRepository.deleteBySourceId requires a sourceId');
    const { nodeNameHistory } = this.tables;
    await this.db.delete(nodeNameHistory).where(eq(nodeNameHistory.sourceId, sourceId));
  }

  /** Drop every row of one protocol (all nodes of that protocol were purged). */
  async deleteAllForProtocol(protocol: NodeNameProtocol): Promise<void> {
    const { nodeNameHistory } = this.tables;
    await this.db.delete(nodeNameHistory).where(eq(nodeNameHistory.protocol, protocol));
  }
}
