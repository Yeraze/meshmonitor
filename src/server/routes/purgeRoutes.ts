import { Router, Request, Response } from 'express';
import { requireAdmin } from '../auth/authMiddleware.js';
import databaseService from '../../services/database.js';
import { ALL_SOURCES } from '../../db/repositories/index.js';
import { logger } from '../../utils/logger.js';
import { resolveOwnMeshtasticManager } from '../utils/resolveSourceManager.js';
import { ok, fail } from '../utils/apiResponse.js';
import { validateOutlierCriteria, type OutlierCriteria } from '../../utils/telemetryOutliers.js';
import {
  previewTelemetryOutliers,
  purgeTelemetryOutliers,
  OutlierPreviewStaleError,
  type OutlierScope,
} from '../services/telemetryOutlierService.js';

const router = Router();

router.use(requireAdmin());

router.post('/nodes', async (req: Request, res: Response) => {
  try {
    const { sourceId: purgeNodesSourceId } = req.body || {};
    // intentional cross-source: purge stats reflect global total before wipe
    const nodeCount = await databaseService.nodes.getNodeCount(ALL_SOURCES);
    await databaseService.purgeAllNodesAsync(purgeNodesSourceId);
    // Re-sync from THIS source's own radio. A non-Meshtastic source has none;
    // asking the primary TCP radio to refresh would be the wrong device (#5375).
    const purgeNodesManager = resolveOwnMeshtasticManager(purgeNodesSourceId);
    await purgeNodesManager?.refreshNodeDatabase();

    void databaseService.auditLogAsync(
      req.user!.id,
      'nodes_purged',
      'nodes',
      JSON.stringify({ count: nodeCount, sourceId: purgeNodesSourceId ?? null }),
      req.ip || null
    );

    res.json({
      success: true,
      message: purgeNodesSourceId
        ? `Nodes and traceroutes purged for source ${purgeNodesSourceId}, refresh triggered`
        : 'All nodes and traceroutes purged, refresh triggered',
    });
  } catch (error) {
    logger.error('Error purging nodes:', error);
    res.status(500).json({ error: 'Failed to purge nodes' });
  }
});

router.post('/telemetry', async (req: Request, res: Response) => {
  try {
    const { sourceId: purgeTelemetrySourceId } = req.body || {};
    await databaseService.purgeAllTelemetryAsync(purgeTelemetrySourceId);

    void databaseService.auditLogAsync(
      req.user!.id,
      'telemetry_purged',
      'telemetry',
      JSON.stringify({ sourceId: purgeTelemetrySourceId ?? null }),
      req.ip || null
    );

    res.json({
      success: true,
      message: purgeTelemetrySourceId
        ? `Telemetry purged for source ${purgeTelemetrySourceId}`
        : 'All telemetry data purged',
    });
  } catch (error) {
    logger.error('Error purging telemetry:', error);
    res.status(500).json({ error: 'Failed to purge telemetry' });
  }
});

// ── Telemetry outlier purge (#5333) ──────────────────────────────────────────
// Preview (dry run) → confirm → purge. Admin-only via router.use(requireAdmin()).
// Always scoped to one source; the purge only removes the rows the preview
// reported (cutoffId + fingerprint, see telemetryOutlierService).

const MAX_IDENT_LENGTH = 128;

function isIdent(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= MAX_IDENT_LENGTH;
}

type OutlierRequest =
  | { ok: true; scope: OutlierScope; criteria: OutlierCriteria }
  | { ok: false; status: number; code: string; message: string };

async function parseOutlierRequest(rawBody: unknown): Promise<OutlierRequest> {
  const body = (rawBody && typeof rawBody === 'object' ? rawBody : {}) as Record<string, unknown>;
  const { sourceId, telemetryType, nodeId } = body;
  if (!isIdent(sourceId)) {
    return { ok: false, status: 400, code: 'MISSING_SOURCE_ID', message: 'sourceId is required' };
  }
  if (!isIdent(telemetryType)) {
    return { ok: false, status: 400, code: 'MISSING_TELEMETRY_TYPE', message: 'telemetryType is required' };
  }
  if (nodeId !== undefined && nodeId !== null && !isIdent(nodeId)) {
    return { ok: false, status: 400, code: 'INVALID_NODE_ID', message: 'nodeId must be a non-empty string' };
  }
  const validated = validateOutlierCriteria(body);
  if (!validated.ok) {
    return { ok: false, status: 400, code: validated.code, message: validated.message };
  }
  if (!(await databaseService.sources.getSource(sourceId))) {
    return { ok: false, status: 404, code: 'SOURCE_NOT_FOUND', message: 'Source not found' };
  }
  return {
    ok: true,
    scope: { sourceId, telemetryType, nodeId: isIdent(nodeId) ? nodeId : null },
    criteria: validated.criteria,
  };
}

