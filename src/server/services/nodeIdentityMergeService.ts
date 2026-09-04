/**
 * Node identity merge — the operator-facing half of the Meshtastic 2.8
 * renumber problem (issue #5032).
 *
 * `nodeIdentityChangeService` says "this new node looks like that old one".
 * This service is what an admin runs when they agree: it re-keys the old node's
 * history onto the new node number and retires the old row.
 *
 * The mechanics live in `src/db/repositories/nodeIdentityMerge.ts`. What lives
 * here is everything that must be decided ABOVE the SQL:
 *
 * - **Preview and execute share one plan.** {@link previewNodeIdentityMerge}
 *   returns the repository's plan verbatim; {@link performNodeIdentityMerge}
 *   has the repository rebuild the same plan inside the transaction and apply
 *   it. Nothing re-implements the counting.
 * - **Never automatic.** There is no scheduler, no hook and no automation
 *   action that reaches this. A detection is advisory; a merge takes an
 *   explicit node pair from an authenticated admin.
 * - **Per-source.** Both node numbers must exist on the same source. A merge
 *   never spans sources — those are different meshes, and a matching number
 *   across them means nothing (#3745).
 * - **The node cache is invalidated afterwards.** The merge writes to `nodes`
 *   through the repository layer, which bypasses the cache hook
 *   `DatabaseService` installs on `NodesRepository`. Leaving the retired node
 *   in the in-memory cache would keep it appearing in the node list until the
 *   next restart.
 *
 * ## Mesh impact
 *
 * None. This is a database-only operation: it sends no packets, arms no timers
 * and fires no notifications. Nothing here touches the radio.
 */
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import {
  NodeIdentityMergeError,
  type MergePlan,
  type MergeRecord,
} from '../../db/repositories/nodeIdentityMerge.js';
import { detectIdentityChanges } from './nodeIdentityChangeService.js';

export { NodeIdentityMergeError };
export type { MergePlan, MergeRecord };

export interface MergeRequest {
  sourceId: string;
  /** The node being retired — the old, pre-2.8 number. */
  fromNodeNum: number;
  /** The node that survives — the new, key-derived number. */
  toNodeNum: number;
  /** Username of the admin confirming the merge, for the audit row. */
  mergedBy: string | null;
  /**
   * Required when the plan reports `undoable: false`. Without it a merge that
   * cannot be reversed is refused rather than performed quietly.
   */
  acknowledgeNoUndo?: boolean;
}

/** A preview, plus how the detector rates this pair right now. */
export interface MergePreview extends MergePlan {
  /**
   * `derivedNodeNum` / `publicKey` when a live detection backs this exact
   * pairing, `manual` when it does not. `manual` is allowed — an operator may
   * know something the detector cannot see — but it is recorded on the audit
   * row and shown in the confirmation dialog.
   */
  detectionBasis: 'derivedNodeNum' | 'publicKey' | 'manual';
}

/**
 * Does a key-verified detection back this exact (predecessor → successor) pair?
 *
 * Only the two key-verified bases can appear here: `nodeIdentityChangeService`
 * does not report name-only guesses. A `manual` answer is not a refusal, it is
 * a label — the dialog says the pairing is unverified and the audit row keeps
 * that word for ever.
 */
async function resolveDetectionBasis(
  sourceId: string,
  fromNodeNum: number,
  toNodeNum: number,
): Promise<MergePreview['detectionBasis']> {
  try {
    const report = await detectIdentityChanges(sourceId);
    const match = report.detections.find(
      (d) => d.predecessor.nodeNum === fromNodeNum && d.successor.nodeNum === toNodeNum,
    );
    if (match && (match.basis === 'derivedNodeNum' || match.basis === 'publicKey')) {
      return match.basis;
    }
  } catch (error) {
    // A detector failure must not block a merge an admin has decided on — it
    // only costs the pairing its verified label.
    logger.warn('[nodeIdentityMerge] could not run detection for the merge basis:', error);
  }
  return 'manual';
}

/**
 * Count what a merge would do, writing nothing.
 *
 * This is the endpoint the confirmation dialog renders, and it is the same
 * function the merge itself re-runs inside its transaction.
 */
