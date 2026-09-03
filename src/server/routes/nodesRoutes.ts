/**
 * Nodes Routes
 *
 * The 20 inline `/nodes*` + `/auto-favorite/status` handlers, plus
 * `POST /auto-ping/stop/:nodeNum` (deliberately left inline in server.ts by
 * #3502 PR2 for this module — it stops an active auto-ping session for a
 * node and has no other natural home).
 *
 * Extracted verbatim from server.ts (was `apiRouter.*('/nodes...')` /
 * `apiRouter.*('/auto-favorite/status')` / `apiRouter.post('/auto-ping/stop/:nodeNum')`,
 * L944-L2300 pre-extraction) as part of #3502 PR3. Mounted at '/' in
 * server.ts (matches the existing '/'-mounted deviceRoutes/systemRoutes/
 * scriptRoutes/pollRoutes convention) — full internal paths are kept as-is
 * (no prefix stripping).
 *
 * Two handlers touch non-nodes resources and are kept verbatim per the
 * task spec: `scan-remote-admin` is gated on `settings:write` (it discovers
 * whether the node has remote-admin PKI, a settings-adjacent concept) and
 * `send-key-warning` is gated on `messages:write` (it sends a DM).
 */
import express from 'express';
import databaseService from '../../services/database.js';
import { ALL_SOURCES } from '../../db/repositories/index.js';
import { fallbackManager } from '../meshtasticManager.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { resolveSourceManager } from '../utils/resolveSourceManager.js';
import { isMeshCoreManager, getPrimaryMeshtasticManager } from '../sourceManagerTypes.js';
import { filterNodesByChannelPermission, enhanceNodeForClient, checkNodeChannelAccess, attachUptimeToNodes } from '../utils/nodeEnhancer.js';
import { pivotPositionHistory } from '../utils/positionHistoryPivot.js';
import { resolveRequestSourceId } from '../utils/sourceResolver.js';
import { requireSourceId } from '../utils/requireSourceId.js';
import { optionalAuth, requirePermission, hasPermission } from '../auth/authMiddleware.js';
import { logger } from '../../utils/logger.js';
import { isValidNodeNum, MAX_NODE_NUM } from '../constants/meshtastic.js';
import { fail, ok } from '../utils/apiResponse.js';
import { calculateDistance } from '../../utils/distance.js';
import {
  DEFAULT_SINGLE_ANCHOR_KM,
  MAX_STORED_ANCHORS_PER_NODE,
} from '../services/positionEstimationService.js';
import {
  encodeSharedContactUrl,
  SharedContactValidationError,
} from '../services/sharedContactService.js';
import { detectIdentityChanges } from '../services/nodeIdentityChangeService.js';
import {
  previewNodeIdentityMerge,
  performNodeIdentityMerge,
  undoNodeIdentityMerge,
  listNodeIdentityMerges,
  NodeIdentityMergeError,
} from '../services/nodeIdentityMergeService.js';
import { requireAdmin } from '../auth/authMiddleware.js';

const router = express.Router();

/**
 * Parse a `:nodeNum` path param as either a decimal node number or a `!hex`
 * node id. Callers hold one or the other depending on which list they came
 * from, and getting it wrong should not be a silent NaN lookup.
 *
 * @returns the node number, or null when the value is not a valid one.
 */
function parseNodeNumParam(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = raw.startsWith('!')
    ? parseInt(raw.slice(1), 16)
    : (/^\d+$/.test(raw) ? Number(raw) : NaN);
  return isValidNodeNum(parsed) ? parsed : null;
}

// API Routes
/**
 * GET /api/nodes
 * Returns all nodes in the mesh
 */
router.get('/nodes', optionalAuth(), async (req, res) => {
  try {
    const nodesSourceId = typeof req.query.sourceId === 'string' && req.query.sourceId.length > 0
      ? (req.query.sourceId as string)
      : undefined;
    const mgr = getPrimaryMeshtasticManager(sourceManagerRegistry) ?? fallbackManager;
    const allNodes = await mgr.getAllNodesAsync(nodesSourceId);
    const estimatedPositions = await databaseService.getAllNodesEstimatedPositionsAsync();

    // Filter nodes based on channel read permissions — scope the permission
    // lookup to the requested source so a guest with channel access on one
    // source can't see another source's nodes (#3745).
    const filteredNodes = await filterNodesByChannelPermission(allNodes, (req as any).user, nodesSourceId);
    const enhancedNodes = await Promise.all(filteredNodes.map(node => enhanceNodeForClient(node, (req as any).user, estimatedPositions)));

    // Enrich each node with its latest uptime from telemetry (#4814). Uptime is
    // not a node column — it lives only in device-metrics telemetry — so the node
    // list needs it attached here to support the "Sort: Uptime" option. One
    // grouped query for all nodes, mirroring the v1 /nodes route.
    const uptimeMap = await databaseService.telemetry.getLatestTelemetryValueForAllNodes('uptimeSeconds', nodesSourceId);
    attachUptimeToNodes(enhancedNodes, uptimeMap);

    // Append MeshCore contacts/localNodes so the aggregate dashboard map can
    // render them alongside Meshtastic nodes. MeshCore stores lastSeen in ms;
    // dashboard age-cutoff expects seconds, so we down-convert here.
    const allMeshcoreManagers = sourceManagerRegistry.getAllManagers().filter(isMeshCoreManager);
    const meshcoreManagers = nodesSourceId
      ? allMeshcoreManagers.filter(m => m.sourceId === nodesSourceId)
      : allMeshcoreManagers;
    // By default MeshCore nodes are only appended when they have a position
    // (the aggregate dashboard map use-case). Consumers that need the full node
    // list regardless of position — e.g. the notification monitored-node picker,
    // so battery-powered companions without a GPS fix can still be selected —
    // pass includeAllMeshcore=true to drop the position gate.
    const includeAllMeshcore = req.query.includeAllMeshcore === 'true';
    const meshcoreNodes: any[] = [];
    for (const mgr of meshcoreManagers) {
      for (const n of await mgr.getAllNodes()) {
        const hasPosition = n.latitude != null && n.longitude != null && !(n.latitude === 0 && n.longitude === 0);
        if (!hasPosition && !includeAllMeshcore) continue;
        const lastHeard = typeof n.lastHeard === 'number'
          ? Math.floor(n.lastHeard / 1000)
          : Math.floor(Date.now() / 1000);
        const pubKey = n.publicKey || '';
        const nodeId = `mc:${mgr.sourceId}:${pubKey.substring(0, 12)}`;
        meshcoreNodes.push({
          nodeId,
          nodeNum: 0,
          sourceId: mgr.sourceId,
          isMeshCore: true,
          isIgnored: false,
          isFavorite: false,
          user: { id: nodeId, longName: n.name, shortName: (n.name || '').substring(0, 4) },
          longName: n.name,
          shortName: (n.name || '').substring(0, 4),
          ...(hasPosition
            ? {
                latitude: n.latitude,
                longitude: n.longitude,
                position: { latitude: n.latitude, longitude: n.longitude },
              }
            : {}),
          lastHeard,
          hopsAway: 0,
          role: 0,
        });
      }
    }

    res.json([...enhancedNodes, ...meshcoreNodes]);
  } catch (error) {
    logger.error('Error fetching nodes:', error);
    res.status(500).json({ error: 'Failed to fetch nodes' });
  }
});

router.get('/nodes/active', optionalAuth(), async (req, res) => {
  try {
    const days = parseInt(req.query.days as string) || 7;
    const activeNodesSourceId = typeof req.query.sourceId === 'string' && req.query.sourceId.length > 0
      ? (req.query.sourceId as string)
      : undefined;
    const allDbNodes = await databaseService.nodes.getActiveNodes(days, activeNodesSourceId ?? ALL_SOURCES); // intentional cross-source when sourceId omitted

    // Filter nodes based on channel read permissions (source-scoped, #3745)
    const dbNodes = await filterNodesByChannelPermission(allDbNodes, (req as any).user, activeNodesSourceId);

    // Map raw DB nodes to DeviceInfo format then enhance
    const maskedNodes = await Promise.all(dbNodes.map(async node => {
      // Map basic fields
      const deviceInfo: any = {
        nodeNum: node.nodeNum,
        user: { id: node.nodeId, longName: node.longName, shortName: node.shortName },
        mobile: node.mobile,
        positionOverrideEnabled: Boolean(node.positionOverrideEnabled),
        latitudeOverride: node.latitudeOverride,
        longitudeOverride: node.longitudeOverride,
        altitudeOverride: node.altitudeOverride,
        positionOverrideIsPrivate: Boolean(node.positionOverrideIsPrivate)
      };

      if (node.latitude && node.longitude) {
        deviceInfo.position = { latitude: node.latitude, longitude: node.longitude, altitude: node.altitude };
      }

      return enhanceNodeForClient(deviceInfo, (req as any).user);
    }));

    res.json(maskedNodes);
  } catch (error) {
    logger.error('Error fetching active nodes:', error);
    res.status(500).json({ error: 'Failed to fetch active nodes' });
  }
});

