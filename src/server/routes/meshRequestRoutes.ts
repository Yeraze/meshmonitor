import { Router, Request, Response } from 'express';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { parseDestinationNum } from '../utils/parseDestination.js';
import { resolveDestinationChannel, resolveBroadcastChannel, isValidChannelIndex } from '../utils/resolveDestinationChannel.js';
import { PortNum, TransportMechanism } from '../constants/meshtastic.js';
import { fail } from '../utils/apiResponse.js';
import { isTxDisabledError } from '../errors/txDisabledError.js';
import { requireDeviceSourcePermission, getDeviceSourceTarget } from '../utils/deviceSourcePermission.js';
import type { ResourceType } from '../../types/permission.js';

// Every route here transmits through ONE source's radio: the `sourceId` in the
// body, or the primary Meshtastic source when it is omitted. The gate resolves
// that source once, checks the permission on it, and refuses a source with no
// local radio (an MQTT broker/bridge id would otherwise resolve to the PRIMARY
// TCP radio, #5375). Handlers take the manager and source id from
// `getDeviceSourceTarget(req)` and nowhere else.
const meshRequestGate = (resource: ResourceType) =>
  requireDeviceSourcePermission(resource, 'write', 'body', 'mesh requests');

/** Shared error tail of every handler here. Sends nothing to the radio. */
function sendFailure(res: Response, error: unknown, what: string): Response {
  if (isTxDisabledError(error)) {
    return fail(res, 409, 'TX_DISABLED', 'Transmit is disabled on this source');
  }
  logger.error(`Error sending ${what}:`, error);
  if ((error as { message?: string } | null)?.message?.includes('Not connected')) {
    // `error` and `message` keep the wording clients already read.
    return fail(res, 503, 'SOURCE_NOT_CONNECTED', 'Service Unavailable', {
      message: 'Not connected to Meshtastic node',
    });
  }
  return fail(res, 500, 'INTERNAL_ERROR', `Failed to send ${what}`);
}

const router = Router();

router.post('/traceroute', meshRequestGate('traceroute'), async (req: Request, res: Response) => {
  try {
    const { destination } = req.body;
    const { manager: traceManager, sourceId: traceSourceId } = getDeviceSourceTarget(req);
    if (!destination) {
      return fail(res, 400, 'INVALID_INPUT', 'Destination node number is required');
    }

    const destinationNum = await parseDestinationNum(destination, traceSourceId, databaseService);
    if (destinationNum === null) {
      return fail(res, 400, 'INVALID_INPUT', `Invalid destination: ${destination}`);
    }

    // Traceroutes must traverse a channel every intermediate node can decrypt,
    // or those nodes can't append to the route and show up as "Unknown" (issue
    // #3696). A valid explicit user choice (the channel dropdown) wins; otherwise
    // resolve the channel whose PSK is the well-known default key — NOT a
    // hardcoded slot 0, which breaks if the user gave channel 0 a private key.
    // (The node's stored channel is deliberately never used here.)
    const channel = isValidChannelIndex(req.body.channel)
      ? req.body.channel
      : await resolveBroadcastChannel(traceManager, databaseService);
    await traceManager.sendTraceroute(destinationNum, channel);
    res.json({
      success: true,
      message: `Traceroute request sent to ${destinationNum.toString(16)} on channel ${channel}`,
    });
  } catch (error) {
    sendFailure(res, error, 'traceroute');
  }
});

// Position request endpoint
router.post('/position/request', meshRequestGate('messages'), async (req: Request, res: Response) => {
  try {
    const { destination } = req.body;
    const { manager: posManager, sourceId: posSourceId } = getDeviceSourceTarget(req);
    if (!destination) {
      return fail(res, 400, 'INVALID_INPUT', 'Destination node number is required');
    }

    const destinationNum = await parseDestinationNum(destination, posSourceId, databaseService);
    if (destinationNum === null) {
      return fail(res, 400, 'INVALID_INPUT', `Invalid destination: ${destination}`);
    }

    // Scope the channel lookup to the source we actually send through (issue
    // #3573). An explicit, valid (0-7) channel from the request still wins.
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
        // #5101: outbound system row — every outbound message write stamps INTERNAL.
        transportMechanism: TransportMechanism.INTERNAL,
      });
      logger.debug(`📍 Position request system message inserted successfully`);
    } else {
      logger.warn(`⚠️ Could not create system message for position request - localNodeInfo is null`);
    }

    res.json({
      success: true,
      message: `Position request sent to ${destinationNum.toString(16)} on channel ${channel}`,
    });
  } catch (error) {
    sendFailure(res, error, 'position request');
  }
});

