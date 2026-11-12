/**
 * Security Routes
 *
 * Routes for viewing security scan results and key management
 */

import { Router, Request, Response } from 'express';
import { requirePermission } from '../auth/authMiddleware.js';
import databaseService from '../../services/database.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { isMeshtasticManager } from '../sourceManagerTypes.js';
import type { MeshtasticManager } from '../meshtasticManager.js';
import { ok, fail } from '../utils/apiResponse.js';
import { extendRequestTimeout } from '../middleware/requestTimeout.js';
import { isAnyMeshCoreSourceType } from '../../utils/nodeTypeCategory.js';
import { nodeNumFromPubkey } from '../../utils/meshcoreNodeNum.js';
import { resolveSecurityDeadNodeDays } from '../constants/settings.js';
import { meshcoreOwnIdentityTracker } from '../services/meshcoreOwnIdentityTracker.js';
import {
  collisionCountsByWidth,
  findNameReuse,
  findPathHashCollisions,
  listSignatureFailures,
  loadMeshcoreSecurityNodes,
  type PathHashWidth,
} from '../services/meshcoreSecurityFindings.js';
import type { RemoveContactsBulkResult } from '../meshcoreManager.js';
import { requireSourceId } from '../utils/requireSourceId.js';
import { duplicateKeySchedulerService } from '../services/duplicateKeySchedulerService.js';
import { securityDigestService } from '../services/securityDigestService.js';
import { collectSecurityIssues } from '../services/securityIssuesService.js';
import { buildSecurityExport, type SecurityExportFormat } from '../utils/securityExport.js';
import { securityCapabilities } from '../../utils/securityCapabilities.js';
import meshcorePacketLogService from '../services/meshcorePacketLogService.js';
import { EXCESSIVE_PACKETS_PER_HOUR, TIME_OFFSET_THRESHOLD_MINUTES } from '../constants/securityThresholds.js';
import { logger } from '../../utils/logger.js';
import { SOURCE_NOT_CONNECTED_CODE } from '../../utils/sourceNotConnected.js';

const router = Router();

// All routes require security:read permission
router.use(requirePermission('security', 'read'));

// nodes:read on the source gates every per-source node read (both protocols).
const nodesReadOnSource = requirePermission('nodes', 'read', { sourceIdFrom: 'query', requireSourceId: true });

/** Protocol of a source for the shared reads: MeshCore (device or MQTT) or Meshtastic. */
function sourceProtocol(sourceId: string): 'meshcore' | 'meshtastic' {
  return isAnyMeshCoreSourceType(sourceManagerRegistry.getManager(sourceId)?.sourceType) ? 'meshcore' : 'meshtastic';
}

/**
 * No manager is registered for `sourceId`. A source that exists but is not
 * running (enabled, autoConnect off) answers 409 SOURCE_NOT_CONNECTED so the
 * page can say "not connected" instead of "unknown source" (#4173 review N5);
 * an id with no source row stays 400 SOURCE_NOT_FOUND. Every caller has
 * already passed its permission check for this source.
 */
async function failNoManager(res: Response, sourceId: string): Promise<Response> {
  const source = await databaseService.sources.getSource(sourceId);
  if (source) {
    return fail(res, 409, SOURCE_NOT_CONNECTED_CODE, `Source ${sourceId} is not connected`);
  }
  return fail(res, 400, 'SOURCE_NOT_FOUND', `Unknown sourceId: ${sourceId}`);
}

// Get all nodes with security issues. Wire fields are unchanged; nodeKey,
// protocol, counts, thresholds and (MeshCore) findings are additive.
router.get('/issues', requireSourceId('query'), nodesReadOnSource, async (req: Request, res: Response) => {
  try {
    const secSourceId = (req as unknown as { scopedSourceId: string }).scopedSourceId;
    const protocol = sourceProtocol(secSourceId);
    // Top broadcasters come from the stored rates on MeshCore, so this 30 s poll never reads the packet log.
    const issues = await collectSecurityIssues(databaseService as never, secSourceId, { protocol, topBroadcasters: 5 });
    if (protocol === 'meshcore') {
      // The notification DM needs the contact in the radio's table (the firmware looks the recipient up there).
      const contacts = new Map(
        ((sourceManagerRegistry.getManager(secSourceId) as unknown as MeshCoreSecurityManager | undefined)?.getContacts?.() ?? [])
          .map(c => [c.publicKey.toLowerCase(), c.onDevice === true] as const),
      );
      for (const n of issues.nodes) n.onDevice = contacts.get((n.publicKey ?? '').toLowerCase()) === true;
    }
    const packetLogEnabled = protocol === 'meshcore' ? await meshcorePacketLogService.isEnabled() : undefined;
    return res.json({
      ...issues,
      thresholds: { packetsPerHour: EXCESSIVE_PACKETS_PER_HOUR, timeOffsetMinutes: TIME_OFFSET_THRESHOLD_MINUTES },
      ...(packetLogEnabled !== undefined ? { packetLogEnabled } : {}),
    });
  } catch (error) {
    logger.error('Error getting security issues:', error);
    return fail(res, 500, 'INTERNAL_ERROR', 'Failed to get security issues');
  }
});

