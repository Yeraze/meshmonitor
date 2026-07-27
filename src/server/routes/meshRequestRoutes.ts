import { Router, Request, Response } from 'express';
import { requirePermission } from '../auth/authMiddleware.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { resolveSourceManager } from '../utils/resolveSourceManager.js';
import { parseDestinationNum } from '../utils/parseDestination.js';
import { resolveDestinationChannel, resolveBroadcastChannel, isValidChannelIndex } from '../utils/resolveDestinationChannel.js';
import { PortNum } from '../constants/meshtastic.js';
import { fail } from '../utils/apiResponse.js';
import { isTxDisabledError } from '../errors/txDisabledError.js';

const router = Router();

router.post('/traceroute', requirePermission('traceroute', 'write'), async (req: Request, res: Response) => {
  try {
    const { destination, sourceId: traceSourceId } = req.body;
    if (!destination) {
      return res.status(400).json({ error: 'Destination node number is required' });
    }

    const destinationNum = await parseDestinationNum(destination, traceSourceId, databaseService);
    if (destinationNum === null) {
      return res.status(400).json({ error: `Invalid destination: ${destination}` });
    }

    // Traceroutes must traverse a channel every intermediate node can decrypt,
    // or those nodes can't append to the route and show up as "Unknown" (issue
    // #3696). A valid explicit user choice (the channel dropdown) wins; otherwise
    // resolve the channel whose PSK is the well-known default key — NOT a
    // hardcoded slot 0, which breaks if the user gave channel 0 a private key.
    // (The node's stored channel is deliberately never used here.)
    const traceManager = (resolveSourceManager(traceSourceId));
    const channel = isValidChannelIndex(req.body.channel)
      ? req.body.channel
      : await resolveBroadcastChannel(traceManager, databaseService);
    await traceManager.sendTraceroute(destinationNum, channel);
    res.json({
      success: true,
      message: `Traceroute request sent to ${destinationNum.toString(16)} on channel ${channel}`,
    });
  } catch (error: any) {
    if (isTxDisabledError(error)) {
      return fail(res, 409, 'TX_DISABLED', 'Transmit is disabled on this source');
    }
    logger.error('Error sending traceroute:', error);
    if (error?.message?.includes('Not connected')) {
      return res.status(503).json({
        success: false,
        error: 'Service Unavailable',
        message: 'Not connected to Meshtastic node',
      });
    }
    res.status(500).json({ error: 'Failed to send traceroute' });
  }
});

// Position request endpoint
router.post('/position/request', requirePermission('messages', 'write'), async (req: Request, res: Response) => {
  try {
    const { destination, sourceId: posSourceId } = req.body;
    if (!destination) {
      return res.status(400).json({ error: 'Destination node number is required' });
    }

    const destinationNum = await parseDestinationNum(destination, posSourceId, databaseService);
    if (destinationNum === null) {
      return res.status(400).json({ error: `Invalid destination: ${destination}` });
    }

    // Scope the channel lookup to the source we actually send through (issue
    // #3573). An explicit, valid (0-7) channel from the request still wins.
    const posManager = (resolveSourceManager(posSourceId));
    const channel = await resolveDestinationChannel(destinationNum, posManager, databaseService, req.body.channel);
    const { packetId, requestId } = await posManager.sendPositionRequest(destinationNum, channel);

    // Get local node info to create system message
    const localNodeInfo = posManager.getLocalNodeInfo();
    logger.debug(
      `📍 localNodeInfo for system message: ${
        localNodeInfo ? `nodeId=${localNodeInfo.nodeId}, nodeNum=${localNodeInfo.nodeNum}` : 'NULL'
      }`
    );

    const isBroadcast = destinationNum === 0xFFFFFFFF;

    if (localNodeInfo) {
      // Create a system message to record the position request using the actual packet ID and requestId
      const messageId = `${packetId}`;
      const timestamp = Date.now();

      // For DMs (channel 0), store as channel -1 to show in DM conversation
      const messageChannel = channel === 0 ? -1 : channel;

      logger.debug(
        `📍 Inserting position request system message to database: ${messageId} (channel: ${messageChannel}, packetId: ${packetId}, requestId: ${requestId}, broadcast: ${isBroadcast})`
      );
      await databaseService.messages.insertMessage({
        id: messageId,
        fromNodeNum: localNodeInfo.nodeNum,
        toNodeNum: destinationNum,
        fromNodeId: localNodeInfo.nodeId,
        toNodeId: `!${destinationNum.toString(16).padStart(8, '0')}`,
        text: isBroadcast ? 'Position broadcast sent' : 'Position exchange requested',
        channel: messageChannel,
        portnum: PortNum.TEXT_MESSAGE_APP, // Shows in DM view (DM filter requires TEXT_MESSAGE_APP)
        // Broadcast packets don't get ACKed, so omit requestId to avoid permanent pending state
        ...(isBroadcast ? {} : { requestId: requestId }),
        timestamp: timestamp,
        rxTime: timestamp,
        createdAt: timestamp,
        sourceIp: req.ip ?? null,
        sourcePath: 'http_api',
      });
      logger.debug(`📍 Position request system message inserted successfully`);
    } else {
      logger.warn(`⚠️ Could not create system message for position request - localNodeInfo is null`);
    }

    res.json({
      success: true,
      message: `Position request sent to ${destinationNum.toString(16)} on channel ${channel}`,
    });
  } catch (error: any) {
    if (isTxDisabledError(error)) {
      return fail(res, 409, 'TX_DISABLED', 'Transmit is disabled on this source');
    }
    logger.error('Error sending position request:', error);
    if (error?.message?.includes('Not connected')) {
      return res.status(503).json({
        success: false,
        error: 'Service Unavailable',
        message: 'Not connected to Meshtastic node',
      });
    }
    res.status(500).json({ error: 'Failed to send position request' });
  }
});

