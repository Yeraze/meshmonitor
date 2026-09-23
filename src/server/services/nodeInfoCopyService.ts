import databaseService from '../../services/database.js';
import { DbNode } from '../../db/types.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { logger } from '../../utils/logger.js';
import { CHANNEL_DB_OFFSET } from '../constants/meshtastic.js';
import { isBlankMacAddr } from '../../utils/nodeFieldBlanks.js';

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

/**
 * Fields whose stored `0` is a "not reported" sentinel rather than a real
 * value, and which `NodesRepository.upsertNode` therefore refuses to persist.
 *
 * `hwModel` 0 is `HardwareModel.UNSET`. Both the update and the insert paths in
 * `src/db/repositories/nodes.ts` map an incoming 0 back to the stored value (or
 * to null on first insert) — see the `#3505` notes there. `role` is NOT in this
 * set: role 0 is `Role.CLIENT`, a genuine value the repository stores.
 *
 * Keeping this list next to the blank predicate is what stopped #5193: the
 * analyzer used to count a donor's `hwModel: 0` as data worth copying, the copy
 * dutifully reported it as copied, and the repository dropped it on the floor.
 * The target stayed blank, so the very next analysis offered the identical
 * copy — an enrichment count that could never reach zero, and (with "push to
 * device" on) a NodeInfo request re-sent over LoRa on every press.
 */
const ZERO_IS_UNSET_FIELDS = new Set<string>(['hwModel']);

/**
 * Canonical "this NodeInfo field is empty" predicate.
 *
 * Pass `field` wherever it is known: it is what lets `hwModel: 0` read as blank
 * rather than as a value, keeping this predicate in step with what the nodes
 * repository will actually store (#5193).
 */
export function isNodeInfoFieldBlank(value: unknown, field?: string): boolean {
  if (value == null || value === '') return true;
  // #5231: an all-zero MAC is the string-typed sibling of the `hwModel: 0`
  // sentinel. `User.macaddr` was deprecated in firmware 2.1.x, so many nodes
  // broadcast six zero bytes; '000000000000' looks like data to a naive
  // emptiness check, so a donor was credited with a MAC it does not have and
  // the report kept offering a copy that changed nothing.
  if (field === 'macaddr' && isBlankMacAddr(value)) return true;
  return field !== undefined && value === 0 && ZERO_IS_UNSET_FIELDS.has(field);
}