// NodeInfo request endpoint (Exchange Node Info - triggers key exchange)
router.post('/nodeinfo/request', meshRequestGate('messages'), async (req: Request, res: Response) => {
  try {
    const { destination } = req.body;
    const { manager: niManager, sourceId: niSourceId } = getDeviceSourceTarget(req);
    if (!destination) {
      return fail(res, 400, 'INVALID_INPUT', 'Destination node number is required');
    }

    const destinationNum = await parseDestinationNum(destination, niSourceId, databaseService);
    if (destinationNum === null) {
      return fail(res, 400, 'INVALID_INPUT', `Invalid destination: ${destination}`);
    }

    // Scope the channel lookup to the source we actually send through (issue
    // #3573). An explicit, valid (0-7) channel from the request (the channel
    // dropdown) wins; otherwise default to the node's stored channel so key
    // repair routes over the shared PSK rather than a PKI DM.
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
        // #5101: outbound system row — every outbound message write stamps INTERNAL.
        transportMechanism: TransportMechanism.INTERNAL,
      });
      logger.debug(`📇 NodeInfo request system message inserted successfully`);
    } else {
      logger.warn(`⚠️ Could not create system message for nodeinfo request - localNodeInfo is null`);
    }

    res.json({
      success: true,
      message: `NodeInfo request sent to ${destinationNum.toString(16)} on channel ${channel}`,
    });
  } catch (error) {
    sendFailure(res, error, 'nodeinfo request');
  }
});

// NeighborInfo request endpoint (request neighbor info from remote node)
// Rate limit: one request per destination every 180 seconds (firmware limit is ~3 minutes)
const neighborInfoRequestTimestamps = new Map<number, number>();
const NEIGHBOR_INFO_RATE_LIMIT_MS = 180_000;

router.post('/neighborinfo/request', meshRequestGate('traceroute'), async (req: Request, res: Response) => {
  try {
    const { destination } = req.body;
    if (!destination) {
      return fail(res, 400, 'INVALID_INPUT', 'Destination node number is required');
    }

    const { manager: neighborManager, sourceId: neighborSourceId } = getDeviceSourceTarget(req);
    const destinationNum = await parseDestinationNum(destination, neighborSourceId, databaseService);
    if (destinationNum === null) {
      return fail(res, 400, 'INVALID_INPUT', `Invalid destination: ${destination}`);
    }

    // Eligibility check: only allow requests to local node or 0-hop nodes
    const localNodeNum = neighborManager.getLocalNodeInfo()?.nodeNum;
    // Scope to the source we actually send through so hopsAway/channel reflect
    // this mesh (issue #3573) — not the request-body sourceId, which may be
    // undefined and cross-source-match a wrong row.
    const node = await databaseService.nodes.getNode(destinationNum, neighborManager.sourceId);
    const isLocalNode = localNodeNum != null && Number(destinationNum) === Number(localNodeNum);
    const isDirectNode = node != null && node.hopsAway != null && Number(node.hopsAway) === 0;

    if (!isLocalNode && !isDirectNode) {
      return fail(
        res, 403, 'NEIGHBOR_INFO_NOT_ELIGIBLE',
        'Neighbor info requests are only allowed for the local node or directly-heard (0-hop) nodes',
        { eligible: false },
      );
    }

    // Rate limiting per destination
    const lastRequest = neighborInfoRequestTimestamps.get(Number(destinationNum));
    const now = Date.now();
    if (lastRequest) {
      if ((now - lastRequest) < NEIGHBOR_INFO_RATE_LIMIT_MS) {
        const retryAfter = Math.ceil((NEIGHBOR_INFO_RATE_LIMIT_MS - (now - lastRequest)) / 1000);
        return fail(
          res, 429, 'RATE_LIMITED',
          'Rate limited: firmware limits neighbor info responses to once per 3 minutes',
          { retryAfter },
        );
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
  } catch (error) {
    sendFailure(res, error, 'neighborinfo request');
  }
});

// Telemetry request endpoint (request telemetry from remote node)
router.post('/telemetry/request', meshRequestGate('messages'), async (req: Request, res: Response) => {
  try {
    const { destination, telemetryType } = req.body;
    const { manager: telManager, sourceId: telSourceId } = getDeviceSourceTarget(req);
    if (!destination) {
      return fail(res, 400, 'INVALID_INPUT', 'Destination node number is required');
    }

    // Validate telemetry type if provided
    const validTypes = ['device', 'environment', 'airQuality', 'power'];
    if (telemetryType && !validTypes.includes(telemetryType)) {
      return fail(res, 400, 'INVALID_INPUT', `Invalid telemetry type. Must be one of: ${validTypes.join(', ')}`);
    }

    const destinationNum = await parseDestinationNum(destination, telSourceId, databaseService);
    if (destinationNum === null) {
      return fail(res, 400, 'INVALID_INPUT', `Invalid destination: ${destination}`);
    }

    // Resolve the manager first, then scope the channel lookup to the source it
    // actually sends through (issue #3573) — not the request-body sourceId, which
    // the frontend often omits and which can cross-source-match an MQTT row whose
    // `channel` (e.g. 101) is not a valid Meshtastic channel index.
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
  } catch (error) {
    sendFailure(res, error, 'telemetry request');
  }
});

export default router;