// Get scanner status. Accepts optional ?sourceId for single-source view;
// omitting it returns the full per-source map.
router.get('/scanner/status', (req: Request, res: Response) => {
  try {
    const sourceId = req.query.sourceId as string | undefined;
    const status = duplicateKeySchedulerService.getStatus(sourceId);
    return res.json(status);
  } catch (error) {
    logger.error('Error getting scanner status:', error);
    return res.status(500).json({ error: 'Failed to get scanner status' });
  }
});

// Trigger manual scan for a specific source. sourceId is required in the body
// and used both for permission scoping and scan targeting.
router.post(
  '/scanner/scan',
  requirePermission('security', 'write', { sourceIdFrom: 'body' }),
  requirePermission('nodes', 'read', { sourceIdFrom: 'body', requireSourceId: true }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = req.body?.sourceId;
      if (!sourceId || typeof sourceId !== 'string') {
        return res.status(400).json({ error: 'sourceId is required' });
      }

      // Require the source to be registered — no fallback to a default manager.
      const manager = sourceManagerRegistry.getManager(sourceId);
      if (!manager) {
        return failNoManager(res, sourceId);
      }
      const isMeshCore = isAnyMeshCoreSourceType(manager.sourceType);
      if (isMeshCore ? !securityCapabilities(manager.sourceType).scanner : !isMeshtasticManager(manager)) {
        return fail(res, 400, 'INVALID_SOURCE_TYPE', 'Security scan is not available for this source type');
      }

      const status = duplicateKeySchedulerService.getStatus(sourceId);
      if (status.scanningNow) {
        return fail(res, 409, 'SCAN_IN_PROGRESS', `A scan is already in progress for source ${sourceId}`);
      }

      void databaseService.auditLogAsync(
        req.user!.id,
        'security_scan_triggered',
        'security',
        `Manual security scan initiated for source ${sourceId}`,
        req.ip || null
      );

      duplicateKeySchedulerService.runScan(sourceId).catch(err => {
        logger.error(`Error during manual security scan for ${sourceId}:`, err);
      });

      return res.json({
        success: true,
        message: `Security scan initiated for source ${sourceId}`,
        sourceId,
      });
    } catch (error) {
      logger.error('Error triggering security scan:', error);
      return res.status(500).json({ error: 'Failed to trigger security scan' });
    }
  }
);

