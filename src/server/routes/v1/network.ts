/**
 * v1 API - Network Endpoint
 *
 * Provides read-only access to network-wide statistics and information
 */

import express, { Request, Response } from 'express';
import databaseService from '../../../services/database.js';
import { logger } from '../../../utils/logger.js';
import { getEffectiveDbNodePosition, scopeNodeRowsForViewer, type NodeViewAccess } from '../../utils/nodeEnhancer.js';
import { canViewRowChannel, loadV1Access, requireScopedSourceId } from './sourceParam.js';
import { isAnyMeshCoreSourceType } from '../../../utils/nodeTypeCategory.js';
import { loadMeshCoreNodesForViewer } from '../../services/meshcoreNodeView.js';
import { meshcoreNodeToV1, meshcoreNodeKey, withMeshtasticProtocol } from '../../utils/protocolRows.js';
import { nodeNumFromPubkey } from '../../../utils/meshcoreNodeNum.js';
import { loadMeshCoreTracesV1 } from './traceroutes.js';

type SourcedRequest = Request & { source?: { type?: string } };
const isMeshCoreReq = (req: Request): boolean => isAnyMeshCoreSourceType((req as SourcedRequest).source?.type);
const DAY_MS = 86_400_000;

const router = express.Router({ mergeParams: true });

/**
 * The source's traceroutes as the token user may see them. `attachSource`
 * gates this router on `nodes:read`; traceroutes are their own resource, so
 * they are included only with `traceroute:read` on this source, and then only
 * those heard on a channel the user may view there (the rule the v1
 * traceroutes route applies). An admin gets every row.
 */
async function visibleTraceroutes(access: NodeViewAccess, sourceId: string, limit: number) {
  if (!access.permissions.can('traceroute', 'read', sourceId)) return [];
  const traceroutes = await databaseService.traceroutes.getAllTraceroutes(limit, sourceId);
  return traceroutes.filter((t) => canViewRowChannel(access, sourceId, (t as { channel?: number | null }).channel));
}

/**
 * GET /api/v1/sources/{sourceId}/network
 * Statistics for one source. The traceroute count needs `traceroute:read` on it.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const sourceId = requireScopedSourceId(req, res);
    if (!sourceId) return;
    const access = await loadV1Access(req);
    if (isMeshCoreReq(req)) {
      const [total, active, traces] = await Promise.all([
        databaseService.meshcore.countNodesBySource(sourceId),
        databaseService.meshcore.countActiveNodesBySource(sourceId, Date.now() - 7 * DAY_MS),
        access.permissions.can('traceroute', 'read', sourceId) ? loadMeshCoreTracesV1(sourceId, 100) : Promise.resolve([]),
      ]);
      return res.json({
        success: true,
        data: { protocol: 'meshcore', totalNodes: total, activeNodes: active, tracerouteCount: traces.length, lastUpdated: Date.now() },
      });
    }
    const [allNodes, activeNodes, traceroutes] = await Promise.all([
      databaseService.nodes.getAllNodes(sourceId),
      databaseService.nodes.getActiveNodes(7, sourceId),
      visibleTraceroutes(access, sourceId, 100),
    ]);

    const stats = {
      protocol: 'meshtastic' as const,
      // Totals for the source, open to `nodes:read` on it (as the per-source
      // gauges of /api/v1/metrics are).
      totalNodes: allNodes.length,
      activeNodes: activeNodes.length,
      tracerouteCount: traceroutes.length,
      lastUpdated: Date.now()
    };

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    logger.error('Error getting network stats:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to retrieve network statistics'
    });
  }
});

/**
 * GET /api/v1/sources/{sourceId}/network/direct-neighbors
 * Get direct neighbor statistics based on zero-hop packets
 * This helps identify which nodes we've heard directly (no relays)
 *
 * The statistics come from the packet log, which is per source. They are read
 * from the source in the path, on which `attachSource` has checked
 * `nodes:read` (the rule `/api/direct-neighbors` applies). This used to return
 * every source's statistics whichever source the path named.
 */
