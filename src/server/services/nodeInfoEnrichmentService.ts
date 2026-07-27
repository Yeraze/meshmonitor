import databaseService from '../../services/database.js';
import { DbNode } from '../../db/types.js';
import { ALL_SOURCES } from '../../db/repositories/index.js';
import { logger } from '../../utils/logger.js';
import {
  copyNodeInfo,
  isNodeInfoFieldBlank,
  countFilledNodeInfoFields,
  ANALYZE_NODE_INFO_FIELDS,
  type NodeInfoField,
} from './nodeInfoCopyService.js';

export interface EnrichmentTarget {
  targetSourceId: string;
  targetSourceName: string;
  fillableFields: NodeInfoField[]; // excludes hasPKC
  donorSourceId: string;
  donorSourceName: string;
}

export interface EnrichmentNode {
  nodeNum: number;
  nodeId: string;
  displayName: string; // longName || shortName || nodeId
  targets: EnrichmentTarget[];
}

export interface EnrichmentAnalysis {
  nodes: EnrichmentNode[];
  summary: { nodeCount: number; targetCount: number; fieldCount: number };
}

export interface EnrichmentApplyItem {
  nodeNum: number;
  targetSourceId: string;
  donorSourceId: string;
}

export interface EnrichmentApplyItemResult extends EnrichmentApplyItem {
  copiedFields: string[];
  pushedToDevice: boolean;
  error?: string; // per-item failure; does NOT abort the batch
}

export interface EnrichmentApplyResult {
  applied: EnrichmentApplyItemResult[];
  totalFieldsCopied: number;
}

/**
 * `getAllNodes()` rows carry a `sourceId` column at runtime (the repo does
 * `select()` over the full `nodes` table), but `DbNode` (src/db/types.ts)
 * does not declare it — same pattern as `RepoNodeInput` in
 * nodeCacheService.ts. Type it locally rather than widening DbNode itself.
 */
type NodeRow = DbNode & { sourceId: string };

/**
 * Analyze all nodes present in more than one source and compute, for each
 * source row that is missing NodeInfo fields (a "target"), the best donor
 * row (from another source) that could fill some of those blanks.
 *
 * Divergence from `findCopyCandidates` (nodeInfoCopyService.ts): donor
 * validity here is "can fill >= 1 of the target's blank fields", not the
 * `longName || shortName` gate used by `findCopyCandidates` — the
 * enrichment definition is field-driven rather than name-driven, since the
 * point of enrichment is filling arbitrary blank fields (not just names).
 *
 * @param allowedSourceIds  restrict the source universe (used for permission
 *   filtering by the route). `undefined` = all sources (admin path).
 */
