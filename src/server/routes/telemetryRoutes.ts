import { Router, Request, Response } from 'express';
import { optionalAuth, requireAuth, requirePermission, hasPermission } from '../auth/authMiddleware.js';
import { requireSourceId } from '../utils/requireSourceId.js';
import databaseService from '../../services/database.js';
import { ALL_SOURCES } from '../../db/repositories/index.js';
import { ok, fail } from '../utils/apiResponse.js';
import {
  computeSignalTrend,
  SIGNAL_TREND_TELEMETRY_TYPES,
  SIGNAL_TREND_LOOKBACK_MS,
  SIGNAL_TREND_MAX_SAMPLES,
} from '../services/signalTrend.js';
import { logger } from '../../utils/logger.js';
import type { DbNode } from '../../db/types.js';
import { isValidNodeNum } from '../constants/meshtastic.js';
import {
  filterNodesByChannelPermission,
  checkNodeChannelAccess,
  getEffectiveDbNodePosition,
  loadNodeViewAccess,
} from '../utils/nodeEnhancer.js';
import { listPermittedSourceIds, loadSourcePermissions } from '../utils/sourceScopedAccess.js';
import type { SourceSetScope } from '../../db/repositories/index.js';
import type { User } from '../../types/auth.js';

/**
 * `info` and `dashboard`, which gate this router, are install-wide grants: they
 * say the caller may open the telemetry views, not which source's rows they
 * may read. The rows are per source, so every handler below also decides the
 * source(s) it reads from the caller's per-source grants. A handler that reads
 * with no source named must not fall back to "every source" for a caller who
 * is not an admin.
 */