/** Count of NODE_INFO_FIELDS that are non-blank on a node. Used for donor ranking. */
export function countFilledNodeInfoFields(node: Partial<DbNode>): number {
  return NODE_INFO_FIELDS.filter(f => !isNodeInfoFieldBlank(node[f as keyof DbNode], f)).length;
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

/**
 * Snapshot of a node's current NodeInfo fields on one source, in the same
 * shape as `CopyCandidate['node']`. Null when the node is unknown to that
 * source. Lets callers that don't already hold the target row (e.g. the
 * cross-source enrichment report) render the "current" side of the copy diff.
 */
export async function getNodeInfoSnapshot(
  nodeNum: number,
  sourceId: string,
): Promise<CopyCandidate['node'] | null> {
  const node = await databaseService.nodes.getNode(nodeNum, sourceId);
  if (!node) return null;
  return {
    nodeNum: node.nodeNum,
    nodeId: node.nodeId,
    ...pickNodeInfoFields(node),
    updatedAt: node.updatedAt,
    lastHeard: node.lastHeard ?? null,
  };
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
    // A donor value the repository would refuse to store (hwModel 0) is not
    // worth copying — reporting it as copied is exactly what made the
    // enrichment count oscillate forever in #5193. This applies in the explicit
    // `fields` overwrite mode too: picking hwModel from an UNSET donor yields an
    // empty `copiedFields` rather than a write the repository would discard,
    // which is what the caller's UI should report.
    if (isNodeInfoFieldBlank(donorVal, field)) continue;

    if (!selected) {
      // Legacy path: fill only what the target is missing.
      const targetVal = (targetNode as any)[field];
      if (!isNodeInfoFieldBlank(targetVal, field)) continue;
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

  // Read the target back and say so loudly if a field we just "copied" is still
  // blank. A write the repository silently drops is invisible from here, and
  // the caller re-offers the identical copy on its next analysis — the
  // never-ending enrichment count of #5193. This costs one read per applied
  // item on an operator-triggered action, which is worth a loop we can see.
  const verifyNode = await databaseService.nodes.getNode(nodeNum, toSourceId);
  if (verifyNode) {
    const notPersisted = copiedFields.filter(f =>
      isNodeInfoFieldBlank(verifyNode[f as keyof DbNode], f),
    );
    if (notPersisted.length > 0) {
      logger.warn(
        `NodeInfo copy for node ${nodeNum} did not persist on source ${toSourceId}: ` +
        `${notPersisted.join(', ')} still blank after the write. ` +
        'The donor value is one the nodes repository refuses to store.',
      );
    }
  }

  let pushedToDevice = false;
  if (pushToNodeDb) {
    pushedToDevice = await pushNodeInfoToDevice(nodeNum, toSourceId, targetNode);
  }

  return { copiedFields, pushedToDevice };
}

/**
 * Resolve the channel slot to address the target device on.
 *
 * This used to read `donorNode.channel`, which is a number that only means
 * anything on the DONOR's source. For an MQTT donor it is not even a slot: MQTT
 * rows carry `CHANNEL_DB_OFFSET + channelDatabaseId` (>= 100) so virtual-channel
 * permissions can key off it. Handing that to the target radio asked it to
 * transmit on a channel it has never had, and it answered with a flood of
 * `NO_CHANNEL (6)` routing errors — the push never reached the mesh (#5193).
 *
 * The target row's own `channel` is the right slot, and only when it is a real
 * one. Anything else falls back to the primary channel, which every device has.
 */
function resolvePushChannel(targetNode: DbNode): number {
  const channel = targetNode.channel;
  if (typeof channel !== 'number' || !Number.isInteger(channel)) return 0;
  if (channel < 0 || channel >= CHANNEL_DB_OFFSET) return 0;
  return channel;
}

async function pushNodeInfoToDevice(
  nodeNum: number,
  targetSourceId: string,
  targetNode: DbNode,
): Promise<boolean> {
  const manager = sourceManagerRegistry.getManager(targetSourceId) as any;
  if (!manager || typeof manager.sendNodeInfoRequest !== 'function') {
    logger.warn(
      `Cannot push NodeInfo to device: source ${targetSourceId} does not support sendNodeInfoRequest`,
    );
    return false;
  }

  try {
    const channel = resolvePushChannel(targetNode);
    await manager.sendNodeInfoRequest(nodeNum, channel);
    logger.info(
      `Pushed NodeInfo request for node ${nodeNum} to device on source ${targetSourceId} (channel ${channel})`,
    );
    return true;
  } catch (error) {
    logger.error(`Failed to push NodeInfo to device for node ${nodeNum}:`, error);
    return false;
  }
}

/**
 * Send one NodeInfo request for a node, on the channel its row says it lives
 * on (#5287). Exposed for the Auto-Enrichment scheduler, which fills the
 * database in one pass and then pushes to the radio separately — capped and
 * spaced — rather than letting `copyNodeInfo` push inline for every node.
 *
 * Returns false (never throws) when the row is gone, the source cannot send,
 * or the send fails, so a scheduler can drop the entry instead of retrying it
 * forever.
 */
export async function pushNodeInfoRequestForNode(
  nodeNum: number,
  targetSourceId: string,
): Promise<boolean> {
  const targetNode = await databaseService.nodes.getNode(nodeNum, targetSourceId);
  if (!targetNode) return false;
  return pushNodeInfoToDevice(nodeNum, targetSourceId, targetNode);
}