/** Telemetry types stored for one source, for the Settings sweep's metric picker. */
router.get('/telemetry/outliers/types', async (req: Request, res: Response) => {
  try {
    const sourceId = req.query.sourceId;
    if (!isIdent(sourceId)) {
      return fail(res, 400, 'MISSING_SOURCE_ID', 'sourceId is required');
    }
    // Not getAllNodesTelemetryTypesAsync: its SQLite path ignores sourceId.
    const types = await databaseService.getTelemetryTypesForSourceAsync(sourceId);
    return ok(res, { types });
  } catch (error) {
    logger.error('Error listing telemetry types for outlier purge:', error);
    return fail(res, 500, 'INTERNAL_ERROR', 'Failed to list telemetry types');
  }
});

router.post('/telemetry/outliers/preview', async (req: Request, res: Response) => {
  try {
    const parsed = await parseOutlierRequest(req.body);
    if (!parsed.ok) return fail(res, parsed.status, parsed.code, parsed.message);
    const preview = await previewTelemetryOutliers(parsed.scope, parsed.criteria);
    return ok(res, preview);
  } catch (error) {
    logger.error('Error previewing telemetry outliers:', error);
    return fail(res, 500, 'INTERNAL_ERROR', 'Failed to preview telemetry outliers');
  }
});

router.post('/telemetry/outliers', async (req: Request, res: Response) => {
  try {
    const parsed = await parseOutlierRequest(req.body);
    if (!parsed.ok) return fail(res, parsed.status, parsed.code, parsed.message);

    const { cutoffId, fingerprint } = req.body;
    if (typeof cutoffId !== 'number' || !Number.isSafeInteger(cutoffId) || cutoffId < 0) {
      return fail(res, 400, 'INVALID_CUTOFF', 'cutoffId from the preview is required');
    }
    if (typeof fingerprint !== 'string' || !/^[0-9a-f]{8}$/.test(fingerprint)) {
      return fail(res, 400, 'INVALID_FINGERPRINT', 'fingerprint from the preview is required');
    }

    const result = await purgeTelemetryOutliers(parsed.scope, parsed.criteria, cutoffId, fingerprint);

    void databaseService.auditLogAsync(
      req.user!.id,
      'telemetry_outliers_purged',
      'telemetry',
      JSON.stringify({
        sourceId: parsed.scope.sourceId,
        telemetryType: parsed.scope.telemetryType,
        nodeId: parsed.scope.nodeId ?? null,
        criteria: parsed.criteria,
        cutoffId,
        count: result.deletedCount,
        nodesAffected: result.nodesAffected,
      }),
      req.ip || null
    );

    return ok(res, result);
  } catch (error) {
    if (error instanceof OutlierPreviewStaleError) {
      return fail(res, 409, 'PREVIEW_STALE', error.message);
    }
    logger.error('Error purging telemetry outliers:', error);
    return fail(res, 500, 'INTERNAL_ERROR', 'Failed to purge telemetry outliers');
  }
});

router.post('/messages', async (req: Request, res: Response) => {
  try {
    // intentional cross-source: message purge is a global operation across all sources
    const messageCount = await databaseService.messages.getMessageCount(ALL_SOURCES);
    await databaseService.messages.deleteAllMessages(ALL_SOURCES);

    void databaseService.auditLogAsync(
      req.user!.id,
      'messages_purged',
      'messages',
      JSON.stringify({ count: messageCount }),
      req.ip || null
    );

    res.json({ success: true, message: 'All messages purged' });
  } catch (error) {
    logger.error('Error purging messages:', error);
    res.status(500).json({ error: 'Failed to purge messages' });
  }
});

router.post('/traceroutes', async (req: Request, res: Response) => {
  try {
    // Mirrors /purge/nodes and /purge/telemetry: scope to the source whose
    // Danger Zone was used, or ALL_SOURCES from the global one. Passing the
    // scope explicitly is required — the repositories reject an omitted
    // sourceId rather than silently spanning every source (#5088).
    const { sourceId: purgeTraceroutesSourceId } = req.body || {};
    const scope = purgeTraceroutesSourceId ?? ALL_SOURCES;

    await databaseService.traceroutes.deleteAllTraceroutes(scope);
    await databaseService.traceroutes.deleteAllRouteSegments(scope);

    void databaseService.auditLogAsync(
      req.user!.id,
      'traceroutes_purged',
      'traceroute',
      JSON.stringify({ sourceId: purgeTraceroutesSourceId ?? null }),
      req.ip || null
    );

    res.json({
      success: true,
      message: purgeTraceroutesSourceId
        ? `Traceroutes and route segments purged for source ${purgeTraceroutesSourceId}`
        : 'All traceroutes and route segments purged',
    });
  } catch (error) {
    logger.error('Error purging traceroutes:', error);
    res.status(500).json({ error: 'Failed to purge traceroutes' });
  }
});

export default router;
