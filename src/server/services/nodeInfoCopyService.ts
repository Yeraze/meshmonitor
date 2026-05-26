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

function countFilledFields(node: DbNode): number {
  return NODE_INFO_FIELDS.filter(f => {
    const val = node[f as keyof DbNode];
    return val !== null && val !== undefined && val !== '';
  }).length;
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

  candidates.sort((a, b) => b.node.updatedAt - a.node.updatedAt);
  return candidates;
}

export async function copyNodeInfo(
  nodeNum: number,
  fromSourceId: string,
  toSourceId: string,
  pushToNodeDb: boolean = false,
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

  for (const field of NODE_INFO_FIELDS) {
    const donorVal = (donorNode as any)[field];
    const targetVal = (targetNode as any)[field];
    if (donorVal != null && donorVal !== '' && (targetVal == null || targetVal === '')) {
      (updates as any)[field] = donorVal;
      copiedFields.push(field);
    }
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