// NodeInfo request endpoint (Exchange Node Info - triggers key exchange)
router.post('/nodeinfo/request', requirePermission('messages', 'write'), async (req: Request, res: Response) => {
  try {
    const { destination, sourceId: niSourceId } = req.body;
    if (!destination) {
      return res.status(400).json({ error: 'Destination node number is required' });
    }

    const destinationNum = await parseDestinationNum(destination, niSourceId, databaseService);
    if (destinationNum === null) {
      return res.status(400).json({ error: `Invalid destination: ${destination}` });
    }

    // Scope the channel lookup to the source we actually send through (issue
    // #3573). An explicit, valid (0-7) channel from the request (the channel
    // dropdown) wins; otherwise default to the node's stored channel so key
    // repair routes over the shared PSK rather than a PKI DM.
    const niManager = (resolveSourceManager(niSourceId));
    const channel = await resolveDestinationChannel(destinationNum, niManager, databaseService, req.body.channel);
    const { packetId, requestId } = await niManager.sendNodeInfoRequest(destinationNum, channel);

    // Get local node info to create system message
    const localNodeInfo = niManager.getLocalNodeInfo();
    logger.debug(
      `📇 localNodeInfo for system message: ${
        localNodeInfo ? `nodeId=${localNodeInfo.nodeId}, nodeNum=${localNodeInfo.nodeNum}` : 'NULL'
      }`
    );

    if (localNodeInfo) {
      // Create a system message to record the nodeinfo request using the actual packet ID and requestId
      const messageId = `${packetId}`;
      const timestamp = Date.now();

      // For DMs (channel 0), store as channel -1 to show in DM conversation
      const messageChannel = channel === 0 ? -1 : channel;

      logger.debug(
        `📇 Inserting nodeinfo request system message to database: ${messageId} (channel: ${messageChannel}, packetId: ${packetId}, requestId: ${requestId})`
      );
      await databaseService.messages.insertMessage({
        id: messageId,
        fromNodeNum: localNodeInfo.nodeNum,
        toNodeNum: destinationNum,
        fromNodeId: localNodeInfo.nodeId,
        toNodeId: `!${destinationNum.toString(16).padStart(8, '0')}`,
        text: 'User info exchange requested',
        channel: messageChannel,
        portnum: PortNum.TEXT_MESSAGE_APP, // Shows in DM view (DM filter requires TEXT_MESSAGE_APP)
        requestId: requestId, // Store requestId for ACK matching
        timestamp: timestamp,
        rxTime: timestamp,
        createdAt: timestamp,
        sourceIp: req.ip ?? null,
        sourcePath: 'http_api',
      });
      logger.debug(`📇 NodeInfo request system message inserted successfully`);
    } else {
      logger.warn(`⚠️ Could not create system message for nodeinfo request - localNodeInfo is null`);
    }

    res.json({
      success: true,
      message: `NodeInfo request sent to ${destinationNum.toString(16)} on channel ${channel}`,
    });
  } catch (error: any) {
    if (isTxDisabledError(error)) {
      return fail(res, 409, 'TX_DISABLED', 'Transmit is disabled on this source');
    }
    logger.error('Error sending nodeinfo request:', error);
    if (error?.message?.includes('Not connected')) {
      return res.status(503).json({
        success: false,
        error: 'Service Unavailable',
        message: 'Not connected to Meshtastic node',
      });
    }
    res.status(500).json({ error: 'Failed to send nodeinfo request' });
  }
});

// NeighborInfo request endpoint (request neighbor info from remote node)
// Rate limit: one request per destination every 180 seconds (firmware limit is ~3 minutes)
const neighborInfoRequestTimestamps = new Map<number, number>();
const NEIGHBOR_INFO_RATE_LIMIT_MS = 180_000;