export async function previewNodeIdentityMerge(
  sourceId: string,
  fromNodeNum: number,
  toNodeNum: number,
): Promise<MergePreview> {
  assertMergeableIds(sourceId, fromNodeNum, toNodeNum);
  const plan = await databaseService.nodeIdentityMerge.buildMergePlan(
    sourceId,
    fromNodeNum,
    toNodeNum,
  );
  const detectionBasis = await resolveDetectionBasis(sourceId, fromNodeNum, toNodeNum);
  return { ...plan, detectionBasis };
}

/**
 * Perform the merge. All-or-nothing: the repository runs every statement in one
 * transaction and writes the undo journal in the same one.
 */
export async function performNodeIdentityMerge(
  request: MergeRequest,
): Promise<{ mergeId: string; plan: MergePlan; detectionBasis: MergePreview['detectionBasis'] }> {
  const { sourceId, fromNodeNum, toNodeNum } = request;
  assertMergeableIds(sourceId, fromNodeNum, toNodeNum);

  const detectionBasis = await resolveDetectionBasis(sourceId, fromNodeNum, toNodeNum);

  const result = await databaseService.nodeIdentityMerge.executeMerge({
    sourceId,
    fromNodeNum,
    toNodeNum,
    basis: detectionBasis,
    mergedBy: request.mergedBy,
    acknowledgeNoUndo: request.acknowledgeNoUndo,
  });

  await refreshNodeCache(sourceId, fromNodeNum, toNodeNum);

  return { ...result, detectionBasis };
}

/**
 * Reverse a merge recorded in the journal.
 *
 * `sourceId` is the source the caller's permission was checked against; the
 * repository refuses before writing anything if the merge belongs to another
 * one, so a source-A admin cannot undo a source-B merge.
 */
export async function undoNodeIdentityMerge(
  mergeId: string,
  sourceId: string,
  undoneBy: string | null,
): Promise<MergeRecord> {
  if (!sourceId) {
    throw new NodeIdentityMergeError('SOURCE_REQUIRED', 'sourceId is required.');
  }
  const record = await databaseService.nodeIdentityMerge.undoMerge(mergeId, undoneBy, sourceId);
  await refreshNodeCache(record.sourceId, record.fromNodeNum, record.toNodeNum);
  return record;
}

/** Merges recorded on one source, newest first. */
export async function listNodeIdentityMerges(sourceId: string, limit = 50): Promise<MergeRecord[]> {
  if (!sourceId) {
    throw new NodeIdentityMergeError('SOURCE_REQUIRED', 'sourceId is required.');
  }
  return databaseService.nodeIdentityMerge.listMerges(sourceId, limit);
}

function assertMergeableIds(sourceId: string, fromNodeNum: number, toNodeNum: number): void {
  if (!sourceId) {
    throw new NodeIdentityMergeError('SOURCE_REQUIRED', 'sourceId is required; a merge never crosses sources.');
  }
  if (!Number.isFinite(fromNodeNum) || !Number.isFinite(toNodeNum)) {
    throw new NodeIdentityMergeError('INVALID_NODE', 'Both node numbers must be numeric.');
  }
  if (Number(fromNodeNum) === Number(toNodeNum)) {
    throw new NodeIdentityMergeError('SAME_NODE', 'A node cannot be merged into itself.');
  }
}

/**
 * Drop both node numbers from the in-memory node cache and re-warm it.
 *
 * `DatabaseService` keeps a `NodeCacheService` map that is normally kept
 * coherent by a write hook on `NodesRepository` (#2858). The merge writes to
 * `nodes` through its own repository, so that hook never fires: without this,
 * the retired node keeps showing up in the node list, and the survivor keeps
 * its pre-merge `createdAt`, until the process restarts.
 */
async function refreshNodeCache(sourceId: string, fromNodeNum: number, toNodeNum: number): Promise<void> {
  try {
    databaseService.nodeCache.delete(fromNodeNum, sourceId);
    databaseService.nodeCache.delete(toNodeNum, sourceId);
    if (databaseService.nodesRepo) {
      await databaseService.nodeCache.warmFromRepo(databaseService.nodesRepo);
    }
  } catch (error) {
    // A stale cache is a display bug, not a data bug — the merge itself has
    // already committed, so this must never turn into a failed response.
    logger.warn('[nodeIdentityMerge] node cache refresh after merge failed:', error);
  }
}