export async function analyzeEnrichment(
  allowedSourceIds?: readonly string[],
): Promise<EnrichmentAnalysis> {
  const empty: EnrichmentAnalysis = { nodes: [], summary: { nodeCount: 0, targetCount: 0, fieldCount: 0 } };

  const allSources = await databaseService.sources.getAllSources();
  const sourceNameById = new Map<string, string>(allSources.map(s => [s.id, s.name]));

  let allowedSet: Set<string> | null = null;
  if (allowedSourceIds !== undefined) {
    allowedSet = new Set(allowedSourceIds);
    if (allowedSet.size === 0) return empty;
  }

  const allNodes = (await databaseService.nodes.getAllNodes(ALL_SOURCES)) as NodeRow[];

  // Group rows by physical nodeNum (coerced to Number — BIGINT on PG/MySQL),
  // keeping only rows whose sourceId is in the allowed set (if restricted).
  const byNodeNum = new Map<number, NodeRow[]>();
  for (const row of allNodes) {
    if (allowedSet && !allowedSet.has(row.sourceId)) continue;
    const nodeNum = Number(row.nodeNum);
    const group = byNodeNum.get(nodeNum);
    if (group) {
      group.push(row);
    } else {
      byNodeNum.set(nodeNum, [row]);
    }
  }

  const nodes: EnrichmentNode[] = [];
  let targetCount = 0;
  let fieldCount = 0;

  for (const [nodeNum, rows] of byNodeNum) {
    if (rows.length < 2) continue;

    const targets: EnrichmentTarget[] = [];

    for (const targetRow of rows) {
      const targetSourceId = targetRow.sourceId;
      const blanks = ANALYZE_NODE_INFO_FIELDS.filter(f => isNodeInfoFieldBlank(targetRow[f as keyof DbNode]));
      if (blanks.length === 0) continue;

      // Donor candidates: other source rows for this nodeNum that can fill
      // at least one of the target's blank fields.
      const donorCandidates = rows.filter(r => {
        if (r.sourceId === targetSourceId) return false;
        return blanks.some(f => !isNodeInfoFieldBlank(r[f as keyof DbNode]));
      });
      if (donorCandidates.length === 0) continue;

      // Rank identically to findCopyCandidates: most fields filled first,
      // tie-break by newer updatedAt.
      donorCandidates.sort(
        (a, b) => countFilledNodeInfoFields(b) - countFilledNodeInfoFields(a)
          || Number(b.updatedAt) - Number(a.updatedAt),
      );
      const donor = donorCandidates[0];
      const donorSourceId = donor.sourceId;

      const fillableFields = blanks.filter(f => !isNodeInfoFieldBlank(donor[f as keyof DbNode]));
      if (fillableFields.length === 0) continue;

      targets.push({
        targetSourceId,
        targetSourceName: sourceNameById.get(targetSourceId) ?? targetSourceId,
        fillableFields,
        donorSourceId,
        donorSourceName: sourceNameById.get(donorSourceId) ?? donorSourceId,
      });
    }

    if (targets.length === 0) continue;

    // nodeId/displayName sourced from the row with the most fields filled.
    const bestRow = [...rows].sort(
      (a, b) => countFilledNodeInfoFields(b) - countFilledNodeInfoFields(a),
    )[0];
    const displayName = bestRow.longName || bestRow.shortName || bestRow.nodeId;

    nodes.push({
      nodeNum,
      nodeId: bestRow.nodeId,
      displayName,
      targets,
    });

    targetCount += targets.length;
    fieldCount += targets.reduce((sum, t) => sum + t.fillableFields.length, 0);
  }

  return { nodes, summary: { nodeCount: nodes.length, targetCount, fieldCount } };
}

/**
 * Apply a batch of enrichment copies. Permission is enforced by the caller
 * (the route), not here — this service is permission-agnostic and
 * unit-testable in isolation.
 *
 * Each item is applied in its own try/catch so one bad item never aborts
 * the rest of the batch (partial success).
 */
export async function applyEnrichment(
  items: readonly EnrichmentApplyItem[],
  options: { pushToNodeDb: boolean },
): Promise<EnrichmentApplyResult> {
  const applied: EnrichmentApplyItemResult[] = [];

  for (const item of items) {
    try {
      // NOTE: no `fields` arg here — this delegates to copyNodeInfo's legacy
      // fill-blanks-only path, which never overwrites a non-blank target
      // field. This is the fill-blanks-only invariant for enrichment; do not
      // add a `fields` argument, which would flip copyNodeInfo into its
      // overwrite mode (#4244).
      const { copiedFields, pushedToDevice } = await copyNodeInfo(
        Number(item.nodeNum),
        item.donorSourceId,
        item.targetSourceId,
        options.pushToNodeDb,
      );
      applied.push({ ...item, copiedFields, pushedToDevice });
    } catch (error) {
      logger.error(
        `Enrichment apply failed for node ${item.nodeNum} (${item.donorSourceId} -> ${item.targetSourceId}):`,
        error,
      );
      applied.push({ ...item, copiedFields: [], pushedToDevice: false, error: String(error) });
    }
  }

  const totalFieldsCopied = applied.reduce((sum, a) => sum + a.copiedFields.length, 0);
  return { applied, totalFieldsCopied };
}