/**
 * GET /api/nodes/identity-changes?sourceId=...
 *
 * Candidate Meshtastic 2.8 node-number changes on ONE source (issue #5032).
 * 2.8 derives a node's number from its public key instead of its MAC, so an
 * upgrading node arrives as a brand-new node and its history is orphaned under
 * the old number. This reports which new node looks like which old one.
 *
 * Strictly read-only and advisory. Nothing here merges, re-keys or deletes any
 * data — a name match is a heuristic, and two genuinely different nodes can
 * share a name. A human decides what, if anything, to do.
 *
 * `sourceId` is mandatory. Detection compares nodes *within* one source; a
 * cross-source comparison would pair unrelated meshes and leak node names
 * across the per-source permission boundary (#3745).
 *
 * Registered before the parametric `/nodes/:nodeNum/...` routes — a literal
 * 2-segment path does not collide with any of them, but registering first
 * removes all doubt.
 */
router.get(
  '/nodes/identity-changes',
  requirePermission('nodes', 'read', { sourceIdFrom: 'query', requireSourceId: true }),
  async (req, res) => {
    try {
      const sourceId = req.query.sourceId as string;
      const report = await detectIdentityChanges(sourceId);
      return ok(res, report);
    } catch (error) {
      logger.error('Error detecting node identity changes:', error);
      return fail(res, 500, 'INTERNAL_ERROR', 'Failed to detect node identity changes');
    }
  },
);

/**
 * The Meshtastic 2.8 identity MERGE tool (issue #5032).
 *
 * Four routes, and the shape of them is the safety design:
 *
 * - `POST /nodes/identity-changes/merge/preview` — a dry run. Counts every row
 *   that would move, be dropped or be edited, per table, and writes nothing.
 * - `POST /nodes/identity-changes/merge` — performs it, in one transaction,
 *   writing an undo journal in the same transaction.
 * - `GET  /nodes/identity-changes/merges` — what has been merged on this source.
 * - `POST /nodes/identity-changes/merges/:mergeId/undo` — reverses one.
 *
 * All four are **admin-only on top of `nodes:write`**. Re-keying a node's whole
 * history is not an ordinary node edit: a wrong pairing silently splices two
 * physical nodes' histories together, so it takes the strongest gate the app
 * has plus per-source permission, not one or the other.
 *
 * Nothing here is reachable from detection. The client sends an explicit node
 * pair; the detector only supplies the `basis` label recorded on the audit row.
 *
 * Registered before the parametric `/nodes/:nodeNum/...` routes — these are
 * literal paths that do not collide, but registering first removes all doubt.
 */
function mergeErrorStatus(code: string): number {
  switch (code) {
    case 'NODE_NOT_FOUND':
    case 'MERGE_NOT_FOUND':
      return 404;
    case 'WRONG_SOURCE':
      return 403;
    case 'SOURCE_REQUIRED':
    case 'INVALID_NODE':
    case 'SAME_NODE':
      return 400;
    case 'UNDO_UNAVAILABLE':
    case 'ALREADY_UNDONE':
    case 'LATER_MERGE_PENDING':
    case 'NODE_REAPPEARED':
    case 'JOURNAL_VERSION':
    case 'JOURNAL_UNREADABLE':
      return 409;
    default:
      return 500;
  }
}

function handleMergeError(res: express.Response, error: unknown, context: string) {
  if (error instanceof NodeIdentityMergeError) {
    logger.warn(`${context}: ${error.code} — ${error.message}`);
    return fail(res, mergeErrorStatus(error.code), error.code, error.message);
  }
  logger.error(`${context}:`, error);
  return fail(res, 500, 'INTERNAL_ERROR', context);
}

/** Read a node number from a request body value, accepting `!hex` or decimal. */
function parseMergeNodeNum(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') return parseNodeNumParam(raw);
  return null;
}

router.post(
  '/nodes/identity-changes/merge/preview',
  requirePermission('nodes', 'write', { sourceIdFrom: 'body', requireSourceId: true }),
  requireAdmin(),
  async (req, res) => {
    try {
      const sourceId = req.body?.sourceId as string;
      const fromNodeNum = parseMergeNodeNum(req.body?.fromNodeNum);
      const toNodeNum = parseMergeNodeNum(req.body?.toNodeNum);
      if (fromNodeNum === null || toNodeNum === null) {
        return fail(res, 400, 'INVALID_NODE', 'fromNodeNum and toNodeNum are required.');
      }
      const preview = await previewNodeIdentityMerge(sourceId, fromNodeNum, toNodeNum);
      return ok(res, preview);
    } catch (error) {
      return handleMergeError(res, error, 'Failed to preview node identity merge');
    }
  },
);

router.post(
  '/nodes/identity-changes/merge',
  requirePermission('nodes', 'write', { sourceIdFrom: 'body', requireSourceId: true }),
  requireAdmin(),
  async (req, res) => {
    try {
      const sourceId = req.body?.sourceId as string;
      const fromNodeNum = parseMergeNodeNum(req.body?.fromNodeNum);
      const toNodeNum = parseMergeNodeNum(req.body?.toNodeNum);
      if (fromNodeNum === null || toNodeNum === null) {
        return fail(res, 400, 'INVALID_NODE', 'fromNodeNum and toNodeNum are required.');
      }
      // The client must echo back the exact pair it previewed. This is the
      // "explicit operator confirmation" requirement in wire form: a merge
      // cannot be triggered by a request that never saw a preview.
      if (req.body?.confirm !== true) {
        return fail(
          res,
          400,
          'CONFIRMATION_REQUIRED',
          'Set confirm: true to perform the merge. Preview it first.',
        );
      }
      const result = await performNodeIdentityMerge({
        sourceId,
        fromNodeNum,
        toNodeNum,
        mergedBy: req.user?.username ?? null,
        acknowledgeNoUndo: req.body?.acknowledgeNoUndo === true,
      });
      return ok(res, result);
    } catch (error) {
      return handleMergeError(res, error, 'Failed to merge node identities');
    }
  },
);

router.get(
  '/nodes/identity-changes/merges',
  requirePermission('nodes', 'read', { sourceIdFrom: 'query', requireSourceId: true }),
  async (req, res) => {
    try {
      const sourceId = req.query.sourceId as string;
      const merges = await listNodeIdentityMerges(sourceId);
      return ok(res, { merges });
    } catch (error) {
      return handleMergeError(res, error, 'Failed to list node identity merges');
    }
  },
);

router.post(
  '/nodes/identity-changes/merges/:mergeId/undo',
  requirePermission('nodes', 'write', { sourceIdFrom: 'body', requireSourceId: true }),
  requireAdmin(),
  async (req, res) => {
    try {
      // The journal table is global, so the merge's own sourceId is checked
      // against the one the caller's permission was granted for — inside the
      // repository, before a single row is written.
      const record = await undoNodeIdentityMerge(
        String(req.params.mergeId),
        req.body?.sourceId as string,
        req.user?.username ?? null,
      );
      return ok(res, record);
    } catch (error) {
      return handleMergeError(res, error, 'Failed to undo node identity merge');
    }
  },
);

// NodeInfo enrichment (cross-source fill-blanks-only). Registered before the
// parametric /nodes/:nodeNum/... and /nodes/:nodeId/... routes as
// defense-in-depth — these are literal 2-segment paths that don't collide
// with any of them, but registering first removes all doubt.
import { handleEnrichmentAnalysis, handleEnrichmentApply } from './shared/enrichmentHandlers.js';

router.get('/nodes/enrichment/analysis', optionalAuth(), handleEnrichmentAnalysis);
router.post('/nodes/enrichment/apply', optionalAuth(), handleEnrichmentApply);

/**
 * Generate a Meshtastic SharedContact URL for a source-scoped node.
 * Unmessagable nodes remain shareable: the capability flag is preserved in
 * the encoded User rather than treated as a contact-format restriction.
 */
router.get(
  '/nodes/:nodeNum/contact-url',
  requirePermission('nodes', 'read', {
    sourceIdFrom: 'query',
    requireSourceId: true,
  }),
  async (req, res) => {
    try {
      const nodeNum = Number(req.params.nodeNum);
      const sourceId = req.query.sourceId as string;

      if (!isValidNodeNum(nodeNum) || nodeNum === 0 || nodeNum === MAX_NODE_NUM) {
        return fail(res, 400, 'INVALID_NODE_NUM', 'Invalid nodeNum');
      }

      const node = await databaseService.nodes.getNode(nodeNum, sourceId);
      if (!node) {
        return fail(res, 404, 'NODE_NOT_FOUND', 'Node not found');
      }

      if (!await checkNodeChannelAccess(node.nodeId, req.user, sourceId)) {
        return fail(res, 403, 'FORBIDDEN', 'Insufficient permissions');
      }

      const url = encodeSharedContactUrl(node);
      return ok(res, { url });
    } catch (error) {
      if (error instanceof SharedContactValidationError) {
        return fail(res, 400, 'INVALID_CONTACT_IDENTITY', error.message);
      }
      logger.error('Error generating SharedContact URL:', error);
      return fail(
        res,
        500,
        'INTERNAL_ERROR',
        'Failed to generate contact URL',
      );
    }
  },
);

