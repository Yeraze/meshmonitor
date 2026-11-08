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
 *   request-telemetry                  → messages:write (both protocols)
 *
 * MeshCore sources (#6263): `traceroute` and `request-telemetry` also run on a
 * device-backed MeshCore source (destination `mc:<publicKey>` or 64-hex). They
 * share the UI's `meshcoreDeviceLimiter` bucket and its 60 s per-source TX gate.
 * The other actions answer 400 SOURCE_NOT_MESHTASTIC there.
 */

import express, { Request, Response } from 'express';
import databaseService from '../../../services/database.js';
import { resolveSourceManager } from '../../utils/resolveSourceManager.js';
import { refuseNonMeshtasticSource } from '../../utils/requireMeshtasticDeviceSource.js';
import { logger } from '../../../utils/logger.js';
import { PortNum, TransportMechanism } from '../../constants/meshtastic.js';
import { attachSource, resolvedSourceIdFromPath } from './sourceParam.js';
import { isTxDisabledError } from '../../errors/txDisabledError.js';
import { resolveBroadcastChannel, isValidChannelIndex } from '../../utils/resolveDestinationChannel.js';
import { resolveTransmitTarget } from '../../utils/transmitTarget.js';
import { parseMeshcoreNodeId } from '../../utils/protocolRows.js';
import { ok, fail } from '../../utils/apiResponse.js';
import { protocolLimiter, meshcoreDeviceLimiter } from '../../middleware/rateLimiters.js';
import { MeshCoreDeviceType } from '../../meshcoreManager.js';
import { isAnyMeshCoreSourceType } from '../../../utils/nodeTypeCategory.js';
import { requestMeshtasticTelemetry } from '../meshRequestRoutes.js';
import { pollMeshCoreNodeTelemetry } from '../meshcoreContactsRoutes.js';

const router = express.Router({ mergeParams: true });

const isMeshCoreSource = (req: Request): boolean =>
  isAnyMeshCoreSourceType((req as Request & { source?: { type?: string } }).source?.type);

/** Same limiter instances the UI uses, so v1 and UI share one bucket per IP. */
const deviceLimit = protocolLimiter({ meshcore: meshcoreDeviceLimiter });

/**
 * Resolve the MeshCore target of a v1 action: the destination public key and a
 * manager that may transmit. Sends the refusal itself and returns null when it
 * cannot. Order: 400 bad destination, 400/404/409 source refusal, 409
 * TX_DISABLED, 503 not connected.
 */
async function resolveMeshCoreAction(req: Request, res: Response, sourceId: string) {
  const raw = req.body?.destination ?? req.body?.nodeId ?? req.body?.nodeNum;
  const publicKey = typeof raw === 'string' ? parseMeshcoreNodeId(raw) : null;
  if (!publicKey) {
    fail(res, 400, 'INVALID_DESTINATION', 'A MeshCore destination is required (destination or nodeId as mc:<publicKey> or 64-char hex)');
    return null;
  }
  const target = await resolveTransmitTarget(sourceId);
  if (target.kind === 'refused') {
    fail(res, target.status, target.code, target.message);
    return null;
  }
  if (target.kind !== 'meshcore') {
    fail(res, 400, 'SOURCE_NOT_MESHCORE', 'Source is not a MeshCore source');
    return null;
  }
  const manager = target.manager;
  if (manager.isReceiveOnly()) {
    fail(res, 409, 'TX_DISABLED', 'Transmit is disabled on this source');
    return null;
  }
  if (!manager.isConnected()) {
    fail(res, 503, 'SOURCE_NOT_CONNECTED', 'MeshCore source is not connected');
    return null;
  }
  return { publicKey, manager };
}

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

router.post('/traceroute', attachSource('traceroute', 'write'), deviceLimit, async (req: Request, res: Response) => {
  try {
    const sourceId = resolvedSourceIdFromPath(req) as string;
    if (isMeshCoreSource(req)) {
      // Fire-and-forget (#6263 decision 4): check what the manager would check,
      // answer 200, run the trace in the background. The result lands in
      // /traceroutes via the hop-SNR store. Never auto-returns, never retries.
      const target = await resolveMeshCoreAction(req, res, sourceId);
      if (!target) return;
      const { publicKey, manager } = target;
      if (manager.getConnectionStatus().deviceType !== MeshCoreDeviceType.COMPANION || !manager.getContact(publicKey)) {
        return fail(res, 409, 'MESHCORE_TRACE_FAILED',
          'Trace failed: the source must be a Companion device and the contact must be known');
      }
      void manager.traceContactPathDetailed(publicKey, { autoReturn: false }).catch((err: unknown) => {
        logger.warn(`[v1/actions] MeshCore trace to ${publicKey.slice(0, 16)}… failed:`, err);
      });
      return ok(res, {
        destination: `mc:${publicKey}`,
        channel: null,
        message: 'Traceroute request sent',
        protocol: 'meshcore',
      });
    }
    const destinationNum = resolveDestination(req.body);
    if (destinationNum === null) {
      return res.status(400).json({ success: false, error: 'Destination node is required (destination, nodeId, or nodeNum)' });
    }

    // No primary-radio fallback for MQTT/other non-Meshtastic sources (#5375).
    if (await refuseNonMeshtasticSource(res, sourceId, 'mesh requests')) return;
    const manager = resolveSourceManager(sourceId);
    // Traceroutes must traverse a channel every intermediate node can decrypt
    // and relay, or those nodes can't append to the route and show up as
    // "Unknown" (issue #3696, #4691). A valid explicit channel wins; otherwise
    // resolve the well-known channel the whole mesh shares — never the
    // target's raw stored channel, which may be a private secondary.
    const channel = isValidChannelIndex(req.body.channel)
      ? req.body.channel
      : await resolveBroadcastChannel(manager, databaseService);

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

    // No primary-radio fallback for MQTT/other non-Meshtastic sources (#5375).
    if (await refuseNonMeshtasticSource(res, sourceId, 'mesh requests')) return;
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
          // #5101: outbound system row — every outbound message write stamps INTERNAL.
          transportMechanism: TransportMechanism.INTERNAL,
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

    // No primary-radio fallback for MQTT/other non-Meshtastic sources (#5375).
    if (await refuseNonMeshtasticSource(res, sourceId, 'mesh requests')) return;
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
          // #5101: outbound system row — every outbound message write stamps INTERNAL.
          transportMechanism: TransportMechanism.INTERNAL,
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

// POST /request-telemetry ──────────────────────────────────────────────────────

/**
 * Meshtastic: `type` is device | environment | airQuality | power (default
 * device). MeshCore: `type` is status | lpp (required), gated by the per-source
 * 60 s TX gate; inside it the answer is 429 with Retry-After.
 */
router.post('/request-telemetry', attachSource('messages', 'write'), deviceLimit, async (req: Request, res: Response) => {
  try {
    const sourceId = resolvedSourceIdFromPath(req) as string;
    const type = req.body?.type ?? req.body?.telemetryType;

    if (isMeshCoreSource(req)) {
      if (type !== 'status' && type !== 'lpp') {
        return fail(res, 400, 'INVALID_INPUT', "type must be 'status' or 'lpp' on a MeshCore source");
      }
      const target = await resolveMeshCoreAction(req, res, sourceId);
      if (!target) return;
      const outcome = await pollMeshCoreNodeTelemetry({
        manager: target.manager, sourceId, publicKey: target.publicKey, type,
      });
      if (outcome.kind === 'not_connected') {
        return fail(res, 503, 'SOURCE_NOT_CONNECTED', 'MeshCore source is not connected');
      }
      if (outcome.kind === 'scheduler_unavailable') {
        return fail(res, 503, 'TELEMETRY_UNAVAILABLE', 'Telemetry scheduler unavailable');
      }
      if (outcome.kind === 'rate_limited') {
        res.set('Retry-After', String(outcome.retryAfterSecs));
        return fail(res, 429, 'RATE_LIMITED',
          `Too soon since last mesh transmission; retry in ${outcome.retryAfterSecs}s`,
          { retryAfter: outcome.retryAfterSecs });
      }
      return ok(res, {
        destination: `mc:${target.publicKey}`,
        type,
        written: outcome.written,
        sources: outcome.sources,
        message: 'Telemetry request sent',
        protocol: 'meshcore',
      });
    }

    const destinationNum = resolveDestination(req.body);
    if (destinationNum === null) {
      return res.status(400).json({ success: false, error: 'Destination node is required (destination, nodeId, or nodeNum)' });
    }
    if (await refuseNonMeshtasticSource(res, sourceId, 'mesh requests')) return;
    const result = await requestMeshtasticTelemetry({
      manager: resolveSourceManager(sourceId),
      sourceId,
      destination: destinationNum,
      telemetryType: type,
    });
    if (result.kind === 'invalid') {
      return fail(res, 400, 'INVALID_INPUT', result.message);
    }
    return ok(res, {
      destination: `!${destinationNum.toString(16).padStart(8, '0')}`,
      channel: result.channel,
      type: result.typeLabel,
      message: 'Telemetry request sent',
      protocol: 'meshtastic',
    });
  } catch (error) {
    if (isTxDisabledError(error)) {
      return res.status(409).json({ success: false, error: 'Transmit is disabled on this source', code: 'TX_DISABLED' });
    }
    if ((error as { message?: string } | null)?.message?.includes('Not connected')) {
      return fail(res, 503, 'SOURCE_NOT_CONNECTED', 'Not connected to node');
    }
    logger.error('[v1/actions] Error requesting telemetry:', error);
    res.status(500).json({ success: false, error: 'Failed to request telemetry' });
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

    // No primary-radio fallback for MQTT/other non-Meshtastic sources (#5375).
    if (await refuseNonMeshtasticSource(res, sourceId, 'mesh requests')) return;
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