router.get('/direct-neighbors', async (req: Request, res: Response) => {
  try {
    const sourceId = requireScopedSourceId(req, res);
    if (!sourceId) return;
    const hoursBack = parseInt(req.query.hours as string) || 24;

    if (isMeshCoreReq(req)) {
      const heard = await databaseService.meshcore.getDirectHeardStats(sourceId, Date.now() - hoursBack * 3_600_000);
      // A row with no full key only carries a sender hash: it names a node
      // only when exactly one of this source's nodes starts with it.
      const nodes = await databaseService.meshcore.getNodesBySource(sourceId);
      const keys = nodes.map((n) => n.publicKey.toLowerCase());
      const merged: Record<string, {
        protocol: 'meshcore'; nodeKey: string; publicKey: string; nodeNum: number;
        avgRssi: number | null; bestSnr: number | null; packetCount: number; lastHeard: number;
      }> = {};
      for (const h of heard) {
        let pk = h.senderPubKey ? h.senderPubKey.toLowerCase() : null;
        if (!pk && h.srcHash) {
          const matches = keys.filter((k) => k.startsWith(h.srcHash!.toLowerCase()));
          if (matches.length === 1) pk = matches[0];
        }
        const nodeKey = meshcoreNodeKey(pk);
        if (!pk || !nodeKey || pk.length !== 64) continue;
        const cur = merged[nodeKey];
        if (cur) {
          cur.packetCount += h.count;
          cur.lastHeard = Math.max(cur.lastHeard, h.lastHeard);
          if (h.bestRssi !== null) cur.avgRssi = cur.avgRssi === null ? h.bestRssi : Math.max(cur.avgRssi, h.bestRssi);
          if (h.bestSnr !== null) cur.bestSnr = cur.bestSnr === null ? h.bestSnr : Math.max(cur.bestSnr, h.bestSnr);
        } else {
          merged[nodeKey] = {
            protocol: 'meshcore', nodeKey, publicKey: pk, nodeNum: nodeNumFromPubkey(pk),
            // MeshCore keeps the strongest reading, not an average (see getDirectHeardStats).
            avgRssi: h.bestRssi, bestSnr: h.bestSnr, packetCount: h.count, lastHeard: h.lastHeard,
          };
        }
      }
      return res.json({ success: true, data: merged, count: Object.keys(merged).length });
    }

    const stats = await databaseService.getDirectNeighborStatsAsync(hoursBack, sourceId);
    const tagged = Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, withMeshtasticProtocol(v)]));

    res.json({
      success: true,
      data: tagged,
      count: Object.keys(stats).length
    });
  } catch (error) {
    logger.error('Error getting direct neighbor stats:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to retrieve direct neighbor statistics'
    });
  }
});

/**
 * GET /api/v1/sources/{sourceId}/network/topology
 * Get network topology data (nodes and their connections)
 */
router.get('/topology', async (req: Request, res: Response) => {
  try {
    const sourceId = requireScopedSourceId(req, res);
    if (!sourceId) return;
    const access = await loadV1Access(req);
    if (isMeshCoreReq(req)) {
      const [rows, traces] = await Promise.all([
        loadMeshCoreNodesForViewer(sourceId, access, { positions: true }),
        access.permissions.can('traceroute', 'read', sourceId) ? loadMeshCoreTracesV1(sourceId, 500) : Promise.resolve([]),
      ]);
      return res.json({
        success: true,
        data: {
          nodes: rows.map((r) => {
            const n = meshcoreNodeToV1(r, sourceId);
            return {
              protocol: n.protocol, nodeId: n.nodeId, nodeKey: n.nodeKey, publicKey: n.publicKey, nodeNum: n.nodeNum,
              longName: n.longName, shortName: n.shortName, role: null, advType: n.advType, hopsAway: n.hopsAway,
              latitude: n.latitude, longitude: n.longitude, lastHeard: n.lastHeard, firstHeard: n.firstHeard,
            };
          }),
          edges: traces.map((t) => ({
            protocol: t.protocol,
            from: t.fromNodeId,
            to: t.toNodeId,
            route: t.route ? JSON.parse(t.route) : [],
            snr: t.snrTowards ? JSON.parse(t.snrTowards) : [],
            hops: t.hops,
          })),
        },
      });
    }
    const [allNodes, traceroutes] = await Promise.all([
      databaseService.nodes.getAllNodes(sourceId),
      visibleTraceroutes(access, sourceId, 500),
    ]);
    // Same rows, and the same position rule, as GET .../nodes: a node on a
    // channel the user cannot view is left out, a position from such a channel
    // is withheld, and a private override's coordinates are removed without
    // `nodes_private:read` on this source. The effective position below is
    // worked out from what is left, so it falls back to the reported position.
    const nodes = scopeNodeRowsForViewer(allNodes, access, sourceId);

    const topology = {
      nodes: nodes.map(n => {
        // Surface effective position (override if enabled, else device GPS) so
        // topology consumers see the same lat/lon as the rest of the API
        // (issue #2847).
        const eff = getEffectiveDbNodePosition(n);
        return {
          protocol: 'meshtastic' as const,
          nodeId: n.nodeId,
          nodeNum: n.nodeNum,
          longName: n.longName,
          shortName: n.shortName,
          role: n.role,
          hopsAway: n.hopsAway,
          // null, not absent, when the position is withheld: the key set is fixed.
          latitude: eff.latitude ?? null,
          longitude: eff.longitude ?? null,
          lastHeard: n.lastHeard,
          // #5390: Unix seconds; null = unknown.
          firstHeard: n.firstHeard != null ? Number(n.firstHeard) : null,
        };
      }),
      edges: traceroutes.map(t => ({
        protocol: 'meshtastic' as const,
        from: t.fromNodeId,
        to: t.toNodeId,
        route: t.route ? JSON.parse(t.route) : [],
        snr: t.snrTowards ? JSON.parse(t.snrTowards) : []
      }))
    };

    res.json({
      success: true,
      data: topology
    });
  } catch (error) {
    logger.error('Error getting network topology:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to retrieve network topology'
    });
  }
});

export default router;