/**
 * GET /api/nodes/:nodeNum/sources
 *
 * Enumerate every source that has a row for this nodeNum. Used by the "Source
 * Node Details" picker on the Mesh Issues report: a click on a node name
 * needs to jump to that node in a specific source's view, and a node may
 * exist on 1..N sources.
 *
 * Returns one entry per source with the node's per-source `longName`/
 * `shortName` (so the picker can label each row with what THAT source
 * knows about the node — a node may be nameless on one MQTT feed but named
 * on the direct TCP source). Empty array when the node isn't on any source.
 *
 * Unscoped by design: the picker's job is enumeration; the caller decides
 * which source to open. `nodes:read` is still required.
 */
router.get('/nodes/:nodeNum/sources', requirePermission('nodes', 'read'), async (req, res) => {
  try {
    const nodeNum = parseNodeNumParam(req.params.nodeNum);
    if (nodeNum === null) {
      return fail(res, 400, 'INVALID_NODE_NUM', 'nodeNum must be a decimal node number or a !hex node id');
    }

    const [nodeRows, sources] = await Promise.all([
      databaseService.nodes.getSourcesForNode(nodeNum),
      databaseService.sources.getAllSources(),
    ]);

    const sourceNameById = new Map(sources.map((s) => [s.id, s.name] as const));

    // Preserve the same ordering the sources sidebar uses (displayOrder,
    // then createdAt) so the picker matches the rest of the UI.
    const sourceOrder = new Map(sources.map((s, i) => [s.id, i] as const));
    nodeRows.sort((a, b) => (sourceOrder.get(a.sourceId) ?? 1e9) - (sourceOrder.get(b.sourceId) ?? 1e9));

    const result = nodeRows.map((r) => ({
      sourceId: r.sourceId,
      sourceName: sourceNameById.get(r.sourceId) ?? r.sourceId,
      nodeName: r.longName || r.shortName || null,
    }));

    return ok(res, { sources: result });
  } catch (error) {
    logger.error('Error getting sources for node:', error);
    return fail(res, 500, 'INTERNAL_ERROR', 'Failed to enumerate sources for node');
  }
});

// Copy NodeInfo from another source
import {
  findCopyCandidates, getNodeInfoSnapshot, copyNodeInfo, isNodeInfoField, NODE_INFO_FIELDS,
  type NodeInfoField,
} from '../services/nodeInfoCopyService.js';

router.get('/nodes/:nodeNum/copy-candidates', requirePermission('nodes', 'read'), async (req, res) => {
  try {
    const sourceId = typeof req.query.sourceId === 'string' ? req.query.sourceId : undefined;
    if (!sourceId) {
      return res.status(400).json({ error: 'sourceId query parameter is required' });
    }
    const nodeNum = Number(req.params.nodeNum);
    if (isNaN(nodeNum)) {
      return res.status(400).json({ error: 'nodeNum must be a number' });
    }
    // `target` is the node's current row on the target source (null if unseen
    // there) so callers without the row in hand can render the copy diff.
    const [candidates, target] = await Promise.all([
      findCopyCandidates(nodeNum, sourceId),
      getNodeInfoSnapshot(nodeNum, sourceId),
    ]);
    res.json({ success: true, data: { candidates, target } });
  } catch (error) {
    logger.error('Error getting copy candidates:', error);
    res.status(500).json({ error: 'Failed to retrieve copy candidates' });
  }
});

/**
 * GET /api/nodes/:nodeNum/position-estimate
 *
 * The rationale behind an ESTIMATED position (issue #4609): which anchors fed
 * it, of what type, from which nodes, with what SNR and timestamps, and how the
 * uncertainty radius was derived.
 *
 * Estimated positions only, by construction: the reply is built from the global
 * `estimated_positions` row, and the estimator deletes that row the moment a
 * node reports a real fix. A node with GPS therefore 404s rather than being
 * handed a rationale for a position it did not infer.
 *
 * GLOBAL — no `sourceId`. Estimates pool observations from every Meshtastic
 * source into one row per physical nodeNum (#3271), so there is nothing to
 * scope. The `nodes:read` gate still applies.
 *
 * Anchors are capped at storage time (MAX_STORED_ANCHORS_PER_NODE); `anchors`
 * carries what was kept and `observationCount` the true total, so a consumer
 * can say "showing N of M" instead of implying the list is complete.
 */
router.get('/nodes/:nodeNum/position-estimate', requirePermission('nodes', 'read'), async (req, res) => {
  try {
    const nodeNum = parseNodeNumParam(req.params.nodeNum);
    if (nodeNum === null) {
      return fail(res, 400, 'INVALID_NODE_NUM', 'nodeNum must be a decimal node number or a !hex node id');
    }

    const estimate = await databaseService.getEstimatedPositionByNodeNumAsync(nodeNum);
    if (!estimate) {
      return fail(res, 404, 'NO_ESTIMATED_POSITION', 'This node has no estimated position');
    }

    const stored = await databaseService.getEstimatedPositionAnchorsAsync(nodeNum);
    const anchors = stored.map((a) => ({
      anchorNodeNum: a.anchorNodeNum,
      anchorNodeId: a.anchorNodeId,
      anchorLat: a.anchorLat,
      anchorLon: a.anchorLon,
      kind: a.kind,
      snrDb: a.snrDb,
      observedAt: a.observedAt,
      weight: a.weight,
      // Derived, not stored: how far this anchor sits from the solved point.
      distanceKm: calculateDistance(estimate.latitude, estimate.longitude, a.anchorLat, a.anchorLon),
    }));

    return ok(res, {
      nodeNum: estimate.nodeNum,
      nodeId: estimate.nodeId,
      latitude: estimate.latitude,
      longitude: estimate.longitude,
      uncertaintyKm: estimate.uncertaintyKm,
      // True total observations behind the estimate — may exceed anchors.length.
      observationCount: estimate.observationCount,
      updatedAt: estimate.updatedAt,
      // Null on estimates written before #4609; the UI must say "unknown"
      // rather than guess a method.
      nEff: estimate.nEff,
      radiusMethod: estimate.radiusMethod,
      singleAnchorDefaultKm: DEFAULT_SINGLE_ANCHOR_KM,
      anchors,
      anchorsStored: anchors.length,
      anchorsTruncated: estimate.observationCount > anchors.length,
      maxStoredAnchors: MAX_STORED_ANCHORS_PER_NODE,
    });
  } catch (error) {
    logger.error('Error getting position estimate rationale:', error);
    return fail(res, 500, 'POSITION_ESTIMATE_FAILED', 'Failed to retrieve position estimate rationale');
  }
});

router.post('/nodes/:nodeNum/copy-nodeinfo', requirePermission('nodes', 'write'), async (req, res) => {
  try {
    const nodeNum = Number(req.params.nodeNum);
    if (isNaN(nodeNum)) {
      return res.status(400).json({ error: 'nodeNum must be a number' });
    }
    const { fromSourceId, toSourceId, pushToNodeDb, fields } = req.body ?? {};
    if (!fromSourceId || !toSourceId) {
      return res.status(400).json({ error: 'fromSourceId and toSourceId are required' });
    }
    // #4244: optional per-field selection. Reject unknown names rather than
    // silently ignoring them, so a client typo surfaces instead of quietly
    // copying nothing.
    let selectedFields: NodeInfoField[] | undefined;
    if (fields !== undefined) {
      if (!Array.isArray(fields) || !fields.every(isNodeInfoField)) {
        return res.status(400).json({
          error: `fields must be an array of: ${NODE_INFO_FIELDS.join(', ')}`,
        });
      }
      selectedFields = fields;
    }
    const result = await copyNodeInfo(
      nodeNum, fromSourceId, toSourceId, !!pushToNodeDb, selectedFields,
    );
    res.json({ success: true, data: result });
  } catch (error: any) {
    logger.error('Error copying node info:', error);
    const status = error.message?.includes('not found') ? 404 : 500;
    res.status(status).json({ error: error.message || 'Failed to copy node info' });
  }
});