router.post('/neighborinfo/request', requirePermission('traceroute', 'write'), async (req: Request, res: Response) => {
  try {
    const { destination } = req.body;
    if (!destination) {
      return res.status(400).json({ error: 'Destination node number is required' });
    }

    const { sourceId: neighborSourceId } = req.body;
    const destinationNum = await parseDestinationNum(destination, neighborSourceId, databaseService);
    if (destinationNum === null) {
      return res.status(400).json({ error: `Invalid destination: ${destination}` });
    }

    // Eligibility check: only allow requests to local node or 0-hop nodes
    const neighborManager = (resolveSourceManager(neighborSourceId));
    const localNodeNum = neighborManager.getLocalNodeInfo()?.nodeNum;
    // Scope to the source we actually send through so hopsAway/channel reflect
    // this mesh (issue #3573) — not the request-body sourceId, which may be
    // undefined and cross-source-match a wrong row.
    const node = await databaseService.nodes.getNode(destinationNum, neighborManager.sourceId);
    const isLocalNode = localNodeNum != null && Number(destinationNum) === Number(localNodeNum);
    const isDirectNode = node != null && node.hopsAway != null && Number(node.hopsAway) === 0;

    if (!isLocalNode && !isDirectNode) {
      return res.status(403).json({
        error: 'Neighbor info requests are only allowed for the local node or directly-heard (0-hop) nodes',
        eligible: false,
      });
    }

    // Rate limiting per destination
    const lastRequest = neighborInfoRequestTimestamps.get(Number(destinationNum));
    const now = Date.now();
    if (lastRequest) {
      if ((now - lastRequest) < NEIGHBOR_INFO_RATE_LIMIT_MS) {
        const retryAfter = Math.ceil((NEIGHBOR_INFO_RATE_LIMIT_MS - (now - lastRequest)) / 1000);
        return res.status(429).json({
          error: 'Rate limited: firmware limits neighbor info responses to once per 3 minutes',
          retryAfter,
        });
      }
      // Expired entry — clean up
      neighborInfoRequestTimestamps.delete(Number(destinationNum));
    }

    // node is already scoped to neighborManager.sourceId above; reuse its channel
    // (passed as explicitChannel) so we don't re-query the same row, while still
    // clamping any out-of-range value to a valid index.
    const channel = await resolveDestinationChannel(destinationNum, neighborManager, databaseService, node?.channel);

    const { packetId, requestId } = await neighborManager.sendNeighborInfoRequest(destinationNum, channel);
    neighborInfoRequestTimestamps.set(Number(destinationNum), now);

    logger.debug(`🏠 NeighborInfo request sent to ${destinationNum.toString(16)} on channel ${channel}, packetId=${packetId}, requestId=${requestId}`);

    res.json({
      success: true,
      message: `NeighborInfo request sent to ${destinationNum.toString(16)} on channel ${channel}`,
      packetId,
      requestId
    });
  } catch (error: any) {
    if (isTxDisabledError(error)) {
      return fail(res, 409, 'TX_DISABLED', 'Transmit is disabled on this source');
    }
    logger.error('Error sending neighborinfo request:', error);
    if (error?.message?.includes('Not connected')) {
      return res.status(503).json({
        success: false,
        error: 'Service Unavailable',
        message: 'Not connected to Meshtastic node',
      });
    }
    res.status(500).json({ error: 'Failed to send neighborinfo request' });
  }
});

// Telemetry request endpoint (request telemetry from remote node)
router.post('/telemetry/request', requirePermission('messages', 'write'), async (req: Request, res: Response) => {
  try {
    const { destination, telemetryType, sourceId: telSourceId } = req.body;
    if (!destination) {
      return res.status(400).json({ error: 'Destination node number is required' });
    }

    // Validate telemetry type if provided
    const validTypes = ['device', 'environment', 'airQuality', 'power'];
    if (telemetryType && !validTypes.includes(telemetryType)) {
      return res.status(400).json({ error: `Invalid telemetry type. Must be one of: ${validTypes.join(', ')}` });
    }

    const destinationNum = await parseDestinationNum(destination, telSourceId, databaseService);
    if (destinationNum === null) {
      return res.status(400).json({ error: `Invalid destination: ${destination}` });
    }

    // Resolve the manager first, then scope the channel lookup to the source it
    // actually sends through (issue #3573) — not the request-body sourceId, which
    // the frontend often omits and which can cross-source-match an MQTT row whose
    // `channel` (e.g. 101) is not a valid Meshtastic channel index.
    const telManager = (resolveSourceManager(telSourceId));
    const channel = await resolveDestinationChannel(destinationNum, telManager, databaseService);

    const { packetId, requestId } = await telManager.sendTelemetryRequest(
      destinationNum,
      channel,
      telemetryType as 'device' | 'environment' | 'airQuality' | 'power' | undefined
    );

    const typeLabel = telemetryType || 'device';
    logger.debug(`📊 Telemetry request (${typeLabel}) sent to ${destinationNum.toString(16)} on channel ${channel}, packetId=${packetId}, requestId=${requestId}`);

    res.json({
      success: true,
      message: `Telemetry request (${typeLabel}) sent to ${destinationNum.toString(16)} on channel ${channel}`,
      packetId,
      requestId
    });
  } catch (error: any) {
    if (isTxDisabledError(error)) {
      return fail(res, 409, 'TX_DISABLED', 'Transmit is disabled on this source');
    }
    logger.error('Error sending telemetry request:', error);
    if (error?.message?.includes('Not connected')) {
      return res.status(503).json({
        success: false,
        error: 'Service Unavailable',
        message: 'Not connected to Meshtastic node',
      });
    }
    res.status(500).json({ error: 'Failed to send telemetry request' });
  }
});

export default router;
