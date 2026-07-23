/**
 * v1 API - Node Actions Endpoint
 *
 * POST actions for interacting with mesh nodes: traceroute, position request,
 * nodeinfo exchange, and neighbor info request. Requires Bearer token auth.
 * All operations are scoped to the source identified by :sourceId.
 *
 * Permissions (enforced by per-route `attachSource` middleware so the
 * `default` source alias, per-source 403, and the canonical `req.source` shape
 * match every other v1 resource):
 *   traceroute, request-neighbors      → traceroute:write
 *   request-position, request-nodeinfo → messages:write
 */

import express, { Request, Response } from 'express';
import databaseService from '../../../services/database.js';
import { resolveSourceManager } from '../../utils/resolveSourceManager.js';
import { logger } from '../../../utils/logger.js';
import { PortNum } from '../../constants/meshtastic.js';
import { attachSource, resolvedSourceIdFromPath } from './sourceParam.js';
import { isTxDisabledError } from '../../errors/txDisabledError.js';

const router = express.Router({ mergeParams: true });

/**
 * Resolve a destination node number from the request body.
 * Accepts:
 *   destination / nodeId / nodeNum  — any of the three keys
 *   "!a1b2c3d4"  — !-prefixed hex (standard Meshtastic nodeId)
 *   "0xa1b2c3d4" — 0x-prefixed hex
 *   2712847316   — plain decimal number
 *   "2712847316" — decimal string
 *
 * Returns null when absent, ambiguous, or out of the valid nodeNum range
 * (1 – 0xFFFFFFFF).  nodeNum 0 is explicitly excluded: it means "broadcast"
 * on some firmware paths but is not a valid single-node destination here.
 */
function resolveDestination(body: any): number | null {
  const raw = body?.destination ?? body?.nodeId ?? body?.nodeNum;
  if (raw == null) return null;

  let num: number;
  if (typeof raw === 'number') {
    num = raw;
  } else if (typeof raw === 'string') {
    if (raw.startsWith('!')) {
      num = parseInt(raw.slice(1), 16);
    } else if (raw.startsWith('0x') || raw.startsWith('0X')) {
      num = parseInt(raw, 16);
    } else {
      // Only accept unambiguous decimal strings — plain hex without prefix is
      // indistinguishable from decimal and is therefore rejected.
      num = parseInt(raw, 10);
    }
  } else {
    return null;
  }

  if (!Number.isInteger(num) || num <= 0 || num > 0xFFFFFFFF) return null;
  return num;
}

/**
 * Source-scoped rate-limit map for request-neighbors.
 * Key: "${sourceId}:${destinationNum}".  Pruned on every insert to avoid
 * unbounded growth (entries older than 2× the limit are removed).
 */
const neighborInfoRateLimitMap = new Map<string, number>();
const NEIGHBOR_INFO_RATE_LIMIT_MS = 180_000;

function pruneNeighborRateLimit(): void {
  const cutoff = Date.now() - NEIGHBOR_INFO_RATE_LIMIT_MS * 2;
  for (const [key, ts] of neighborInfoRateLimitMap) {
    if (ts < cutoff) neighborInfoRateLimitMap.delete(key);
  }
}

// POST /traceroute ─────────────────────────────────────────────────────────────

router.post('/traceroute', attachSource('traceroute', 'write'), async (req: Request, res: Response) => {
  try {
    const sourceId = resolvedSourceIdFromPath(req) as string;
    const destinationNum = resolveDestination(req.body);
    if (destinationNum === null) {
      return res.status(400).json({ success: false, error: 'Destination node is required (destination, nodeId, or nodeNum)' });
    }

    const manager = resolveSourceManager(sourceId);
    const node = await databaseService.nodes.getNode(destinationNum, sourceId);
    const channel = (typeof req.body.channel === 'number' && req.body.channel >= 0 && req.body.channel <= 7)
      ? req.body.channel
      : (node?.channel ?? 0);

    await manager.sendTraceroute(destinationNum, channel);

    res.json({
      success: true,
      data: {
        destination: `!${destinationNum.toString(16).padStart(8, '0')}`,
        channel,
        message: 'Traceroute request sent',
      },
    });
  } catch (error) {
    if (isTxDisabledError(error)) {
      return res.status(409).json({ success: false, error: 'Transmit is disabled on this source', code: 'TX_DISABLED' });
    }
    logger.error('[v1/actions] Error sending traceroute:', error);
    res.status(500).json({ success: false, error: 'Failed to send traceroute' });
  }
});