// Get position history for a node (for mobile node visualization)
router.get('/nodes/:nodeId/position-history', optionalAuth(), async (req, res) => {
  try {
    const { nodeId } = req.params;

    // Check channel-based access for this node (source-scoped, #3745)
    if (!await checkNodeChannelAccess(nodeId, req.user, req.query.sourceId as string | undefined)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    // Allow hours parameter for future use, but default to fetching ALL position history
    // This ensures we capture movement that may have happened long ago
    // Validate hours: must be positive integer, max 8760 (1 year)
    const rawHours = req.query.hours ? parseInt(req.query.hours as string) : null;
    const hoursParam = rawHours !== null && !isNaN(rawHours) && rawHours > 0
      ? Math.min(rawHours, 8760)
      : null;
    const cutoffTime = hoursParam ? Date.now() - hoursParam * 60 * 60 * 1000 : 0;

    // Backward-pagination cursor (#3791). When supplied, only fixes strictly
    // older than this timestamp are returned, letting the client walk the whole
    // history one bounded 1500-row page at a time. Must be a positive integer.
    const rawBefore = req.query.before ? parseInt(req.query.before as string) : null;
    const beforeTimestamp = rawBefore !== null && !isNaN(rawBefore) && rawBefore > 0
      ? rawBefore
      : undefined;

    // Check privacy for position history — scope to caller's source so the
    // privacy setting reflects this source's node (same nodeNum may exist in
    // multiple sources with different privacy flags).
    const posHistSourceId = typeof req.query.sourceId === 'string' && req.query.sourceId.length > 0
      ? (req.query.sourceId as string)
      : undefined;
    const nodeNum = parseInt(nodeId.replace('!', ''), 16);
    const node = await databaseService.nodes.getNode(nodeNum, posHistSourceId);
    const isPrivate = node?.positionOverrideIsPrivate === true;
    const canViewPrivate = !!req.user && await hasPermission(req.user, 'nodes_private', 'read');
    if (isPrivate && !canViewPrivate) {
      res.json([]);
      return;
    }

    // Get only position-related telemetry (lat/lon/alt/speed/track) for the node - much more efficient!
    const positionTelemetry = await databaseService.getPositionTelemetryByNodeAsync(nodeId, 1500, cutoffTime, beforeTimestamp);

    // Pivot the per-metric telemetry rows into per-fix position objects.
    // Per-fix receive metadata (SNR + hop info, issue #3492) stamped on the
    // lat/lon rows is surfaced so the map history tooltip can show
    // "Heard directly (0 hops)" + SNR for direct hears (issue #3590).
    const positions = pivotPositionHistory(positionTelemetry);

    res.json(positions);
  } catch (error) {
    logger.error('Error fetching position history:', error);
    res.status(500).json({ error: 'Failed to fetch position history' });
  }
});

// Alternative endpoint with limit parameter for fetching positions
router.get('/nodes/:nodeId/positions', optionalAuth(), async (req, res) => {
  try {
    const { nodeId } = req.params;

    // Check channel-based access for this node (source-scoped, #3745)
    if (!await checkNodeChannelAccess(nodeId, req.user, req.query.sourceId as string | undefined)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const limit = req.query.limit ? parseInt(req.query.limit as string) : 2000;

    // Get only position-related telemetry (lat/lon/alt) for the node
    const positionTelemetry = await databaseService.getPositionTelemetryByNodeAsync(nodeId, limit);

    // Group by timestamp to get lat/lon pairs
    const positionMap = new Map<number, { lat?: number; lon?: number; alt?: number }>();

    positionTelemetry.forEach(t => {
      if (!positionMap.has(t.timestamp)) {
        positionMap.set(t.timestamp, {});
      }
      const pos = positionMap.get(t.timestamp)!;

      if (t.telemetryType === 'latitude') {
        pos.lat = t.value;
      } else if (t.telemetryType === 'longitude') {
        pos.lon = t.value;
      } else if (t.telemetryType === 'altitude') {
        pos.alt = t.value;
      }
    });

    // Convert to array of positions, filter incomplete ones
    const positions = Array.from(positionMap.entries())
      .filter(([_timestamp, pos]) => pos.lat !== undefined && pos.lon !== undefined)
      .map(([timestamp, pos]) => ({
        timestamp,
        latitude: pos.lat!,
        longitude: pos.lon!,
        altitude: pos.alt,
      }))
      .sort((a, b) => a.timestamp - b.timestamp);

    res.json(positions);
  } catch (error) {
    logger.error('Error fetching positions:', error);
    res.status(500).json({ error: 'Failed to fetch positions' });
  }
});

// Standardized error response types for better client-side handling
interface ApiErrorResponse {
  error: string;
  code: string;
  details?: string;
}

// Set node favorite status (with optional device sync)
router.post('/nodes/:nodeId/favorite', requirePermission('nodes', 'write', { sourceIdFrom: 'body' }), async (req, res) => {
  try {
    const { nodeId } = req.params;
    const { isFavorite, syncToDevice = true, destinationNodeNum, sourceId: favSourceId } = req.body;

    if (typeof isFavorite !== 'boolean') {
      const errorResponse: ApiErrorResponse = {
        error: 'isFavorite must be a boolean',
        code: 'INVALID_PARAMETER_TYPE',
        details: 'Expected boolean value for isFavorite parameter',
      };
      res.status(400).json(errorResponse);
      return;
    }

    if (typeof favSourceId !== 'string' || favSourceId.length === 0) {
      const errorResponse: ApiErrorResponse = {
        error: 'sourceId is required',
        code: 'MISSING_SOURCE_ID',
        details: 'Request body must include a sourceId string',
      };
      res.status(400).json(errorResponse);
      return;
    }

    // Convert nodeId (hex string like !a1b2c3d4) to nodeNum (integer)
    const nodeNumStr = nodeId.replace('!', '');

    // Validate hex string format (must be exactly 8 hex characters)
    if (!/^[0-9a-fA-F]{8}$/.test(nodeNumStr)) {
      const errorResponse: ApiErrorResponse = {
        error: 'Invalid nodeId format',
        code: 'INVALID_NODE_ID',
        details: 'nodeId must be in format !XXXXXXXX (8 hex characters)',
      };
      res.status(400).json(errorResponse);
      return;
    }

    const nodeNum = parseInt(nodeNumStr, 16);

    // Update favorite status in database — manual action always locks
    await databaseService.nodes.setNodeFavorite(nodeNum, isFavorite, favSourceId, true);

    // If manually unfavoriting, remove from the per-source auto-favorite tracking list.
    // The per-source manager reads/writes this list via settings.{get,set}SettingForSource
    // scoped to its own sourceId — touching the global key here would leave the per-source
    // list stale and let the sweep re-process the node.
    if (!isFavorite) {
      const autoFavoriteNodesJson = await databaseService.settings.getSettingForSource(favSourceId, 'autoFavoriteNodes') || '[]';
      const autoFavoriteNodes: number[] = JSON.parse(autoFavoriteNodesJson);
      if (autoFavoriteNodes.includes(nodeNum)) {
        const updated = autoFavoriteNodes.filter(n => n !== nodeNum);
        await databaseService.settings.setSourceSetting(favSourceId, 'autoFavoriteNodes', JSON.stringify(updated));
      }
    }

    // Phase 7: broadcast via the owning source manager's per-source virtual node.
    try {
      if (favSourceId) {
        const mgr = sourceManagerRegistry.getManager(favSourceId) as any;
        if (mgr && typeof mgr.broadcastNodeInfoUpdate === 'function') {
          await mgr.broadcastNodeInfoUpdate(nodeNum);
        }
      } else {
        for (const mgr of sourceManagerRegistry.getAllManagers() as any[]) {
          if (typeof mgr.broadcastNodeInfoUpdate === 'function') {
            await mgr.broadcastNodeInfoUpdate(nodeNum);
          }
        }
      }
    } catch (error) {
      logger.error(`⚠️ Failed to broadcast favorite update to virtual node clients for node ${nodeNum}:`, error);
    }

    // Sync to device if requested
    let deviceSyncStatus: 'success' | 'failed' | 'skipped' = 'skipped';
    let deviceSyncError: string | undefined;

    if (syncToDevice) {
      const favManager = resolveSourceManager(favSourceId);
      try {
        if (isFavorite) {
          await favManager.sendFavoriteNode(nodeNum, destinationNodeNum);
        } else {
          await favManager.sendRemoveFavoriteNode(nodeNum, destinationNodeNum);
        }
        deviceSyncStatus = 'success';
        logger.debug(`✅ Synced favorite status to device for node ${nodeNum}`);
      } catch (error) {
        // Special handling for firmware version incompatibility
        if (error instanceof Error && error.message === 'FIRMWARE_NOT_SUPPORTED') {
          deviceSyncStatus = 'skipped';
          logger.debug(
            `ℹ️ Device sync skipped for node ${nodeNum}: firmware does not support favorites (requires >= 2.7.0)`
          );
          // Don't set deviceSyncError - this is expected behavior for pre-2.7 firmware
        } else {
          deviceSyncStatus = 'failed';
          deviceSyncError = error instanceof Error ? error.message : 'Unknown error';
          logger.error(`⚠️ Failed to sync favorite to device for node ${nodeNum}:`, error);
        }
        // Don't fail the whole request if device sync fails
      }
    }

    res.json({
      success: true,
      nodeNum,
      isFavorite,
      deviceSync: {
        status: deviceSyncStatus,
        error: deviceSyncError,
      },
    });
  } catch (error) {
    logger.error('Error setting node favorite:', error);
    const errorResponse: ApiErrorResponse = {
      error: 'Failed to set node favorite',
      code: 'INTERNAL_ERROR',
      details: error instanceof Error ? error.message : 'Unknown error occurred',
    };
    res.status(500).json(errorResponse);
  }
});

// Toggle favorite lock status (lock/unlock a node from auto-favorite automation)
router.post('/nodes/:nodeId/favorite-lock', requirePermission('nodes', 'write', { sourceIdFrom: 'body' }), async (req, res) => {
  try {
    const { nodeId } = req.params;
    const { locked, sourceId: lockSourceId } = req.body;

    if (typeof locked !== 'boolean') {
      const errorResponse: ApiErrorResponse = {
        error: 'locked must be a boolean',
        code: 'INVALID_PARAMETER_TYPE',
        details: 'Expected boolean value for locked parameter',
      };
      res.status(400).json(errorResponse);
      return;
    }

    if (typeof lockSourceId !== 'string' || lockSourceId.length === 0) {
      const errorResponse: ApiErrorResponse = {
        error: 'sourceId is required',
        code: 'MISSING_SOURCE_ID',
        details: 'Request body must include a sourceId string',
      };
      res.status(400).json(errorResponse);
      return;
    }

    // Convert nodeId (hex string like !a1b2c3d4) to nodeNum (integer)
    const nodeNumStr = nodeId.replace('!', '');

    if (!/^[0-9a-fA-F]{8}$/.test(nodeNumStr)) {
      const errorResponse: ApiErrorResponse = {
        error: 'Invalid nodeId format',
        code: 'INVALID_NODE_ID',
        details: 'nodeId must be in format !XXXXXXXX (8 hex characters)',
      };
      res.status(400).json(errorResponse);
      return;
    }

    const nodeNum = parseInt(nodeNumStr, 16);

    await databaseService.nodes.setNodeFavoriteLocked(nodeNum, locked, lockSourceId);

    // If unlocking, also add to the per-source auto-favorite tracking list if the node is
    // currently favorited on this source, so automation on this source can manage it going
    // forward. Must read/write the per-source key that the sweep actually consults.
    if (!locked) {
      const node = await databaseService.nodes.getNode(nodeNum, lockSourceId);
      if (node?.isFavorite) {
        const autoFavoriteNodesJson = await databaseService.settings.getSettingForSource(lockSourceId, 'autoFavoriteNodes') || '[]';
        const autoFavoriteNodes: number[] = JSON.parse(autoFavoriteNodesJson);
        if (!autoFavoriteNodes.includes(nodeNum)) {
          autoFavoriteNodes.push(nodeNum);
          await databaseService.settings.setSourceSetting(lockSourceId, 'autoFavoriteNodes', JSON.stringify(autoFavoriteNodes));
        }
      }
    }

    logger.debug(`${locked ? '🔒' : '🔓'} Node ${nodeNum} favorite lock set to: ${locked}`);

    res.json({
      success: true,
      nodeNum,
      locked,
    });
  } catch (error) {
    logger.error('Error setting node favorite lock:', error);
    const errorResponse: ApiErrorResponse = {
      error: 'Failed to set node favorite lock',
      code: 'INTERNAL_ERROR',
      details: error instanceof Error ? error.message : 'Unknown error occurred',
    };
    res.status(500).json(errorResponse);
  }
});

// Get auto-favorite status (local role, firmware, managed nodes)
router.get('/auto-favorite/status', requirePermission('nodes', 'read'), async (req, res) => {
  try {
    const afSourceId = req.query.sourceId as string | undefined;
    const afManager = resolveSourceManager(afSourceId);
    // Prefer the manager's in-memory local node (populated at connect time). This avoids
    // the legacy global 'localNodeNum' settings key, which is clobbered across sources.
    const localNodeNumInt = afManager.getLocalNodeInfo()?.nodeNum;
    const localNode = localNodeNumInt ? await databaseService.nodes.getNode(localNodeNumInt, afManager.sourceId) : null;
    const firmwareVersion = afManager.getLocalNodeInfo()?.firmwareVersion || null;
    const supportsFavorites = afManager.supportsFavorites();

    // Read the per-source tracking list (manager writes via setSourceSetting on
    // the same key — global getSetting would return stale/empty data here).
    const autoFavoriteNodesJson = await databaseService.settings.getSettingForSource(afManager.sourceId, 'autoFavoriteNodes') || '[]';
    const autoFavoriteNodeNums: number[] = JSON.parse(autoFavoriteNodesJson);

    // Get node details for each auto-favorited node (scoped to this source)
    const autoFavoriteNodes = (await Promise.all(autoFavoriteNodeNums
      .map(async nodeNum => {
        const node = await databaseService.nodes.getNode(nodeNum, afManager.sourceId);
        if (!node) return null;
        return {
          nodeNum: node.nodeNum,
          nodeId: node.nodeId,
          longName: node.longName,
          shortName: node.shortName,
          role: node.role,
          hopsAway: node.hopsAway,
          lastHeard: node.lastHeard,
          favoriteLocked: Boolean(node.favoriteLocked),
        };
      })))
      .filter(Boolean);

    res.json({
      localNodeRole: localNode?.role ?? null,
      firmwareVersion,
      supportsFavorites,
      autoFavoriteNodes,
    });
  } catch (error) {
    logger.error('Error fetching auto-favorite status:', error);
    const errorResponse: ApiErrorResponse = {
      error: 'Failed to fetch auto-favorite status',
      code: 'INTERNAL_ERROR',
      details: error instanceof Error ? error.message : 'Unknown error occurred',
    };
    res.status(500).json(errorResponse);
  }
});

// Set node ignored status (with optional device sync)
router.post('/nodes/:nodeId/ignored', requirePermission('nodes', 'write', { sourceIdFrom: 'body' }), async (req, res) => {
  try {
    const { nodeId } = req.params;
    const { isIgnored, syncToDevice = true, destinationNodeNum } = req.body;

    if (typeof isIgnored !== 'boolean') {
      const errorResponse: ApiErrorResponse = {
        error: 'isIgnored must be a boolean',
        code: 'INVALID_PARAMETER_TYPE',
        details: 'Expected boolean value for isIgnored parameter',
      };
      res.status(400).json(errorResponse);
      return;
    }

    // Per-source blocklist: accept sourceId from body, else fall back to the
    // first source this caller has nodes:write on.
    const ignoreSourceId = await resolveRequestSourceId(req, 'nodes', 'write');
    if (!ignoreSourceId) {
      const errorResponse: ApiErrorResponse = {
        error: 'No permitted source',
        code: 'MISSING_SOURCE_ID',
        details: 'Provide a sourceId, or ensure your account has nodes:write on at least one enabled source',
      };
      res.status(400).json(errorResponse);
      return;
    }

    // Convert nodeId (hex string like !a1b2c3d4) to nodeNum (integer)
    const nodeNumStr = nodeId.replace('!', '');

    // Validate hex string format (must be exactly 8 hex characters)
    if (!/^[0-9a-fA-F]{8}$/.test(nodeNumStr)) {
      const errorResponse: ApiErrorResponse = {
        error: 'Invalid nodeId format',
        code: 'INVALID_NODE_ID',
        details: 'nodeId must be in format !XXXXXXXX (8 hex characters)',
      };
      res.status(400).json(errorResponse);
      return;
    }

    const nodeNum = parseInt(nodeNumStr, 16);

    // Update ignored status in database
    await databaseService.setNodeIgnoredAsync(nodeNum, isIgnored, ignoreSourceId);

    // Phase 7: broadcast via the owning source manager's per-source virtual node.
    try {
      if (ignoreSourceId) {
        const mgr = sourceManagerRegistry.getManager(ignoreSourceId) as any;
        if (mgr && typeof mgr.broadcastNodeInfoUpdate === 'function') {
          await mgr.broadcastNodeInfoUpdate(nodeNum);
        }
      } else {
        for (const mgr of sourceManagerRegistry.getAllManagers() as any[]) {
          if (typeof mgr.broadcastNodeInfoUpdate === 'function') {
            await mgr.broadcastNodeInfoUpdate(nodeNum);
          }
        }
      }
    } catch (error) {
      logger.error(`⚠️ Failed to broadcast ignored update to virtual node clients for node ${nodeNum}:`, error);
    }

    // Sync to device if requested
    let deviceSyncStatus: 'success' | 'failed' | 'skipped' = 'skipped';
    let deviceSyncError: string | undefined;

    if (syncToDevice) {
      const ignoreManager = resolveSourceManager(ignoreSourceId);
      try {
        if (isIgnored) {
          await ignoreManager.sendIgnoredNode(nodeNum, destinationNodeNum);
        } else {
          await ignoreManager.sendRemoveIgnoredNode(nodeNum, destinationNodeNum);
        }
        deviceSyncStatus = 'success';
        logger.debug(`✅ Synced ignored status to device for node ${nodeNum}`);
      } catch (error) {
        // Special handling for firmware version incompatibility
        if (error instanceof Error && error.message === 'FIRMWARE_NOT_SUPPORTED') {
          deviceSyncStatus = 'skipped';
          logger.debug(
            `ℹ️ Device sync skipped for node ${nodeNum}: firmware does not support ignored nodes (requires >= 2.7.0)`
          );
          // Don't set deviceSyncError - this is expected behavior for pre-2.7 firmware
        } else {
          deviceSyncStatus = 'failed';
          deviceSyncError = error instanceof Error ? error.message : 'Unknown error';
          logger.error(`⚠️ Failed to sync ignored status to device for node ${nodeNum}:`, error);
        }
        // Don't fail the whole request if device sync fails
      }
    }

    res.json({
      success: true,
      nodeNum,
      isIgnored,
      deviceSync: {
        status: deviceSyncStatus,
        error: deviceSyncError,
      },
    });
  } catch (error) {
    logger.error('Error setting node ignored:', error);
    const errorResponse: ApiErrorResponse = {
      error: 'Failed to set node ignored',
      code: 'INTERNAL_ERROR',
      details: error instanceof Error ? error.message : 'Unknown error occurred',
    };
    res.status(500).json(errorResponse);
  }
});

// Get node position override
router.get('/nodes/:nodeId/position-override', optionalAuth(), requireSourceId('query'), async (req, res) => {
  try {
    const { nodeId } = req.params;

    // Check channel-based access for this node (source-scoped, #3745)
    if (!await checkNodeChannelAccess(nodeId, req.user, req.query.sourceId as string | undefined)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    // Convert nodeId (hex string like !a1b2c3d4) to nodeNum (integer)
    const nodeNumStr = nodeId.replace('!', '');

    // Validate hex string format (must be exactly 8 hex characters)
    if (!/^[0-9a-fA-F]{8}$/.test(nodeNumStr)) {
      const errorResponse: ApiErrorResponse = {
        error: 'Invalid nodeId format',
        code: 'INVALID_NODE_ID',
        details: 'nodeId must be in format !XXXXXXXX (8 hex characters)',
      };
      res.status(400).json(errorResponse);
      return;
    }

    const nodeNum = parseInt(nodeNumStr, 16);
    // sourceId presence validated by requireSourceId('query')
    const poGetSourceId = req.query.sourceId as string;
    const override = await databaseService.getNodePositionOverrideAsync(nodeNum, poGetSourceId);

    if (!override) {
      const errorResponse: ApiErrorResponse = {
        error: 'Node not found',
        code: 'NODE_NOT_FOUND',
        details: `Node ${nodeId} not found in database`,
      };
      res.status(404).json(errorResponse);
      return;
    }

    // CRITICAL: Mask coordinates for private overrides if user lacks permission
    const canViewPrivate = !!req.user && await hasPermission(req.user, 'nodes_private', 'read');
    if (override.isPrivate && !canViewPrivate) {
      const masked = { ...override };
      delete masked.latitude;
      delete masked.longitude;
      delete masked.altitude;
      res.json(masked);
      return;
    }

    res.json(override);
  } catch (error) {
    logger.error('Error getting node position override:', error);
    const errorResponse: ApiErrorResponse = {
      error: 'Failed to get node position override',
      code: 'INTERNAL_ERROR',
      details: error instanceof Error ? error.message : 'Unknown error occurred',
    };
    res.status(500).json(errorResponse);
  }
});

// Set node position override
router.post('/nodes/:nodeId/position-override', requirePermission('nodes', 'write', { sourceIdFrom: 'body' }), async (req, res) => {
  try {
    const { nodeId } = req.params;
    const { enabled, latitude, longitude, altitude, isPrivate, sourceId: poSourceId } = req.body;

    if (typeof poSourceId !== 'string' || poSourceId.length === 0) {
      const errorResponse: ApiErrorResponse = {
        error: 'sourceId is required',
        code: 'MISSING_SOURCE_ID',
        details: 'Request body must include a sourceId string',
      };
      res.status(400).json(errorResponse);
      return;
    }

    // Validate enabled parameter
    if (typeof enabled !== 'boolean') {
      const errorResponse: ApiErrorResponse = {
        error: 'enabled must be a boolean',
        code: 'INVALID_PARAMETER_TYPE',
        details: 'Expected boolean value for enabled parameter',
      };
      res.status(400).json(errorResponse);
      return;
    }

    // Validate isPrivate parameter if provided
    if (isPrivate !== undefined && typeof isPrivate !== 'boolean') {
      const errorResponse: ApiErrorResponse = {
        error: 'isPrivate must be a boolean',
        code: 'INVALID_PARAMETER_TYPE',
        details: 'Expected boolean value for isPrivate parameter',
      };
      res.status(400).json(errorResponse);
      return;
    }

    // Validate coordinates if enabled
    if (enabled) {
      if (typeof latitude !== 'number' || latitude < -90 || latitude > 90) {
        const errorResponse: ApiErrorResponse = {
          error: 'Invalid latitude',
          code: 'INVALID_LATITUDE',
          details: 'Latitude must be a number between -90 and 90',
        };
        res.status(400).json(errorResponse);
        return;
      }

      if (typeof longitude !== 'number' || longitude < -180 || longitude > 180) {
        const errorResponse: ApiErrorResponse = {
          error: 'Invalid longitude',
          code: 'INVALID_LONGITUDE',
          details: 'Longitude must be a number between -180 and 180',
        };
        res.status(400).json(errorResponse);
        return;
      }

      if (altitude !== undefined && typeof altitude !== 'number') {
        const errorResponse: ApiErrorResponse = {
          error: 'Invalid altitude',
          code: 'INVALID_ALTITUDE',
          details: 'Altitude must be a number',
        };
        res.status(400).json(errorResponse);
        return;
      }
    }

    // Convert nodeId (hex string like !a1b2c3d4) to nodeNum (integer)
    const nodeNumStr = nodeId.replace('!', '');

    // Validate hex string format (must be exactly 8 hex characters)
    if (!/^[0-9a-fA-F]{8}$/.test(nodeNumStr)) {
      const errorResponse: ApiErrorResponse = {
        error: 'Invalid nodeId format',
        code: 'INVALID_NODE_ID',
        details: 'nodeId must be in format !XXXXXXXX (8 hex characters)',
      };
      res.status(400).json(errorResponse);
      return;
    }

    const nodeNum = parseInt(nodeNumStr, 16);

    // Set position override in database
    await databaseService.setNodePositionOverrideAsync(
      nodeNum,
      enabled,
      poSourceId,
      enabled ? latitude : undefined,
      enabled ? longitude : undefined,
      enabled ? altitude : undefined,
      enabled ? isPrivate : undefined
    );

    res.json({
      success: true,
      nodeNum,
      enabled,
      latitude: enabled ? latitude : null,
      longitude: enabled ? longitude : null,
      altitude: enabled ? altitude : null,
      isPrivate: enabled ? isPrivate : false,
    });
  } catch (error) {
    logger.error('Error setting node position override:', error);
    const errorResponse: ApiErrorResponse = {
      error: 'Failed to set node position override',
      code: 'INTERNAL_ERROR',
      details: error instanceof Error ? error.message : 'Unknown error occurred',
    };
    res.status(500).json(errorResponse);
  }
});

// Delete node position override
router.delete('/nodes/:nodeId/position-override', requirePermission('nodes', 'write', { sourceIdFrom: 'query' }), async (req, res) => {
  try {
    const { nodeId } = req.params;
    const poDelSourceId = req.query.sourceId as string | undefined;

    if (typeof poDelSourceId !== 'string' || poDelSourceId.length === 0) {
      const errorResponse: ApiErrorResponse = {
        error: 'sourceId is required',
        code: 'MISSING_SOURCE_ID',
        details: 'Request must include sourceId as a query parameter',
      };
      res.status(400).json(errorResponse);
      return;
    }

    // Convert nodeId (hex string like !a1b2c3d4) to nodeNum (integer)
    const nodeNumStr = nodeId.replace('!', '');

    // Validate hex string format (must be exactly 8 hex characters)
    if (!/^[0-9a-fA-F]{8}$/.test(nodeNumStr)) {
      const errorResponse: ApiErrorResponse = {
        error: 'Invalid nodeId format',
        code: 'INVALID_NODE_ID',
        details: 'nodeId must be in format !XXXXXXXX (8 hex characters)',
      };
      res.status(400).json(errorResponse);
      return;
    }

    const nodeNum = parseInt(nodeNumStr, 16);

    // Clear position override in database
    await databaseService.clearNodePositionOverrideAsync(nodeNum, poDelSourceId);

    res.json({
      success: true,
      nodeNum,
      message: 'Position override cleared',
    });
  } catch (error) {
    logger.error('Error clearing node position override:', error);
    const errorResponse: ApiErrorResponse = {
      error: 'Failed to clear node position override',
      code: 'INTERNAL_ERROR',
      details: error instanceof Error ? error.message : 'Unknown error occurred',
    };
    res.status(500).json(errorResponse);
  }
});

// Set the per-node "Hide from Map" toggle (issue #3549). Display-only: suppresses
// the node's marker on every map view while leaving it visible everywhere else.
router.post('/nodes/:nodeId/hide-from-map', requirePermission('nodes', 'write', { sourceIdFrom: 'body' }), async (req, res) => {
  try {
    const { nodeId } = req.params;
    const { hideFromMap, sourceId: hfmSourceId, allSources } = req.body;

    if (typeof hideFromMap !== 'boolean') {
      const errorResponse: ApiErrorResponse = {
        error: 'hideFromMap must be a boolean',
        code: 'INVALID_PARAMETER_TYPE',
        details: 'Expected boolean value for hideFromMap parameter',
      };
      res.status(400).json(errorResponse);
      return;
    }

    // `allSources` is optional, but if present it must be a real boolean —
    // otherwise a stray `"true"` string would silently fall through to the
    // per-source path (the branch below tests `=== true`). Reject the
    // ambiguity rather than guess.
    if (allSources !== undefined && typeof allSources !== 'boolean') {
      const errorResponse: ApiErrorResponse = {
        error: 'allSources must be a boolean',
        code: 'INVALID_PARAMETER_TYPE',
        details: 'Expected boolean value for optional allSources parameter',
      };
      res.status(400).json(errorResponse);
      return;
    }

    if (typeof hfmSourceId !== 'string' || hfmSourceId.length === 0) {
      const errorResponse: ApiErrorResponse = {
        error: 'sourceId is required',
        code: 'MISSING_SOURCE_ID',
        details: 'Request body must include a sourceId string',
      };
      res.status(400).json(errorResponse);
      return;
    }

    // Convert nodeId (hex string like !a1b2c3d4) to nodeNum (integer)
    const nodeNumStr = nodeId.replace('!', '');

    // Validate hex string format (must be exactly 8 hex characters)
    if (!/^[0-9a-fA-F]{8}$/.test(nodeNumStr)) {
      const errorResponse: ApiErrorResponse = {
        error: 'Invalid nodeId format',
        code: 'INVALID_NODE_ID',
        details: 'nodeId must be in format !XXXXXXXX (8 hex characters)',
      };
      res.status(400).json(errorResponse);
      return;
    }

    const nodeNum = parseInt(nodeNumStr, 16);

    // #4137: unified/cross-source views toggle the logical node, not one
    // source's row. hideFromMap is map-visibility metadata (not a
    // security-sensitive field), so requiring write permission on the
    // request's anchor sourceId is a sufficient permission check even
    // though the write fans out to every source's row for this nodeNum —
    // sourceId above remains required and stays the RBAC anchor either way.
    if (allSources === true) {
      await databaseService.setNodeHideFromMapAllSourcesAsync(nodeNum, hideFromMap);
    } else {
      await databaseService.setNodeHideFromMapAsync(nodeNum, hideFromMap, hfmSourceId);
    }

    res.json({
      success: true,
      nodeNum,
      hideFromMap,
    });
  } catch (error) {
    logger.error('Error setting node hideFromMap:', error);
    const errorResponse: ApiErrorResponse = {
      error: 'Failed to set node hideFromMap',
      code: 'INTERNAL_ERROR',
      details: error instanceof Error ? error.message : 'Unknown error occurred',
    };
    res.status(500).json(errorResponse);
  }
});

// Set the free-text per-node notes annotation (issue #3921). MeshMonitor-local
// only — never synced to the mesh. An empty string clears the note.
const MAX_NODE_NOTES_LENGTH = 2000;
router.post('/nodes/:nodeId/notes', requirePermission('nodes', 'write', { sourceIdFrom: 'body' }), async (req, res) => {
  try {
    const { nodeId } = req.params;
    const { notes, sourceId: notesSourceId } = req.body;

    if (typeof notes !== 'string') {
      const errorResponse: ApiErrorResponse = {
        error: 'notes must be a string',
        code: 'INVALID_PARAMETER_TYPE',
        details: 'Expected string value for notes parameter',
      };
      res.status(400).json(errorResponse);
      return;
    }

    if (notes.length > MAX_NODE_NOTES_LENGTH) {
      const errorResponse: ApiErrorResponse = {
        error: 'notes is too long',
        code: 'INVALID_PARAMETER',
        details: `notes must be at most ${MAX_NODE_NOTES_LENGTH} characters`,
      };
      res.status(400).json(errorResponse);
      return;
    }

    if (typeof notesSourceId !== 'string' || notesSourceId.length === 0) {
      const errorResponse: ApiErrorResponse = {
        error: 'sourceId is required',
        code: 'MISSING_SOURCE_ID',
        details: 'Request body must include a sourceId string',
      };
      res.status(400).json(errorResponse);
      return;
    }

    // Convert nodeId (hex string like !a1b2c3d4) to nodeNum (integer)
    const nodeNumStr = nodeId.replace('!', '');

    // Validate hex string format (must be exactly 8 hex characters)
    if (!/^[0-9a-fA-F]{8}$/.test(nodeNumStr)) {
      const errorResponse: ApiErrorResponse = {
        error: 'Invalid nodeId format',
        code: 'INVALID_NODE_ID',
        details: 'nodeId must be in format !XXXXXXXX (8 hex characters)',
      };
      res.status(400).json(errorResponse);
      return;
    }

    const nodeNum = parseInt(nodeNumStr, 16);

    await databaseService.setNodeNotesAsync(nodeNum, notes, notesSourceId);

    res.json({
      success: true,
      nodeNum,
      notes,
    });
  } catch (error) {
    logger.error('Error setting node notes:', error);
    const errorResponse: ApiErrorResponse = {
      error: 'Failed to set node notes',
      code: 'INTERNAL_ERROR',
      details: error instanceof Error ? error.message : 'Unknown error occurred',
    };
    res.status(500).json(errorResponse);
  }
});

// Delete neighbor info for a node
router.delete('/nodes/:nodeId/neighbors', requirePermission('nodes', 'write', { sourceIdFrom: 'query', requireSourceId: true }), async (req, res) => {
  try {
    const { nodeId } = req.params;

    // Convert nodeId (hex string like !a1b2c3d4) to nodeNum (integer)
    const nodeNumStr = nodeId.replace('!', '');

    // Validate hex string format (must be exactly 8 hex characters)
    if (!/^[0-9a-fA-F]{8}$/.test(nodeNumStr)) {
      const errorResponse: ApiErrorResponse = {
        error: 'Invalid nodeId format',
        code: 'INVALID_NODE_ID',
        details: 'nodeId must be in format !XXXXXXXX (8 hex characters)',
      };
      res.status(400).json(errorResponse);
      return;
    }

    const nodeNum = parseInt(nodeNumStr, 16);

    // Delete neighbor info from database (scoped to the required source;
    // requireSourceId already validated presence + string type)
    const deletedCount = await databaseService.deleteNeighborInfoForNodeAsync(nodeNum, req.query.sourceId as string);

    res.json({
      success: true,
      nodeNum,
      deletedCount,
      message: `Deleted ${deletedCount} neighbor records`,
    });
  } catch (error) {
    logger.error('Error deleting neighbor info:', error);
    const errorResponse: ApiErrorResponse = {
      error: 'Failed to delete neighbor info',
      code: 'INTERNAL_ERROR',
      details: error instanceof Error ? error.message : 'Unknown error occurred',
    };
    res.status(500).json(errorResponse);
  }
});

// Manually scan a node for remote admin capability
router.post('/nodes/:nodeNum/scan-remote-admin', requirePermission('settings', 'write'), async (req, res) => {
  try {
    const { nodeNum } = req.params;
    const parsedNodeNum = parseInt(nodeNum, 10);

    if (isNaN(parsedNodeNum)) {
      const errorResponse: ApiErrorResponse = {
        error: 'Invalid nodeNum format',
        code: 'INVALID_NODE_NUM',
        details: 'nodeNum must be a valid integer',
      };
      res.status(400).json(errorResponse);
      return;
    }

    const { sourceId: bodySourceId } = (req.body || {}) as { sourceId?: string };
    const querySourceId = typeof req.query.sourceId === 'string' && req.query.sourceId
      ? (req.query.sourceId as string)
      : undefined;
    const scanSourceId = querySourceId ?? bodySourceId;
    const scanManager = (resolveSourceManager(scanSourceId));

    // Check if the node exists on the scoped source (same nodeNum may exist
    // on other sources that aren't the scan target).
    const node = await databaseService.nodes.getNode(parsedNodeNum, scanSourceId);
    if (!node) {
      const errorResponse: ApiErrorResponse = {
        error: 'Node not found',
        code: 'NODE_NOT_FOUND',
        details: `No node found with nodeNum ${parsedNodeNum}`,
      };
      res.status(404).json(errorResponse);
      return;
    }

    logger.debug(`Manual remote admin scan requested for node ${parsedNodeNum}`);

    // Perform the scan
    const result = await scanManager.scanNodeForRemoteAdmin(parsedNodeNum);

    res.json({
      success: true,
      nodeNum: parsedNodeNum,
      hasRemoteAdmin: result.hasRemoteAdmin,
      metadata: result.metadata,
    });
  } catch (error) {
    logger.error('Error scanning node for remote admin:', error);
    const errorResponse: ApiErrorResponse = {
      error: 'Failed to scan node for remote admin',
      code: 'INTERNAL_ERROR',
      details: error instanceof Error ? error.message : 'Unknown error occurred',
    };
    res.status(500).json(errorResponse);
  }
});

// Send key security warning DM to a specific node
router.post('/nodes/:nodeId/send-key-warning', requirePermission('messages', 'write'), async (req, res) => {
  try {
    const { nodeId } = req.params;

    // Convert nodeId (hex string like !a1b2c3d4) to nodeNum (integer)
    const nodeNumStr = nodeId.replace('!', '');

    // Validate hex string format
    if (!/^[0-9a-fA-F]{8}$/.test(nodeNumStr)) {
      const errorResponse: ApiErrorResponse = {
        error: 'Invalid nodeId format',
        code: 'INVALID_NODE_ID',
        details: 'nodeId must be in format !XXXXXXXX (8 hex characters)',
      };
      res.status(400).json(errorResponse);
      return;
    }

    const nodeNum = parseInt(nodeNumStr, 16);

    const { sourceId: warnSourceId } = req.body || {};
    const warnManager = resolveSourceManager(warnSourceId);

    // Verify the node actually has a security issue on the target source
    // (security flags are per-source — the same nodeNum may be safe on another source).
    const node = await databaseService.nodes.getNode(nodeNum, warnSourceId);
    if (!node) {
      const errorResponse: ApiErrorResponse = {
        error: 'Node not found',
        code: 'NODE_NOT_FOUND',
        details: `No node found with ID ${nodeId}`,
      };
      res.status(404).json(errorResponse);
      return;
    }

    if (!node.keyIsLowEntropy && !node.duplicateKeyDetected) {
      const errorResponse: ApiErrorResponse = {
        error: 'Node has no security issues',
        code: 'NO_SECURITY_ISSUE',
        details: 'This node does not have any detected key security issues',
      };
      res.status(400).json(errorResponse);
      return;
    }

    // Send warning message on gauntlet channel
    const warningMessage = `⚠️ SECURITY WARNING: Your encryption key has been identified as compromised (${
      node.keyIsLowEntropy ? 'low-entropy' : 'duplicate'
    }). Your direct messages may not be private. Please regenerate your key in Settings > Security.`;
    const messageId = await warnManager.sendTextMessage(
      warningMessage,
      0, // Channel 0
      nodeNum // Destination
    );

    logger.debug(`🔐 Sent key security warning to node ${nodeId} (${node.longName || 'Unknown'})`);

    res.json({
      success: true,
      nodeNum,
      nodeId,
      messageId,
      messageSent: warningMessage,
    });
  } catch (error) {
    logger.error('Error sending key warning:', error);
    const errorResponse: ApiErrorResponse = {
      error: 'Failed to send key warning',
      code: 'INTERNAL_ERROR',
      details: error instanceof Error ? error.message : 'Unknown error occurred',
    };
    res.status(500).json(errorResponse);
  }
});

// Scan all nodes for duplicate keys and update database
router.post('/nodes/scan-duplicate-keys', requirePermission('nodes', 'write'), async (_req, res) => {
  try {
    // Duplicate detection is scoped per-source — a node on source A sharing a
    // public key with a node on source B is NOT treated as a duplicate, because
    // they may legitimately be the same physical device surfaced by two
    // transports. This matches the background scheduler in
    // duplicateKeySchedulerService which also iterates per-source, and the
    // updateNodeSecurityFlags helper requires a sourceId for correctness under
    // the composite (nodeNum, sourceId) primary key.
    const { detectDuplicateKeys } = await import('../../services/lowEntropyKeyService.js');

    // Duplicate key detection is Meshtastic-only — MeshCore nodes don't use the
    // shared `nodes` table and have no Meshtastic PKI model to scan.
    const managers = sourceManagerRegistry.getAllManagers().filter(m => m.sourceType !== 'meshcore');
    const sourceIds: string[] = managers.length > 0 ? managers.map(m => m.sourceId) : ['default'];

    let totalScanned = 0;
    let totalDuplicateGroups = 0;
    const affectedNodes: number[] = [];

    for (const sourceId of sourceIds) {
      const nodesWithKeys = await databaseService.nodes.getNodesWithPublicKeys(sourceId);
      totalScanned += nodesWithKeys.length;

      const allSourceNodes = await databaseService.nodes.getAllNodes(sourceId);

      // Clear existing duplicate flags for this source
      for (const node of allSourceNodes) {
        if (node.duplicateKeyDetected) {
          const details = node.keyIsLowEntropy ? 'Known low-entropy key detected' : undefined;
          await databaseService.nodes.updateNodeSecurityFlags(
            Number(node.nodeNum),
            false,
            details,
            sourceId,
          );
        }
      }

      const duplicates = detectDuplicateKeys(nodesWithKeys);
      totalDuplicateGroups += duplicates.size;

      const sourceNodeMap = new Map<number, typeof allSourceNodes[0]>(
        allSourceNodes.map(n => [Number(n.nodeNum), n])
      );

      for (const [keyHash, nodeNums] of duplicates) {
        for (const nodeNum of nodeNums) {
          const node = sourceNodeMap.get(Number(nodeNum));
          if (!node) continue;

          const otherNodes = nodeNums.filter(n => n !== nodeNum);
          const details = node.keyIsLowEntropy
            ? `Known low-entropy key; Key shared with nodes: ${otherNodes.join(', ')}`
            : `Key shared with nodes: ${otherNodes.join(', ')}`;

          await databaseService.nodes.updateNodeSecurityFlags(
            Number(nodeNum),
            true,
            details,
            sourceId,
          );
          affectedNodes.push(Number(nodeNum));
        }
        logger.debug(`🔐 [${sourceId}] Detected ${nodeNums.length} nodes sharing key hash ${keyHash.substring(0, 16)}...`);
      }
    }

    res.json({
      success: true,
      duplicatesFound: totalDuplicateGroups,
      affectedNodes,
      totalNodesScanned: totalScanned,
    });
  } catch (error) {
    logger.error('Error scanning for duplicate keys:', error);
    const errorResponse: ApiErrorResponse = {
      error: 'Failed to scan for duplicate keys',
      code: 'INTERNAL_ERROR',
      details: error instanceof Error ? error.message : 'Unknown error occurred',
    };
    res.status(500).json(errorResponse);
  }
});

// Device configuration endpoint
// ==========================================
// Refresh nodes from device endpoint
router.post('/nodes/refresh', requirePermission('nodes', 'write'), async (req, res) => {
  try {
    logger.debug('🔄 Manual node database refresh requested...');

    const { sourceId: refreshSourceId } = req.body || {};
    const refreshManager = (resolveSourceManager(refreshSourceId));
    // Trigger full node database refresh
    await refreshManager.refreshNodeDatabase();

    const nodeCount = await databaseService.nodes.getNodeCount(
      typeof refreshSourceId === 'string' && refreshSourceId.length > 0 ? refreshSourceId : ALL_SOURCES,
    );
    const channelCount = await databaseService.channels.getChannelCount(
      typeof refreshSourceId === 'string' && refreshSourceId.length > 0 ? refreshSourceId : ALL_SOURCES,
    );

    logger.debug(`✅ Node refresh complete: ${nodeCount} nodes, ${channelCount} channels`);

    res.json({
      success: true,
      nodeCount,
      channelCount,
      message: `Refreshed ${nodeCount} nodes and ${channelCount} channels`,
    });
  } catch (error) {
    logger.error('❌ Failed to refresh nodes:', error);
    res.status(500).json({
      error: 'Failed to refresh node database',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Settings endpoints

// Force-stop an active auto-ping session
router.post('/auto-ping/stop/:nodeNum', requirePermission('settings', 'write'), (req, res) => {
  try {
    const nodeNum = parseInt(req.params.nodeNum, 10);
    if (isNaN(nodeNum)) {
      return res.status(400).json({ error: 'Invalid node number.' });
    }
    const { sourceId: stopPingSourceId } = req.body || {};
    const stopPingManager = resolveSourceManager(stopPingSourceId);
    stopPingManager.stopAutoPingSession(nodeNum, 'force_stopped');
    res.json({ success: true });
  } catch (error) {
    logger.error('Error stopping auto-ping session:', error);
    res.status(500).json({ error: 'Failed to stop auto-ping session' });
  }
});

export default router;
