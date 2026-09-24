/**
 * Telemetry outlier purge (#5333).
 *
 * Two steps, same analysis:
 *   1. preview — scan the raw rows of one (source, telemetryType[, node]) scope
 *      and report what would go. Returns a `cutoffId` (highest row id seen) and
 *      a `fingerprint` of the flagged row ids.
 *   2. purge — re-run the identical analysis over rows with id <= cutoffId,
 *      refuse (PREVIEW_STALE) unless the flagged ids still hash to the preview
 *      fingerprint, then delete exactly those ids.
 *
 * So the delete only ever touches rows the user saw in the preview: rows that
 * arrived later sit above the cutoff, and any change to the flagged set (a
 * retention sweep shifting the median, say) forces a fresh preview.
 *
 * Each node's series is analysed on its own, one node at a time, so a
 * source-wide sweep holds one series in memory at once.
 */
import databaseService from '../../services/database.js';
import {
  analyzeSeries,
  type OutlierCriteria,
  type OutlierNodeSummary,
  type OutlierPreview,
  type OutlierPreviewPoint,
  type OutlierPurgeResult,
} from '../../utils/telemetryOutliers.js';

/** Max flagged points returned by a preview (the delete is not capped). */
export const OUTLIER_PREVIEW_POINT_LIMIT = 200;
/** Max per-node summaries returned by a sweep preview. */
export const OUTLIER_PREVIEW_NODE_LIMIT = 50;

export interface OutlierScope {
  sourceId: string;
  telemetryType: string;
  /** One node (chart path); omit to sweep every node on the source. */
  nodeId?: string | null;
}

interface OutlierPlan {
  cutoffId: number | null;
  ids: number[];
  rowsScanned: number;
  nodeSummaries: OutlierNodeSummary[];
  points: OutlierPreviewPoint[];
  pointsTruncated: boolean;
  removedMin: number | null;
  removedMax: number | null;
}

/** FNV-1a (32-bit) over the sorted ids — a cheap "same set?" check, not security. */
export function fingerprintIds(ids: readonly number[]): string {
  const sorted = [...ids].sort((a, b) => a - b);
  let h = 0x811c9dc5;
  const text = `${sorted.length}:${sorted.join(',')}`;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

async function planOutliers(
  scope: OutlierScope,
  criteria: OutlierCriteria,
  cutoffId: number | null,
): Promise<OutlierPlan> {
  const plan: OutlierPlan = {
    cutoffId,
    ids: [],
    rowsScanned: 0,
    nodeSummaries: [],
    points: [],
    pointsTruncated: false,
    removedMin: null,
    removedMax: null,
  };
  if (cutoffId === null) return plan;

  const nodeIds = scope.nodeId
    ? [scope.nodeId]
    : await databaseService.getTelemetryNodeIdsForTypeAsync(scope.sourceId, scope.telemetryType, cutoffId);

  for (const nodeId of nodeIds) {
    const series = await databaseService.getTelemetrySeriesForOutlierScanAsync(
      scope.sourceId,
      scope.telemetryType,
      nodeId,
      cutoffId,
    );
    if (series.length === 0) continue;
    const analysis = analyzeSeries(series, criteria);
    plan.rowsScanned += series.length;
    plan.nodeSummaries.push({
      nodeId,
      sampleCount: analysis.sampleCount,
      median: analysis.median,
      mad: analysis.mad,
      scaleKind: analysis.scaleKind,
      flaggedCount: analysis.flagged.length,
    });
    for (const p of analysis.flagged) {
      plan.ids.push(p.id);
      plan.removedMin = plan.removedMin === null ? p.value : Math.min(plan.removedMin, p.value);
      plan.removedMax = plan.removedMax === null ? p.value : Math.max(plan.removedMax, p.value);
      if (plan.points.length < OUTLIER_PREVIEW_POINT_LIMIT) {
        plan.points.push({ id: p.id, nodeId, value: p.value, timestamp: p.timestamp, reason: p.reason });
      } else {
        plan.pointsTruncated = true;
      }
    }
  }
  return plan;
}

/** Dry run: what would an outlier purge of this scope remove? Deletes nothing. */
export async function previewTelemetryOutliers(
  scope: OutlierScope,
  criteria: OutlierCriteria,
): Promise<OutlierPreview> {
  const cutoffId = await databaseService.getMaxTelemetryIdForTypeAsync(
    scope.sourceId,
    scope.telemetryType,
    scope.nodeId ?? undefined,
  );
  const plan = await planOutliers(scope, criteria, cutoffId);
  const single = scope.nodeId ? plan.nodeSummaries[0] : undefined;
  const affectedNodes = plan.nodeSummaries
    .filter(n => n.flaggedCount > 0)
    .sort((a, b) => b.flaggedCount - a.flaggedCount || a.nodeId.localeCompare(b.nodeId));

  return {
    sourceId: scope.sourceId,
    telemetryType: scope.telemetryType,
    nodeId: scope.nodeId ?? null,
    criteria,
    cutoffId: plan.cutoffId,
    fingerprint: fingerprintIds(plan.ids),
    rowsScanned: plan.rowsScanned,
    nodesScanned: plan.nodeSummaries.length,
    affectedCount: plan.ids.length,
    nodesAffected: affectedNodes.length,
    removedMin: plan.removedMin,
    removedMax: plan.removedMax,
    median: single?.median ?? null,
    mad: single?.mad ?? null,
    scaleKind: scope.nodeId ? (single?.scaleKind ?? null) : null,
    nodesTooFew: plan.nodeSummaries.filter(n => n.scaleKind === 'too_few').length,
    nodesFlat: plan.nodeSummaries.filter(n => n.scaleKind === 'flat').length,
    points: plan.points,
    pointsTruncated: plan.pointsTruncated,
    nodes: affectedNodes.slice(0, OUTLIER_PREVIEW_NODE_LIMIT),
  };
}

export class OutlierPreviewStaleError extends Error {
  constructor() {
    super('Telemetry changed since the preview; run the preview again');
    this.name = 'OutlierPreviewStaleError';
  }
}

/**
 * Delete the outliers a preview reported. Re-runs the analysis over rows with
 * id <= `cutoffId` and throws {@link OutlierPreviewStaleError} unless the
 * flagged ids match the preview's `fingerprint`.
 */
export async function purgeTelemetryOutliers(
  scope: OutlierScope,
  criteria: OutlierCriteria,
  cutoffId: number,
  fingerprint: string,
): Promise<OutlierPurgeResult> {
  const plan = await planOutliers(scope, criteria, cutoffId);
  if (fingerprintIds(plan.ids) !== fingerprint) {
    throw new OutlierPreviewStaleError();
  }
  const deletedCount = await databaseService.deleteTelemetryByIdsAsync(
    scope.sourceId,
    scope.telemetryType,
    plan.ids,
  );
  return {
    deletedCount,
    nodesAffected: plan.nodeSummaries.filter(n => n.flaggedCount > 0).length,
  };
}