// POST /request-position ───────────────────────────────────────────────────────

router.post('/request-position', attachSource('messages', 'write'), async (req: Request, res: Response) => {
  try {
    const sourceId = resolvedSourceIdFromPath(req) as string;
    const destinationNum = resolveDestination(req.body);
    if (destinationNum === null) {
      return res.status(400).json({ success: false, error: 'Destination node is required (destination, nodeId, or nodeNum)' });
    }

    const manager = resolveSourceManager(sourceId);
    const node = await databaseService.nodes.getNode(destinationNum, sourceId);
    const channel = (typeof req.body.channel === 'number' && req.body.channel >= 0 && req.body.channel <= 7)
      ? req.body.channel
      : (node?.channel ?? 0);

    const { packetId, requestId } = await manager.sendPositionRequest(destinationNum, channel);

    const localNodeInfo = manager.getLocalNodeInfo();
    const isBroadcast = destinationNum === 0xFFFFFFFF;

    if (localNodeInfo) {
      const timestamp = Date.now();
      const messageChannel = channel === 0 ? -1 : channel;
      await databaseService.messages.insertMessage(
        {
          id: `${sourceId}_${localNodeInfo.nodeNum}_${packetId}`,
          fromNodeNum: localNodeInfo.nodeNum,
          toNodeNum: destinationNum,
          fromNodeId: localNodeInfo.nodeId,
          toNodeId: `!${destinationNum.toString(16).padStart(8, '0')}`,
          text: isBroadcast ? 'Position broadcast sent' : 'Position exchange requested',
          channel: messageChannel,
          portnum: PortNum.TEXT_MESSAGE_APP,
          ...(isBroadcast ? {} : { requestId }),
          timestamp,
          rxTime: timestamp,
          createdAt: timestamp,
        },
        sourceId
      );
    }

    res.json({
      success: true,
      data: {
        destination: `!${destinationNum.toString(16).padStart(8, '0')}`,
        channel,
        message: 'Position request sent',
      },
    });
  } catch (error) {
    if (isTxDisabledError(error)) {
      return res.status(409).json({ success: false, error: 'Transmit is disabled on this source', code: 'TX_DISABLED' });
    }
    logger.error('[v1/actions] Error requesting position:', error);
    res.status(500).json({ success: false, error: 'Failed to request position' });
  }
});

// POST /request-nodeinfo ───────────────────────────────────────────────────────

