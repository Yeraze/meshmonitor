/**
 * v1 API - Node Actions Endpoint
 *
 * Provides POST actions for interacting with mesh nodes:
 * traceroute, position request, nodeinfo exchange, and neighbor info request.
 *
 * These endpoints mirror the internal API actions but are accessible
 * via Bearer token authentication for external clients.
 */

import express, { Request, Response } from 'express';
import databaseService from '../../../services/database.js';
import meshtasticManager from '../../meshtasticManager.js';
import { hasPermission } from '../../auth/authMiddleware.js';
import { logger } from '../../../utils/logger.js';
import { PortNum } from '../../constants/meshtastic.js';

const router = express.Router();

/**
 * Resolve a node destination from the request body.
 * Accepts nodeId string (e.g. "!a1b2c3d4") or nodeNum number.
 * Returns the numeric node number or null if invalid.
 */
function resolveDestination(body: any): number | null {
  const { destination, nodeId, nodeNum } = body;
  const raw = destination || nodeId || nodeNum;
  if (!raw) return null;

  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') {
    // Handle "!hex" format
    if (raw.startsWith('!')) {
      const num = parseInt(raw.slice(1), 16);
      return isNaN(num) ? null : num;
    }
    // Handle plain hex or decimal string
    const num = parseInt(raw, raw.startsWith('0x') ? 16 : 10);
    return isNaN(num) ? null : num;
  }
  return null;
}

/**
 * POST /api/v1/actions/traceroute
 * Send a traceroute to a destination node
 */
router.post('/traceroute', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user?.isAdmin && !(user ? await hasPermission(user, 'traceroute', 'write') : false)) {
      return res.status(403).json({ success: false, error: 'Insufficient permissions', required: 'traceroute:write' });
    }

    const destinationNum = resolveDestination(req.body);
    if (!destinationNum) {
      return res.status(400).json({ success: false, error: 'Destination node is required (destination, nodeId, or nodeNum)' });
    }

    const node = await databaseService.nodes.getNode(destinationNum);
    const channel = node?.channel ?? 0;

    await meshtasticManager.sendTraceroute(destinationNum, channel);

    res.json({
      success: true,
      data: {
        destination: `!${destinationNum.toString(16).padStart(8, '0')}`,
        channel,
        message: 'Traceroute request sent',
      },
    });
  } catch (error) {
    logger.error('[v1/actions] Error sending traceroute:', error);
    res.status(500).json({ success: false, error: 'Failed to send traceroute' });
  }
});

/**
 * POST /api/v1/actions/request-position
 * Request position from a destination node
 */
router.post('/request-position', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user?.isAdmin && !(user ? await hasPermission(user, 'messages', 'write') : false)) {
      return res.status(403).json({ success: false, error: 'Insufficient permissions', required: 'messages:write' });
    }

    const destinationNum = resolveDestination(req.body);
    if (!destinationNum) {
      return res.status(400).json({ success: false, error: 'Destination node is required (destination, nodeId, or nodeNum)' });
    }

    const node = await databaseService.nodes.getNode(destinationNum);
    const channel = (typeof req.body.channel === 'number' && req.body.channel >= 0 && req.body.channel <= 7)
      ? req.body.channel
      : (node?.channel ?? 0);

    const { packetId, requestId } = await meshtasticManager.sendPositionRequest(destinationNum, channel);

    // Create system message like the internal endpoint does
    const localNodeInfo = meshtasticManager.getLocalNodeInfo();
    const isBroadcast = destinationNum === 0xFFFFFFFF;

    if (localNodeInfo) {
      const timestamp = Date.now();
      const messageChannel = channel === 0 ? -1 : channel;
      await databaseService.messages.insertMessage({
        id: `${packetId}`,
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
      });
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
    logger.error('[v1/actions] Error requesting position:', error);
    res.status(500).json({ success: false, error: 'Failed to request position' });
  }
});

/**
 * POST /api/v1/actions/request-nodeinfo
 * Request node info exchange (triggers key exchange for DMs)
 */
router.post('/request-nodeinfo', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user?.isAdmin && !(user ? await hasPermission(user, 'messages', 'write') : false)) {
      return res.status(403).json({ success: false, error: 'Insufficient permissions', required: 'messages:write' });
    }

    const destinationNum = resolveDestination(req.body);
    if (!destinationNum) {
      return res.status(400).json({ success: false, error: 'Destination node is required (destination, nodeId, or nodeNum)' });
    }

    const node = await databaseService.nodes.getNode(destinationNum);
    const channel = node?.channel ?? 0;

    const { packetId, requestId } = await meshtasticManager.sendNodeInfoRequest(destinationNum, channel);

    // Create system message like the internal endpoint does
    const localNodeInfo = meshtasticManager.getLocalNodeInfo();

    if (localNodeInfo) {
      const timestamp = Date.now();
      const messageChannel = channel === 0 ? -1 : channel;
      await databaseService.messages.insertMessage({
        id: `${packetId}`,
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
      });
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
    logger.error('[v1/actions] Error requesting nodeinfo:', error);
    res.status(500).json({ success: false, error: 'Failed to request node info' });
  }
});

/**
 * POST /api/v1/actions/request-neighbors
 * Request neighbor info from a node (only local or 0-hop nodes)
 */
const neighborInfoRequestTimestamps = new Map<number, number>();
const NEIGHBOR_INFO_RATE_LIMIT_MS = 180_000;

router.post('/request-neighbors', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user?.isAdmin && !(user ? await hasPermission(user, 'traceroute', 'write') : false)) {
      return res.status(403).json({ success: false, error: 'Insufficient permissions', required: 'traceroute:write' });
    }

    const destinationNum = resolveDestination(req.body);
    if (!destinationNum) {
      return res.status(400).json({ success: false, error: 'Destination node is required (destination, nodeId, or nodeNum)' });
    }

    // Eligibility check: only local node or 0-hop nodes
    const localNodeNum = meshtasticManager.getLocalNodeInfo()?.nodeNum;
    const node = await databaseService.nodes.getNode(destinationNum);
    const isLocalNode = localNodeNum != null && Number(destinationNum) === Number(localNodeNum);
    const isDirectNode = node != null && node.hopsAway != null && Number(node.hopsAway) === 0;

    if (!isLocalNode && !isDirectNode) {
      return res.status(403).json({
        success: false,
        error: 'Neighbor info requests are only allowed for the local node or directly-heard (0-hop) nodes',
      });
    }

    // Rate limiting per destination
    const lastRequest = neighborInfoRequestTimestamps.get(Number(destinationNum));
    const now = Date.now();
    if (lastRequest && (now - lastRequest) < NEIGHBOR_INFO_RATE_LIMIT_MS) {
      const retryAfter = Math.ceil((NEIGHBOR_INFO_RATE_LIMIT_MS - (now - lastRequest)) / 1000);
      return res.status(429).json({
        success: false,
        error: 'Rate limited: firmware limits neighbor info responses to once per 3 minutes',
        retryAfter,
      });
    }

    const channel = node?.channel ?? 0;
    await meshtasticManager.sendNeighborInfoRequest(destinationNum, channel);
    neighborInfoRequestTimestamps.set(Number(destinationNum), now);

    res.json({
      success: true,
      data: {
        destination: `!${destinationNum.toString(16).padStart(8, '0')}`,
        channel,
        message: 'Neighbor info request sent',
      },
    });
  } catch (error) {
    logger.error('[v1/actions] Error requesting neighbor info:', error);
    res.status(500).json({ success: false, error: 'Failed to request neighbor info' });
  }
});

export default router;
