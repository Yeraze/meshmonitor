import databaseService from '../../services/database.js';
import { DbNode } from '../../db/types.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { logger } from '../../utils/logger.js';

const NODE_INFO_FIELDS = [
  'longName', 'shortName', 'hwModel', 'role', 'macaddr',
  'publicKey', 'hasPKC', 'firmwareVersion',
] as const;

type NodeInfoField = (typeof NODE_INFO_FIELDS)[number];

export interface CopyCandidate {
  sourceId: string;
  sourceName: string;
  sourceType: string;
  node: Pick<DbNode, 'nodeNum' | 'nodeId' | NodeInfoField | 'updatedAt' | 'lastHeard'>;
  fieldsFilled: number;
  totalFields: number;
}

export interface CopyNodeInfoResult {
  copiedFields: string[];
  pushedToDevice: boolean;
}

/** Canonical "this NodeInfo field is empty" predicate. */
export function isNodeInfoFieldBlank(value: unknown): boolean {
  return value == null || value === '';
}

/** Count of NODE_INFO_FIELDS that are non-blank on a node. Used for donor ranking. */
export function countFilledNodeInfoFields(node: Partial<DbNode>): number {
  return NODE_INFO_FIELDS.filter(f => !isNodeInfoFieldBlank(node[f as keyof DbNode])).length;
}

/** Analysis field set — NODE_INFO_FIELDS minus the derived hasPKC flag. */
export const ANALYZE_NODE_INFO_FIELDS =
  NODE_INFO_FIELDS.filter(f => f !== 'hasPKC') as readonly NodeInfoField[];

function countFilledFields(node: DbNode): number {
  return countFilledNodeInfoFields(node);
}

function pickNodeInfoFields(node: DbNode): Pick<DbNode, NodeInfoField> {
  const picked: any = {};
  for (const f of NODE_INFO_FIELDS) {
    picked[f] = (node as any)[f] ?? null;
  }
  return picked;
}

export async function findCopyCandidates(
  nodeNum: number,
  targetSourceId: string,
): Promise<CopyCandidate[]> {
  const allSources = await databaseService.sources.getAllSources();
  const candidates: CopyCandidate[] = [];

  for (const source of allSources) {
    if (source.id === targetSourceId) continue;

    const node = await databaseService.nodes.getNode(nodeNum, source.id);
    if (!node) continue;
    if (!node.longName && !node.shortName) continue;

    candidates.push({
      sourceId: source.id,
      sourceName: source.name,
      sourceType: source.type,
      node: {
        nodeNum: node.nodeNum,
        nodeId: node.nodeId,
        ...pickNodeInfoFields(node),
        updatedAt: node.updatedAt,
        lastHeard: node.lastHeard ?? null,
      },
      fieldsFilled: countFilledFields(node),
      totalFields: NODE_INFO_FIELDS.length,
    });
  }

  candidates.sort((a, b) => b.fieldsFilled - a.fieldsFilled || b.node.updatedAt - a.node.updatedAt);
  return candidates;
}

/** Runtime guard for field names arriving from the request body. */
export function isNodeInfoField(value: unknown): value is NodeInfoField {
  return typeof value === 'string' && (NODE_INFO_FIELDS as readonly string[]).includes(value);
}

export { NODE_INFO_FIELDS };
export type { NodeInfoField };

/**
 * Copy NodeInfo fields from one source's row to another's.
 *
 * `fields` (#4244) selects exactly which fields to copy, and those fields
 * OVERWRITE the target even when it already holds a value. This exists because
 * the previous all-or-nothing rule — copy only when the target is null/empty —
 * made the feature useless in its most common case: MeshMonitor auto-populates
 * longName/shortName with a derived placeholder ("Node !383c3519"), which is a
 * non-empty string, so real incoming NodeInfo was blocked forever. The same
 * applied to any field a prior copy had already filled (e.g. a role that has
 * since changed upstream).
 *
 * Omitting `fields` preserves the legacy fill-empty-only behavior, so existing
 * callers are unaffected.
 */
export async function copyNodeInfo(
  nodeNum: number,
  fromSourceId: string,
  toSourceId: string,
  pushToNodeDb: boolean = false,
  fields?: readonly NodeInfoField[],
): Promise<CopyNodeInfoResult> {
  const donorNode = await databaseService.nodes.getNode(nodeNum, fromSourceId);
  if (!donorNode) {
    throw new Error(`Node ${nodeNum} not found in source ${fromSourceId}`);
  }

  const targetNode = await databaseService.nodes.getNode(nodeNum, toSourceId);
  if (!targetNode) {
    throw new Error(`Node ${nodeNum} not found in source ${toSourceId}`);
  }

  const updates: Partial<DbNode> = {};
  const copiedFields: string[] = [];

  // An explicit selection means the user has seen both values and chosen to
  // take the donor's, so a populated target is no longer a reason to skip.
  const selected = fields && fields.length > 0 ? new Set<string>(fields) : null;

  for (const field of NODE_INFO_FIELDS) {
    if (selected && !selected.has(field)) continue;

    const donorVal = (donorNode as any)[field];
    if (donorVal == null || donorVal === '') continue;

    if (!selected) {
      // Legacy path: fill only what the target is missing.
      const targetVal = (targetNode as any)[field];
      if (targetVal != null && targetVal !== '') continue;
    }

    (updates as any)[field] = donorVal;
    copiedFields.push(field);
  }

  if (copiedFields.length === 0) {
    return { copiedFields: [], pushedToDevice: false };
  }

  await databaseService.nodes.upsertNode(
    { nodeNum, nodeId: targetNode.nodeId, ...updates },
    toSourceId,
  );

  logger.info(
    `Copied NodeInfo for node ${nodeNum} from source ${fromSourceId} to ${toSourceId}: ${copiedFields.join(', ')}`,
  );

  let pushedToDevice = false;
  if (pushToNodeDb) {
    pushedToDevice = await pushNodeInfoToDevice(nodeNum, toSourceId, donorNode);
  }

  return { copiedFields, pushedToDevice };
}

async function pushNodeInfoToDevice(
  nodeNum: number,
  targetSourceId: string,
  donorNode: DbNode,
): Promise<boolean> {
  const manager = sourceManagerRegistry.getManager(targetSourceId) as any;
  if (!manager || typeof manager.sendNodeInfoRequest !== 'function') {
    logger.warn(
      `Cannot push NodeInfo to device: source ${targetSourceId} does not support sendNodeInfoRequest`,
    );
    return false;
  }

  try {
    const channel = donorNode.channel ?? 0;
    await manager.sendNodeInfoRequest(nodeNum, channel);
    logger.info(`Pushed NodeInfo request for node ${nodeNum} to device on source ${targetSourceId}`);
    return true;
  } catch (error) {
    logger.error(`Failed to push NodeInfo to device for node ${nodeNum}:`, error);
    return false;
  }
}