router.post('/request-nodeinfo', attachSource('messages', 'write'), async (req: Request, res: Response) => {
  try {
    const sourceId = resolvedSourceIdFromPath(req) as string;
    const destinationNum = resolveDestination(req.body);
    if (destinationNum === null) {
      return res.status(400).json({ success: false, error: 'Destination node is required (destination, nodeId, or nodeNum)' });
    }

    const manager = resolveSourceManager(sourceId);
    const node = await databaseService.nodes.getNode(destinationNum, sourceId);
    const channel = (typeof req.body.channel === 'number' && req.body.channel >= 0 && req.body.channel <= 7)
      ? req.body.channel
      : (node?.channel ?? 0);

    const { packetId, requestId } = await manager.sendNodeInfoRequest(destinationNum, channel);

    const localNodeInfo = manager.getLocalNodeInfo();

    if (localNodeInfo) {
      const timestamp = Date.now();
      const messageChannel = channel === 0 ? -1 : channel;
      await databaseService.messages.insertMessage(
        {
          id: `${sourceId}_${localNodeInfo.nodeNum}_${packetId}`,
          fromNodeNum: localNodeInfo.nodeNum,
          toNodeNum: destinationNum,
          fromNodeId: localNodeInfo.nodeId,
          toNodeId: `!${destinationNum.toString(16).padStart(8, '0')}`,
          text: 'User info exchange requested',
          channel: messageChannel,
          portnum: PortNum.TEXT_MESSAGE_APP,
          requestId,
          timestamp,
          rxTime: timestamp,
          createdAt: timestamp,
        },
        sourceId
      );
    }

    res.json({
      success: true,
      data: {
        destination: `!${destinationNum.toString(16).padStart(8, '0')}`,
        channel,
        message: 'NodeInfo request sent (key exchange initiated)',
      },
    });
  } catch (error) {
    if (isTxDisabledError(error)) {
      return res.status(409).json({ success: false, error: 'Transmit is disabled on this source', code: 'TX_DISABLED' });
    }
    logger.error('[v1/actions] Error requesting nodeinfo:', error);
    res.status(500).json({ success: false, error: 'Failed to request node info' });
  }
});

// POST /request-neighbors ──────────────────────────────────────────────────────

router.post('/request-neighbors', attachSource('traceroute', 'write'), async (req: Request, res: Response) => {
  try {
    const sourceId = resolvedSourceIdFromPath(req) as string;
    const destinationNum = resolveDestination(req.body);
    if (destinationNum === null) {
      return res.status(400).json({ success: false, error: 'Destination node is required (destination, nodeId, or nodeNum)' });
    }

    const manager = resolveSourceManager(sourceId);
    const localNodeNum = manager.getLocalNodeInfo()?.nodeNum;
    const node = await databaseService.nodes.getNode(destinationNum, sourceId);
    const isLocalNode = localNodeNum != null && destinationNum === localNodeNum;
    const isDirectNode = node != null && node.hopsAway != null && Number(node.hopsAway) === 0;

    if (!isLocalNode && !isDirectNode) {
      return res.status(403).json({
        success: false,
        error: 'Neighbor info requests are only allowed for the local node or directly-heard (0-hop) nodes',
      });
    }

    const rateLimitKey = `${sourceId}:${destinationNum}`;
    const lastRequest = neighborInfoRateLimitMap.get(rateLimitKey);
    const now = Date.now();
    if (lastRequest !== undefined && (now - lastRequest) < NEIGHBOR_INFO_RATE_LIMIT_MS) {
      const retryAfter = Math.ceil((NEIGHBOR_INFO_RATE_LIMIT_MS - (now - lastRequest)) / 1000);
      return res.status(429).json({
        success: false,
        error: 'Rate limited: firmware limits neighbor info responses to once per 3 minutes',
        retryAfter,
      });
    }

    pruneNeighborRateLimit();

    const channel = (typeof req.body.channel === 'number' && req.body.channel >= 0 && req.body.channel <= 7)
      ? req.body.channel
      : (node?.channel ?? 0);

    await manager.sendNeighborInfoRequest(destinationNum, channel);
    neighborInfoRateLimitMap.set(rateLimitKey, now);

    res.json({
      success: true,
      data: {
        destination: `!${destinationNum.toString(16).padStart(8, '0')}`,
        channel,
        message: 'Neighbor info request sent',
      },
    });
  } catch (error) {
    if (isTxDisabledError(error)) {
      return res.status(409).json({ success: false, error: 'Transmit is disabled on this source', code: 'TX_DISABLED' });
    }
    logger.error('[v1/actions] Error requesting neighbor info:', error);
    res.status(500).json({ success: false, error: 'Failed to request neighbor info' });
  }
});

export { neighborInfoRateLimitMap };
export default router;