/** The one `sourceId` a request names in its query, or undefined. */
function namedSourceId(req: Request): string | undefined {
  const raw = req.query.sourceId;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/**
 * The sources one node's telemetry may be read from when the request names
 * none. Admin: every source. Otherwise the sources that hold the node on a
 * channel the caller has `viewOnMap` on THERE (for a MeshCore public key,
 * which has no channel: the sources with `nodes:viewOnMap`). `null` when no
 * source passes.
 */
async function nodeTelemetrySources(nodeId: string, user: User | null | undefined): Promise<SourceSetScope | null> {
  if (user?.isAdmin) return ALL_SOURCES;
  if (!user) return null;
  if (/^[0-9a-fA-F]{64}$/.test(nodeId)) {
    const permissions = await loadSourcePermissions(user);
    const sources = permissions.sourcesWhere((grants) => grants.nodes?.viewOnMap === true);
    return sources.length > 0 ? sources : null;
  }
  const nodeNum = nodeId.startsWith('!') ? parseInt(nodeId.replace('!', ''), 16) : parseInt(nodeId, 10);
  if (!isValidNodeNum(nodeNum)) return null;
  const [access, rows] = await Promise.all([
    loadNodeViewAccess(user),
    databaseService.nodes.getNodeVisibilityAcrossSources(nodeNum),
  ]);
  const sources = rows.filter((row) => access.canViewNode(row.sourceId, row.channel)).map((row) => row.sourceId);
  return sources.length > 0 ? sources : null;
}

const router = Router();

// Get direct neighbor RSSI statistics from zero-hop packets
// This helps identify which nodes we've heard directly (no relays)
//
// The statistics come from the packet log, which is per source. `info:read`
// opens the route; the rows come only from sources the caller holds
// `nodes:read` on. `?sourceId=` narrows to one of them. An admin reads every
// source, or the one named. It used to return every source's statistics to
// any holder of `info:read`.
router.get('/direct-neighbors', requirePermission('info', 'read'), async (req: Request, res: Response) => {
  try {
    const hoursBack = parseInt(req.query.hours as string) || 24;
    const named = namedSourceId(req);
    const permitted = await listPermittedSourceIds(req.user, 'nodes', 'read');
    let scope: SourceSetScope;
    if (permitted === 'all') {
      scope = named ?? ALL_SOURCES;
    } else if (named) {
      if (!permitted.includes(named)) {
        return fail(res, 403, 'FORBIDDEN', 'Insufficient permissions');
      }
      scope = named;
    } else {
      scope = permitted;
    }
    const stats = await databaseService.getDirectNeighborStatsAsync(hoursBack, scope);

    res.json({
      success: true,
      data: stats,
      count: Object.keys(stats).length
    });
  } catch (error) {
    logger.error('Error getting direct neighbor stats:', error);
    fail(res, 500, 'INTERNAL_ERROR', 'Failed to fetch direct neighbor statistics');
  }
});

// Get telemetry data for a node
router.get('/telemetry/:nodeId', optionalAuth(), requireSourceId('query'), async (req: Request, res: Response) => {
  try {
    // Allow users with info read OR dashboard read (dashboard needs telemetry data)
    if (
      !req.user?.isAdmin &&
      !(req.user ? await hasPermission(req.user, 'info', 'read') : false) &&
      !(req.user ? await hasPermission(req.user, 'dashboard', 'read') : false)
    ) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const { nodeId } = req.params;

    // Check channel-based access for this node (source-scoped, #3745)
    if (!await checkNodeChannelAccess(nodeId, req.user, req.query.sourceId as string)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    // parseFloat (not parseInt) so sub-hour windows like 0.25h (15 minutes)
    // from the Device Info time-range selector survive the round-trip.
    const rawHours = req.query.hours ? parseFloat(req.query.hours as string) : 24;
    const hoursParam = Number.isFinite(rawHours) && rawHours > 0 ? rawHours : 24;
    // sourceId presence validated by requireSourceId('query')
    const telSourceId = req.query.sourceId as string;

    // Calculate cutoff timestamp for filtering
    const cutoffTime = Date.now() - hoursParam * 60 * 60 * 1000;

    // Check if node has private position override. Meshtastic nodeIds are an
    // 8-hex nodeNum; MeshCore peers arrive here as a 64-hex public key, which
    // overflows parseInt to ~6e+76 and trips the getNode out-of-range guard on
    // every poll (#3677). Skip the lookup for non-Meshtastic ids — they have no
    // Meshtastic position-override semantics, so isPrivate is simply false.
    const nodeNum = /^[0-9a-fA-F]{64}$/.test(nodeId)
      ? NaN
      : parseInt(nodeId.replace('!', ''), 16);
    const node = isValidNodeNum(nodeNum)
      ? await databaseService.nodes.getNode(nodeNum, telSourceId)
      : null;
    const isPrivate = node?.positionOverrideIsPrivate === true;
    // `nodes_private` is a per-source permission: checked on this source.
    const canViewPrivate = !!req.user && await hasPermission(req.user, 'nodes_private', 'read', telSourceId);

    // Use the averaged query for graph data on every backend (SQLite,
    // PostgreSQL, MySQL). The interval is chosen dynamically to target a
    // manageable, roughly fixed number of points per telemetry type, so short
    // windows keep near-full resolution while long windows return the full
    // history downsampled instead of being truncated to the newest N rows.
    const telemetry = await databaseService.getTelemetryByNodeAveragedAsync(nodeId, cutoffTime, undefined, hoursParam, telSourceId);

    // Filter out location telemetry if private and unauthorized
    let processedTelemetry = telemetry;
    if (isPrivate && !canViewPrivate) {
      processedTelemetry = telemetry.filter(t =>
        !['latitude', 'longitude', 'altitude'].includes(t.telemetryType)
      );
    }

    res.json(processedTelemetry);
  } catch (error) {
    logger.error('Error fetching telemetry:', error);
    res.status(500).json({ error: 'Failed to fetch telemetry' });
  }
});

// Get packet rate statistics (packets per minute) for a node
router.get('/telemetry/:nodeId/rates', optionalAuth(), async (req: Request, res: Response) => {
  try {
    // Allow users with info read OR dashboard read
    if (
      !req.user?.isAdmin &&
      !(req.user ? await hasPermission(req.user, 'info', 'read') : false) &&
      !(req.user ? await hasPermission(req.user, 'dashboard', 'read') : false)
    ) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const { nodeId } = req.params;
    const ratesSourceId = namedSourceId(req);

    // The source(s) the samples are read from. Named: that source, when the
    // caller may see the node on it (source-scoped, #3745). None named: the
    // sources where the caller may see the node, never "every source" for a
    // caller who is not an admin.
    let ratesScope: SourceSetScope;
    if (ratesSourceId) {
      if (!await checkNodeChannelAccess(nodeId, req.user, ratesSourceId)) {
        return fail(res, 403, 'FORBIDDEN', 'Insufficient permissions');
      }
      ratesScope = ratesSourceId;
    } else {
      const sources = await nodeTelemetrySources(nodeId, req.user);
      if (sources === null) {
        return fail(res, 403, 'FORBIDDEN', 'Insufficient permissions');
      }
      ratesScope = sources;
    }
    const hoursParam = req.query.hours ? parseInt(req.query.hours as string) : 24;

    // Calculate cutoff timestamp for filtering
    const cutoffTime = Date.now() - hoursParam * 60 * 60 * 1000;

    // The 7 packet statistics types we want rates for
    const packetTypes = [
      'numPacketsRx',
      'numPacketsRxBad',
      'numRxDupe',
      'numPacketsTx',
      'numTxDropped',
      'numTxRelay',
      'numTxRelayCanceled',
    ];

    let rates: Record<string, Array<{ timestamp: number; ratePerMinute: number }>>;

    // For PostgreSQL/MySQL, calculate rates from raw telemetry
    if (databaseService.drizzleDbType === 'postgres' || databaseService.drizzleDbType === 'mysql') {
      rates = {};
      for (const type of packetTypes) {
        rates[type] = [];
      }

      // Fetch telemetry for each packet type and calculate rates
      for (const type of packetTypes) {
        const telemetry = await databaseService.telemetry.getTelemetryByNode(
          nodeId, 5000, cutoffTime, undefined, 0, type, ratesScope
        );

        // Sort by timestamp ascending for rate calculation
        telemetry.sort((a, b) => a.timestamp - b.timestamp);

        // Calculate rates from consecutive samples
        for (let i = 1; i < telemetry.length; i++) {
          const prev = telemetry[i - 1];
          const curr = telemetry[i];
          const timeDiffMs = curr.timestamp - prev.timestamp;
          const valueDiff = curr.value - prev.value;

          if (timeDiffMs > 0 && valueDiff >= 0) {
            const timeDiffMinutes = timeDiffMs / 60000;
            const ratePerMinute = valueDiff / timeDiffMinutes;
            rates[type].push({
              timestamp: curr.timestamp,
              ratePerMinute: Math.round(ratePerMinute * 100) / 100,
            });
          }
        }
      }
    } else {
      rates = await databaseService.getPacketRatesAsync(nodeId, packetTypes, cutoffTime, ratesScope);
    }

    res.json(rates);
  } catch (error) {
    logger.error('Error fetching packet rates:', error);
    fail(res, 500, 'INTERNAL_ERROR', 'Failed to fetch packet rates');
  }
});

// Get smart hops statistics (min/max/avg hop counts over time) for a node
router.get('/telemetry/:nodeId/smarthops', optionalAuth(), requireSourceId('query'), async (req: Request, res: Response) => {
  try {
    // Allow users with info read OR dashboard read
    if (
      !req.user?.isAdmin &&
      !(req.user ? await hasPermission(req.user, 'info', 'read') : false) &&
      !(req.user ? await hasPermission(req.user, 'dashboard', 'read') : false)
    ) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const { nodeId } = req.params;

    // Check channel-based access for this node (source-scoped, #3745)
    if (!await checkNodeChannelAccess(nodeId, req.user, req.query.sourceId as string)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    // Validate and clamp hours (1-168, default 24)
    const hoursParam = Math.max(1, Math.min(168, parseInt(req.query.hours as string) || 24));
    // Validate and clamp interval (5-60 minutes, default 15)
    const intervalParam = Math.max(5, Math.min(60, parseInt(req.query.interval as string) || 15));

    // Calculate cutoff timestamp for filtering
    const cutoffTime = Date.now() - hoursParam * 60 * 60 * 1000;

    // Get smart hops statistics (sourceId required + validated by requireSourceId)
    const stats = await databaseService.getSmartHopsStatsAsync(nodeId, cutoffTime, intervalParam, req.query.sourceId as string);

    res.json({ success: true, data: stats });
  } catch (error) {
    logger.error('Error fetching smart hops stats:', error);
    res.status(500).json({ error: 'Failed to fetch smart hops statistics' });
  }
});

// Get link quality history for a node
router.get('/telemetry/:nodeId/linkquality', optionalAuth(), requireSourceId('query'), async (req: Request, res: Response) => {
  try {
    // Allow users with info read OR dashboard read
    if (
      !req.user?.isAdmin &&
      !(req.user ? await hasPermission(req.user, 'info', 'read') : false) &&
      !(req.user ? await hasPermission(req.user, 'dashboard', 'read') : false)
    ) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const { nodeId } = req.params;

    // Check channel-based access for this node (source-scoped, #3745)
    if (!await checkNodeChannelAccess(nodeId, req.user, req.query.sourceId as string)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    // Validate and clamp hours (1-168, default 24)
    const hoursParam = Math.max(1, Math.min(168, parseInt(req.query.hours as string) || 24));

    // Calculate cutoff timestamp for filtering
    const cutoffTime = Date.now() - hoursParam * 60 * 60 * 1000;

    // Get link quality history (sourceId required + validated by requireSourceId)
    const history = await databaseService.getLinkQualityHistoryAsync(nodeId, cutoffTime, req.query.sourceId as string);

    res.json({ success: true, data: history });
  } catch (error) {
    logger.error('Error fetching link quality history:', error);
    res.status(500).json({ error: 'Failed to fetch link quality history' });
  }
});

// Get the derived signal trend / link-attenuation indicator for a node (#4110).
// Compares the node's trailing-24h RSSI/SNR against a prior-7d baseline and
// factors in noise-floor drift; returns a compact trend badge payload.
router.get('/telemetry/:nodeId/signal-trend', optionalAuth(), requireSourceId('query'), async (req: Request, res: Response) => {
  try {
    // Allow users with info read OR dashboard read (same gate as linkquality)
    if (
      !req.user?.isAdmin &&
      !(req.user ? await hasPermission(req.user, 'info', 'read') : false) &&
      !(req.user ? await hasPermission(req.user, 'dashboard', 'read') : false)
    ) {
      return fail(res, 403, 'FORBIDDEN', 'Insufficient permissions');
    }

    const { nodeId } = req.params;

    // Check channel-based access for this node (source-scoped, #3745)
    if (!await checkNodeChannelAccess(nodeId, req.user, req.query.sourceId as string)) {
      return fail(res, 403, 'FORBIDDEN', 'Insufficient permissions');
    }

    const sourceId = req.query.sourceId as string;
    const now = Date.now();
    const samples = await databaseService.telemetry.getSignalTrendSamples(
      nodeId,
      SIGNAL_TREND_TELEMETRY_TYPES,
      now - SIGNAL_TREND_LOOKBACK_MS,
      sourceId,
      SIGNAL_TREND_MAX_SAMPLES
    );

    const result = computeSignalTrend(samples, now);
    return ok(res, result);
  } catch (error) {
    logger.error('Error computing signal trend:', error);
    return fail(res, 500, 'SIGNAL_TREND_ERROR', 'Failed to compute signal trend');
  }
});

// Delete telemetry data for a specific node and type
router.delete('/telemetry/:nodeId/:telemetryType', requireAuth(), requirePermission('info', 'write'), requireSourceId('query'), async (req: Request, res: Response) => {
  try {
    const { nodeId, telemetryType } = req.params;
    // sourceId presence validated by requireSourceId; scope the delete so it
    // never wipes another source's telemetry for this node.
    const purgeSourceId = req.query.sourceId as string;

    // `info:write` is install-wide; the rows are this source's. The caller
    // must also be able to see the node on this source.
    if (!await checkNodeChannelAccess(nodeId, req.user, purgeSourceId)) {
      return fail(res, 403, 'FORBIDDEN', 'Insufficient permissions');
    }

    logger.info(`Purging telemetry data for node ${nodeId}, type ${telemetryType}, source ${purgeSourceId}`);

    const deleted = await databaseService.telemetry.deleteTelemetryByNodeAndType(nodeId, telemetryType, purgeSourceId);

    if (deleted) {
      logger.info(`Successfully purged ${telemetryType} telemetry for node ${nodeId}`);
      res.json({ success: true, message: `Telemetry data purged successfully` });
    } else {
      fail(res, 404, 'NOT_FOUND', 'No telemetry data found to delete');
    }
  } catch (error) {
    logger.error('Error purging telemetry data:', error);
    fail(res, 500, 'INTERNAL_ERROR', 'Failed to purge telemetry data');
  }
});

// Check which nodes have telemetry data
router.get('/telemetry/available/nodes', requirePermission('info', 'read'), async (req: Request, res: Response) => {
  try {
    const telAvailSourceId = namedSourceId(req);
    const viewer = req.user ?? null;

    let nodes: DbNode[];
    let nodeTelemetryTypes: Map<string, string[]>;
    if (viewer?.isAdmin || telAvailSourceId) {
      // One source, or an admin's view of every source: one query, as before.
      const allNodes = await databaseService.nodes.getAllNodes(telAvailSourceId ?? ALL_SOURCES);
      // Filter nodes based on channel read permissions (source-scoped, #3745)
      nodes = await filterNodesByChannelPermission(allNodes, viewer, telAvailSourceId);
      // Efficient bulk query: get all telemetry types for all nodes at once
      nodeTelemetryTypes = await databaseService.getAllNodesTelemetryTypesAsync(telAvailSourceId);
    } else {
      // No source named: only rows from sources the caller holds a channel
      // grant on, each row checked on its OWN source. The caller's grants used
      // to be merged across sources here, so a grant on source A listed
      // source B's nodes.
      const access = await loadNodeViewAccess(viewer);
      const candidates = await databaseService.nodes.getAllNodes(access.sources === 'all' ? ALL_SOURCES : access.sources);
      const seen = new Set<string>();
      nodes = candidates.filter((node) => {
        const rowSource = (node as { sourceId?: string | null }).sourceId;
        if (!rowSource || !access.canViewNode(rowSource, node.channel)) return false;
        seen.add(rowSource);
        return true;
      });
      // Telemetry types from the sources of the rows returned, and no other.
      // One cached read per source.
      nodeTelemetryTypes = new Map();
      const perSource = await Promise.all([...seen].map((id) => databaseService.getAllNodesTelemetryTypesAsync(id)));
      for (const map of perSource) {
        for (const [nodeId, types] of map) {
          const merged = nodeTelemetryTypes.get(nodeId);
          nodeTelemetryTypes.set(nodeId, merged ? [...new Set([...merged, ...types])] : types);
        }
      }
    }

    const nodesWithTelemetry: string[] = [];
    const nodesWithWeather: string[] = [];
    const nodesWithEstimatedPosition: string[] = [];
    // Known nodes with neither a real nor an estimated position (issue #3271 map counter).
    const nodesUnmapped: string[] = [];

    const weatherTypes = new Set(['temperature', 'humidity', 'pressure']);

    // Global estimated positions (one per physical node, pooled across sources).
    const estimatedRows = await databaseService.getAllEstimatedPositionsAsync();
    const estimatedPositionMap = new Map(estimatedRows.map(r => [r.nodeId, r]));
    const estimatedUncertainty: Record<string, number> = {};

    nodes.forEach(node => {
      const telemetryTypes = nodeTelemetryTypes.get(node.nodeId);
      if (telemetryTypes && telemetryTypes.length > 0) {
        nodesWithTelemetry.push(node.nodeId);

        // Check if any telemetry type is weather-related
        const hasWeather = telemetryTypes.some(t => weatherTypes.has(t));
        if (hasWeather) {
          nodesWithWeather.push(node.nodeId);
        }
      }

      // Estimated-position / unmapped status is independent of telemetry presence.
      // A user-set override counts as a known position — we don't want to draw an
      // uncertainty circle on a node the user has explicitly placed (issue #2847).
      const eff = getEffectiveDbNodePosition(node);
      const hasRealPosition = eff.latitude != null && eff.longitude != null;
      const estimate = estimatedPositionMap.get(node.nodeId);
      const hasEstimatedPosition = estimate !== undefined;
      if (hasEstimatedPosition && !hasRealPosition) {
        nodesWithEstimatedPosition.push(node.nodeId);
        if (estimate.uncertaintyKm != null) {
          estimatedUncertainty[node.nodeId] = estimate.uncertaintyKm;
        }
      }
      if (!hasRealPosition && !hasEstimatedPosition) {
        nodesUnmapped.push(node.nodeId);
      }
    });

    // Check for PKC-enabled nodes
    const nodesWithPKC: string[] = [];

    // Get the local node ID to ensure it's always marked as secure.
    // Read per-source so multi-source deployments don't always show the first
    // source's local node as "secure local node" for every source view.
    const localNodeNumStr = await databaseService.settings.getLocalNodeNumForSource(
      telAvailSourceId ?? null,
    );
    let localNodeId: string | null = null;
    if (localNodeNumStr) {
      const localNodeNum = parseInt(localNodeNumStr, 10);
      localNodeId = `!${localNodeNum.toString(16).padStart(8, '0')}`;
    }

    nodes.forEach(node => {
      // Local node is always secure (direct TCP/serial connection, no mesh encryption needed)
      // OR node has PKC enabled
      if (node.nodeId === localNodeId || node.hasPKC || node.publicKey) {
        nodesWithPKC.push(node.nodeId);
      }
    });

    res.json({
      nodes: nodesWithTelemetry,
      weather: nodesWithWeather,
      estimatedPosition: nodesWithEstimatedPosition,
      estimatedUncertainty,
      unmapped: nodesUnmapped,
      unmappedCount: nodesUnmapped.length,
      pkc: nodesWithPKC,
    });
  } catch (error) {
    logger.error('Error checking telemetry availability:', error);
    fail(res, 500, 'INTERNAL_ERROR', 'Failed to check telemetry availability');
  }
});

export default router;