// Export security issues (both protocols; includes spam- and clock-only nodes)
router.get('/export', requireSourceId('query'), nodesReadOnSource, async (req: Request, res: Response) => {
  try {
    const format: SecurityExportFormat = req.query.format === 'json' ? 'json' : 'csv';
    const exportSourceId = (req as unknown as { scopedSourceId: string }).scopedSourceId;
    const protocol = sourceProtocol(exportSourceId);
    const issues = await collectSecurityIssues(databaseService as never, exportSourceId, { protocol, topBroadcasters: 5 });

    // Log the export action
    void databaseService.auditLogAsync(
      req.user!.id,
      'security_export',
      'security',
      `Security issues exported as ${format.toUpperCase()} for source ${exportSourceId}`,
      req.ip || null
    );

    const out = buildSecurityExport(issues, format);
    res.setHeader('Content-Type', out.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="security-scan-${Date.now()}.${out.extension}"`);
    return res.send(out.body);
  } catch (error) {
    logger.error('Error exporting security issues:', error);
    return fail(res, 500, 'INTERNAL_ERROR', 'Failed to export security issues');
  }
});

/**
 * Clear a Meshtastic node's security flags in one source. `includeSpam` also
 * resets the excessive-packet flag (the new `/nodes/clear` route); the legacy
 * `/nodes/:nodeNum/clear` alias keeps its old reach.
 */
async function clearMeshtasticNodeFlags(
  nodeNum: number,
  sourceId: string,
  includeSpam: boolean,
): Promise<{ nodeName: string } | null> {
  const node = await databaseService.nodes.getNode(nodeNum, sourceId);
  if (!node) return null;
  const nodeName = node.shortName || node.longName || `Node ${nodeNum}`;

  // Clear all security flags
  await databaseService.nodes.upsertNode({
    nodeNum,
    nodeId: node.nodeId,
    keyIsLowEntropy: false,
    duplicateKeyDetected: false,
    keyMismatchDetected: false,
    keySecurityIssueDetails: null, // null explicitly clears the field (undefined would preserve existing value)
  }, sourceId);

  // Clear time offset flags (scoped to the requested source per migration 029)
  await databaseService.updateNodeTimeOffsetFlagsAsync(nodeNum, false, null, sourceId);
  if (includeSpam) {
    await databaseService.updateNodeSpamFlagsAsync(nodeNum, false, 0, Math.floor(Date.now() / 1000), sourceId);
  }
  return { nodeName };
}

// Legacy alias: clear security issues for a Meshtastic node (requires write permission)
// `security` is a global resource, so the per-source gate is `nodes:read` on
// the body's source, the one the handler acts on — the same pair as
// POST /nodes/clear. Before, a caller who could not read that source cleared
// its node's flags (4.17.3 review L15).
router.post(
  '/nodes/:nodeNum/clear',
  requirePermission('security', 'write', { sourceIdFrom: 'body', requireSourceId: true }),
  requirePermission('nodes', 'read', { sourceIdFrom: 'body', requireSourceId: true }),
  async (req: Request, res: Response) => {
    try {
      const nodeNum = parseInt(req.params.nodeNum, 10);

      if (isNaN(nodeNum)) {
        return fail(res, 400, 'INVALID_NODE_NUM', 'Invalid node number');
      }

      // sourceId presence validated by requireSourceId('body'); scope the node
      // lookup + write so we clear/rewrite the correct source's row (not a
      // cross-source first match, and not the 'default' source).
      const clearSourceId = req.body.sourceId as string;
      const cleared = await clearMeshtasticNodeFlags(nodeNum, clearSourceId, false);
      if (!cleared) {
        return fail(res, 404, 'NOT_FOUND', 'Node not found');
      }
      const { nodeName } = cleared;

      // Log the action
      void databaseService.auditLogAsync(
        req.user!.id,
        'security_issues_cleared',
        'security',
        `Cleared security issues for ${nodeName} (${nodeNum})`,
        req.ip || null
      );

      logger.info(`🔐 Security issues cleared for ${nodeName} (${nodeNum}) by user ${req.user!.username}`);

      return res.json({
        success: true,
        message: `Security issues cleared for ${nodeName}`,
        nodeNum,
        nodeName
      });
    } catch (error) {
      logger.error('Error clearing security issues:', error);
      return fail(res, 500, 'INTERNAL_ERROR', 'Failed to clear security issues');
    }
  },
);

const MT_NODE_KEY_RE = /^mt:(\d{1,10})$/;
const MC_NODE_KEY_RE = /^mc:([0-9a-fA-F]{64})$/;

/**
 * POST /api/security/nodes/clear  { sourceId, nodeKey }
 * Clear the spam and clock-offset flags of one node on either protocol
 * (Meshtastic also clears its key flags). `nodeKey` is `mt:<num>` or `mc:<64-hex>`.
 */
router.post(
  '/nodes/clear',
  requirePermission('security', 'write', { sourceIdFrom: 'body', requireSourceId: true }),
  requirePermission('nodes', 'read', { sourceIdFrom: 'body', requireSourceId: true }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req as unknown as { scopedSourceId: string }).scopedSourceId;
      const nodeKey = req.body?.nodeKey;
      if (typeof nodeKey !== 'string') {
        return fail(res, 400, 'INVALID_NODE_KEY', 'nodeKey must be mt:<node number> or mc:<64-hex public key>');
      }
      const manager = sourceManagerRegistry.getManager(sourceId);
      if (!manager) {
        return failNoManager(res, sourceId);
      }
      const isMeshCore = isAnyMeshCoreSourceType(manager.sourceType);
      let name: string;
      if (isMeshCore) {
        const m = MC_NODE_KEY_RE.exec(nodeKey);
        if (!m) return fail(res, 400, 'INVALID_NODE_KEY', 'nodeKey must be mc:<64-hex public key> for a MeshCore source');
        const pk = m[1].toLowerCase();
        const existing = await databaseService.meshcore.getNodeByPublicKeyAndSource(pk, sourceId);
        if (!existing || !(await databaseService.meshcore.clearNodeSecurityFlags(sourceId, existing.publicKey, 'both'))) {
          return fail(res, 404, 'NODE_NOT_FOUND', 'Node not found');
        }
        name = existing.name || `mc:${pk.slice(0, 8)}`;
      } else {
        const m = MT_NODE_KEY_RE.exec(nodeKey);
        const nodeNum = m ? Number(m[1]) : NaN;
        if (!m || !Number.isInteger(nodeNum) || nodeNum > 0xffffffff) {
          return fail(res, 400, 'INVALID_NODE_KEY', 'nodeKey must be mt:<node number> for a Meshtastic source');
        }
        const cleared = await clearMeshtasticNodeFlags(nodeNum, sourceId, true);
        if (!cleared) return fail(res, 404, 'NODE_NOT_FOUND', 'Node not found');
        name = cleared.nodeName;
      }

      void databaseService.auditLogAsync(
        req.user!.id,
        'security_issues_cleared',
        'security',
        `Cleared security issues for ${name} (${nodeKey}) on source ${sourceId}`,
        req.ip || null
      );
      return ok(res, { nodeKey, nodeName: name });
    } catch (error) {
      logger.error('Error clearing security issues:', error);
      return fail(res, 500, 'INTERNAL_ERROR', 'Failed to clear security issues');
    }
  }
);

/**
 * GET /api/security/key-mismatches
 * Returns recent key mismatch events from the repair log
 */
router.get('/key-mismatches', requireSourceId('query'), nodesReadOnSource, async (req: Request, res: Response) => {
  try {
    // Scope to the requested source so the repair log doesn't leak events from
    // every source into one source's view (same class as the dead-nodes bug).
    const sourceId = req.query.sourceId as string | undefined;
    const log = await databaseService.getKeyRepairLogAsync(100, sourceId);

    // Filter to mismatch-related actions
    const mismatchActions = new Set(['mismatch', 'purge', 'fixed', 'exhausted']);
    const filtered = log.filter(entry => mismatchActions.has(entry.action));

    // Filter to last 7 days
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    const recent = filtered.filter(entry => entry.timestamp >= sevenDaysAgo);

    // Limit to 50 entries
    const limited = recent.slice(0, 50);

    res.json({
      success: true,
      count: limited.length,
      events: limited
    });
  } catch (error) {
    logger.error('Error fetching key mismatch history:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch key mismatch history' });
  }
});

const MAX_BULK_DELETE_KEYS = 1000;
/** Same budget as the contacts bulk remove (#5777): one serial write per contact. */
const BULK_DELETE_TIMEOUT_MS = 300_000;
const HEX64_RE = /^[0-9a-f]{64}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The slice of a MeshCore / MQTT-ingest manager the security routes read. */
interface MeshCoreSecurityManager {
  sourceId: string;
  sourceType: string;
  getLocalNode?: () => { publicKey?: string | null } | null;
  getContacts?: () => Array<{ publicKey: string; onDevice?: boolean; deviceFavorite?: boolean; isFavorite?: boolean }>;
  removeContactsBulk?: (keys: readonly string[]) => Promise<RemoveContactsBulkResult>;
  forgetLocalContact?: (publicKey: string) => Promise<boolean>;
}

/** Lowercase hex keys that mark the source's own identity (live radio + tracker baseline). */
async function localMeshcoreKeys(manager: MeshCoreSecurityManager): Promise<Set<string>> {
  const keys = new Set<string>();
  const live = manager.getLocalNode?.()?.publicKey;
  if (live) keys.add(live.toLowerCase());
  const tracked = await meshcoreOwnIdentityTracker.getCurrentKey(manager.sourceId);
  if (tracked) keys.add(tracked);
  return keys;
}

/**
 * GET /api/security/dead-nodes?sourceId=
 * Nodes not heard within the source's `securityDeadNodeDays` threshold
 * (defaults: Meshtastic 7, MeshCore 14). Never-heard nodes are included.
 */
router.get('/dead-nodes', requireSourceId('query'), requirePermission('nodes', 'read', { sourceIdFrom: 'query', requireSourceId: true }), async (req: Request, res: Response) => {
  try {
    const sourceId = (req as unknown as { scopedSourceId: string }).scopedSourceId;
    const manager = sourceManagerRegistry.getManager(sourceId);
    if (!manager) {
      return failNoManager(res, sourceId);
    }
    const isMeshCore = isAnyMeshCoreSourceType(manager.sourceType);
    if (!isMeshCore && !isMeshtasticManager(manager)) {
      return fail(res, 400, 'INVALID_SOURCE_TYPE', 'Dead-node detection is not available for this source type');
    }
    const thresholdDays = resolveSecurityDeadNodeDays(
      await databaseService.settings.getSettingForSource(sourceId, 'securityDeadNodeDays'),
      isMeshCore,
    );

    if (isMeshCore) {
      const mc = manager as unknown as MeshCoreSecurityManager;
      const cutoffMs = Date.now() - thresholdDays * DAY_MS;
      const [rows, ignored, local] = await Promise.all([
        databaseService.meshcore.getDeadNodes(sourceId, cutoffMs, { includeNeverHeard: true }),
        databaseService.meshcoreFilters.listIgnoredNodes(sourceId),
        localMeshcoreKeys(mc),
      ]);
      const ignoredKeys = new Set(ignored.map(i => i.publicKey.toLowerCase()));
      const contacts = new Map((mc.getContacts?.() ?? []).map(c => [c.publicKey.toLowerCase(), c]));
      const nodes = rows
        .filter(n => {
          const pk = n.publicKey.toLowerCase();
          if (local.has(pk) || ignoredKeys.has(pk)) return false;
          // Favourite in MeshMonitor or on the radio (decision 4).
          if (n.isFavorite === true) return false;
          const c = contacts.get(pk);
          return !(c?.deviceFavorite === true || c?.isFavorite === true);
        })
        .map(n => {
          const pk = n.publicKey.toLowerCase();
          return {
            nodeKey: `mc:${pk}`,
            protocol: 'meshcore' as const,
            publicKey: pk,
            nodeNum: nodeNumFromPubkey(pk),
            nodeId: pk,
            longName: n.name ?? null,
            shortName: n.name ?? null,
            hwModel: null,
            role: n.advType ?? null,
            // MeshCore stores ms; the DeadNode contract is always seconds.
            lastHeard: n.lastHeard ? Math.floor(Number(n.lastHeard) / 1000) : null,
            inDeviceDb: contacts.get(pk)?.onDevice === true,
            isFavorite: false,
          };
        });
      return res.json({ nodes, count: nodes.length, thresholdDays });
    }

    const mtManager = manager as MeshtasticManager;
    const cutoffSeconds = Math.floor(Date.now() / 1000) - thresholdDays * 24 * 60 * 60;
    // Scope to the requested source — otherwise the list leaks dead nodes from
    // every source into one source's view (issue: 2000+ dead nodes).
    const allNodes = await databaseService.nodes.getAllNodes(sourceId);
    const localNodeNum = parseInt(await databaseService.settings.getLocalNodeNumForSource(mtManager.sourceId) || '0');

    const deadNodes = allNodes
      .filter(node => {
        if (Number(node.nodeNum) === localNodeNum) return false;
        if (Number(node.nodeNum) === 0xFFFFFFFF) return false;
        if (node.isIgnored) return false;
        if (!node.lastHeard) return true;
        return Number(node.lastHeard) < cutoffSeconds;
      })
      .map(node => ({
        nodeKey: `mt:${Number(node.nodeNum)}`,
        protocol: 'meshtastic' as const,
        nodeNum: Number(node.nodeNum),
        nodeId: node.nodeId,
        longName: node.longName,
        shortName: node.shortName,
        hwModel: node.hwModel,
        lastHeard: node.lastHeard ? Number(node.lastHeard) : null,
        inDeviceDb: mtManager.isNodeInDeviceDb(Number(node.nodeNum)),
      }))
      .sort((a, b) => (a.lastHeard ?? 0) - (b.lastHeard ?? 0)); // Oldest first

    res.json({ nodes: deadNodes, count: deadNodes.length, thresholdDays });
  } catch (error) {
    logger.error('Error fetching dead nodes:', error);
    res.status(500).json({ error: 'Failed to fetch dead nodes' });
  }
});

type BulkDeleteResult = {
  nodeKey: string;
  nodeNum?: number;
  deleted: boolean;
  removedFromDevice: boolean;
  error?: string;
};

/**
 * POST /api/security/dead-nodes/bulk-delete  { sourceId, nodeKeys?, nodeNums? }
 * Needs `security:write` AND `nodes:write` on the source (both protocols).
 * Meshtastic: local DB + device NodeDB. MeshCore Companion: radio + DB;
 * Repeater / disconnected / meshcore_mqtt: DB only. Sends nothing over RF.
 */
router.post(
  '/dead-nodes/bulk-delete',
  extendRequestTimeout(BULK_DELETE_TIMEOUT_MS),
  requirePermission('security', 'write', { sourceIdFrom: 'body', requireSourceId: true }),
  requirePermission('nodes', 'write', { sourceIdFrom: 'body', requireSourceId: true }),
  async (req: Request, res: Response) => {
    try {
      const { nodeKeys, nodeNums, sourceId } = req.body ?? {};
      const user = (req as any).user;
      if (typeof sourceId !== 'string' || !sourceId) {
        return fail(res, 400, 'MISSING_SOURCE_ID', 'sourceId is required');
      }
      const manager = sourceManagerRegistry.getManager(sourceId);
      if (!manager) {
        return failNoManager(res, sourceId);
      }
      const isMeshCore = isAnyMeshCoreSourceType(manager.sourceType);
      if (!isMeshCore && !isMeshtasticManager(manager)) {
        return fail(res, 400, 'INVALID_SOURCE_TYPE', 'Dead-node cleanup is not available for this source type');
      }

      const rawKeys: unknown[] = [
        ...(Array.isArray(nodeKeys) ? nodeKeys : []),
        ...(Array.isArray(nodeNums) ? nodeNums.map(n => (isMeshCore ? n : `mt:${n}`)) : []),
      ];
      if ((nodeKeys !== undefined && !Array.isArray(nodeKeys)) || (nodeNums !== undefined && !Array.isArray(nodeNums)) || rawKeys.length === 0) {
        return fail(res, 400, 'INVALID_NODE_KEYS', 'nodeKeys (or nodeNums) must be a non-empty array');
      }
      if (rawKeys.length > MAX_BULK_DELETE_KEYS) {
        return fail(res, 400, 'TOO_MANY_KEYS', `At most ${MAX_BULK_DELETE_KEYS} nodes per request`);
      }

      const results: BulkDeleteResult[] = [];

      if (isMeshCore) {
        const mc = manager as unknown as MeshCoreSecurityManager;
        const keys: string[] = [];
        for (const raw of rawKeys) {
          const pk = typeof raw === 'string' && raw.startsWith('mc:') ? raw.slice(3).toLowerCase() : null;
          if (!pk || !HEX64_RE.test(pk)) {
            return fail(res, 400, 'INVALID_NODE_KEY', 'Each node key must be mc:<64-hex public key>');
          }
          if (!keys.includes(pk)) keys.push(pk);
        }

        // Never delete the radio's own identity or a favourite, even if asked.
        const local = await localMeshcoreKeys(mc);
        const contacts = new Map((mc.getContacts?.() ?? []).map(c => [c.publicKey.toLowerCase(), c]));
        const nodeRows = await databaseService.meshcore.getNodesBySource(sourceId);
        const dbFavorites = new Set(nodeRows.filter(n => n.isFavorite === true).map(n => n.publicKey.toLowerCase()));
        const allowed: string[] = [];
        for (const pk of keys) {
          const c = contacts.get(pk);
          const protectedKey = local.has(pk) || dbFavorites.has(pk) || c?.deviceFavorite === true || c?.isFavorite === true;
          if (protectedKey) {
            results.push({ nodeKey: `mc:${pk}`, deleted: false, removedFromDevice: false, error: 'PROTECTED' });
          } else {
            allowed.push(pk);
          }
        }

        let bulk: RemoveContactsBulkResult = { status: 'unavailable' };
        if (allowed.length > 0 && mc.removeContactsBulk) {
          bulk = await mc.removeContactsBulk(allowed);
        }
        if (bulk.status === 'busy') {
          return fail(res, 409, 'BULK_REMOVE_BUSY', 'A bulk contact removal is already running for this source');
        }
        if (bulk.status === 'done') {
          for (const pk of bulk.removedFromDevice) results.push({ nodeKey: `mc:${pk}`, deleted: true, removedFromDevice: true });
          for (const pk of bulk.removedLocalOnly) results.push({ nodeKey: `mc:${pk}`, deleted: true, removedFromDevice: false });
          for (const pk of bulk.failed) {
            results.push({ nodeKey: `mc:${pk}`, deleted: false, removedFromDevice: false, error: 'DELETE_FAILED' });
          }
        } else {
          // Repeater / disconnected / meshcore_mqtt: forget the rows locally.
          for (const pk of allowed) {
            try {
              const removed = (await mc.forgetLocalContact?.(pk)) === true;
              results.push({ nodeKey: `mc:${pk}`, deleted: removed, removedFromDevice: false, ...(removed ? {} : { error: 'DELETE_FAILED' }) });
            } catch (err) {
              results.push({ nodeKey: `mc:${pk}`, deleted: false, removedFromDevice: false, error: String(err) });
            }
          }
        }
      } else {
        const mtManager = manager as MeshtasticManager;
        const nums: number[] = [];
        for (const raw of rawKeys) {
          const m = typeof raw === 'string' ? /^mt:(\d{1,10})$/.exec(raw) : null;
          const n = m ? Number(m[1]) : NaN;
          if (!m || !Number.isInteger(n) || n < 0 || n > 0xffffffff) {
            return fail(res, 400, 'INVALID_NODE_KEY', 'Each node key must be mt:<node number>');
          }
          if (!nums.includes(n)) nums.push(n);
        }
        for (const num of nums) {
          try {
            let removedFromDevice = false;
            if (mtManager.isNodeInDeviceDb(num)) {
              try {
                await mtManager.sendRemoveNode(num);
                removedFromDevice = true;
              } catch (deviceErr) {
                logger.warn(`⚠️ Failed to remove node ${num} from device:`, deviceErr);
              }
            }
            await databaseService.deleteNodeAsync(num, sourceId);
            results.push({ nodeKey: `mt:${num}`, nodeNum: num, deleted: true, removedFromDevice });
            logger.info(`🗑️ Dead node cleanup: deleted node ${num}${removedFromDevice ? ' (+ device)' : ''}`);
          } catch (err) {
            logger.error(`Error deleting node ${num}:`, err);
            results.push({ nodeKey: `mt:${num}`, nodeNum: num, deleted: false, removedFromDevice: false, error: String(err) });
          }
        }
      }

      const deletedCount = results.filter(r => r.deleted).length;
      if (user?.id) {
        await databaseService.auditLogAsync(
          user.id,
          'dead_nodes_cleanup',
          'nodes',
          `Bulk deleted ${deletedCount} dead node(s) on source ${sourceId}: ${results.filter(r => r.deleted).map(r => r.nodeKey).join(', ')}`,
          req.ip || ''
        );
      }

      res.json({ success: true, deletedCount, results });
    } catch (error) {
      logger.error('Error bulk deleting dead nodes:', error);
      res.status(500).json({ error: 'Failed to bulk delete nodes' });
    }
  }
);

/**
 * GET /api/security/meshcore/findings?sourceId=
 * MeshCore security findings: path-hash collisions, advert-signature failures,
 * name reuse and own-key change. Read-only DB work; sends nothing.
 */
router.get('/meshcore/findings', requireSourceId('query'), requirePermission('nodes', 'read', { sourceIdFrom: 'query', requireSourceId: true }), async (req: Request, res: Response) => {
  try {
    const sourceId = (req as unknown as { scopedSourceId: string }).scopedSourceId;
    const manager = sourceManagerRegistry.getManager(sourceId);
    if (!manager) {
      return failNoManager(res, sourceId);
    }
    if (!isAnyMeshCoreSourceType(manager.sourceType)) {
      return fail(res, 400, 'INVALID_SOURCE_TYPE', 'MeshCore findings are only available for MeshCore sources');
    }

    const [nodes, widthRaw, deadDaysRaw, change, currentKey, pki] = await Promise.all([
      loadMeshcoreSecurityNodes(sourceId),
      databaseService.settings.getSettingForSource(sourceId, 'meshcoreDefaultPathHashSize'),
      databaseService.settings.getSettingForSource(sourceId, 'securityDeadNodeDays'),
      meshcoreOwnIdentityTracker.getChange(sourceId),
      meshcoreOwnIdentityTracker.getCurrentKey(sourceId),
      databaseService.meshcoreSourcePkiKeys.getBySourceId(sourceId),
    ]);
    const widthN = Number(widthRaw);
    const width: PathHashWidth = widthN === 2 || widthN === 3 ? widthN : 1;
    const heardSinceMs = Date.now() - resolveSecurityDeadNodeDays(deadDaysRaw, true) * DAY_MS;
    const opts = { heardSinceMs };

    const slim = (n: (typeof nodes)[number]) => ({
      publicKey: n.publicKey.toLowerCase(),
      nodeKey: `mc:${n.publicKey.toLowerCase()}`,
      name: n.name ?? null,
      advType: n.advType ?? null,
      lastHeard: n.lastHeard ?? null,
      firstHeard: n.firstHeard ?? null,
      advertSignatureVerified: n.advertSignatureVerified ?? null,
    });

    return ok(res, {
      pathHashCollisions: {
        width,
        countsByWidth: collisionCountsByWidth(nodes, opts),
        groups: findPathHashCollisions(nodes, width, opts).map(g => ({ hash: g.hash, nodes: g.nodes.map(slim) })),
      },
      signatureFailures: listSignatureFailures(nodes).map(slim),
      nameReuse: findNameReuse(nodes).map(g => ({
        name: g.name,
        original: slim(g.original),
        suspects: g.suspects.map(slim),
      })),
      ownKey: {
        currentKey: change?.currentKey ?? currentKey ?? null,
        previousKey: change?.previousKey ?? null,
        detectedAt: change?.detectedAt ?? null,
        pkiKeyMismatch: Number(pki?.keyMismatch ?? 0) > 0,
      },
    });
  } catch (error) {
    logger.error('Error fetching MeshCore security findings:', error);
    return fail(res, 500, 'INTERNAL_ERROR', 'Failed to fetch MeshCore security findings');
  }
});

/**
 * POST /api/security/own-key/acknowledge  { sourceId }
 * Clear the own-key-change record; the current key stays as the new baseline.
 */
router.post(
  '/own-key/acknowledge',
  requirePermission('security', 'write', { sourceIdFrom: 'body', requireSourceId: true }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req as unknown as { scopedSourceId: string }).scopedSourceId;
      const manager = sourceManagerRegistry.getManager(sourceId);
      if (!manager) {
        return failNoManager(res, sourceId);
      }
      if (!isAnyMeshCoreSourceType(manager.sourceType)) {
        return fail(res, 400, 'INVALID_SOURCE_TYPE', 'Own-key tracking is only available for MeshCore sources');
      }
      const cleared = await meshcoreOwnIdentityTracker.acknowledge(sourceId);
      if (req.user?.id) {
        void databaseService.auditLogAsync(
          req.user.id,
          'own_key_change_acknowledged',
          'security',
          `Acknowledged own-key change on source ${sourceId}`,
          req.ip || null
        );
      }
      return ok(res, { acknowledged: cleared });
    } catch (error) {
      logger.error('Error acknowledging own-key change:', error);
      return fail(res, 500, 'INTERNAL_ERROR', 'Failed to acknowledge own-key change');
    }
  }
);

/**
 * POST /api/security/digest/send  { sourceId }
 * Manually send the security digest for one source. Needs `security:write`
 * (a global resource) plus `nodes:read` on the body's source, the source the
 * digest reports on (4.17.3 review L15). A request without a sourceId is
 * rejected rather than fanning out to every source.
 */
router.post(
  '/digest/send',
  requirePermission('security', 'write', { sourceIdFrom: 'body', requireSourceId: true }),
  requirePermission('nodes', 'read', { sourceIdFrom: 'body', requireSourceId: true }),
  async (req: Request, res: Response) => {
    try {
      const digestSourceId = (req as unknown as { scopedSourceId: string }).scopedSourceId;
      const result = await securityDigestService.sendDigest(digestSourceId);
      res.json(result);
    } catch (error) {
      logger.error('Error sending security digest:', error);
      fail(res, 500, 'INTERNAL_ERROR', 'Internal server error');
    }
  },
);

export default router;
