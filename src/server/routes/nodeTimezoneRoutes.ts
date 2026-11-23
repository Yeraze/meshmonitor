/**
 * Per-node timezone (#6523), shared by Meshtastic (`!hex`) and MeshCore
 * (64-hex public key) nodes.
 *
 *   GET /api/nodes/timezone?sourceId=&nodeId=
 *     The node's display zone and where it came from. Same read gate as the
 *     node's telemetry graphs; the position gate decides between the node's
 *     zone and the server zone (see `resolveNodeTimezone`).
 *
 *   PUT /api/nodes/timezone  { sourceId, nodeId, timeZone: string | null }
 *     Set or clear (`null`) the Timezone Override. Same permission as the
 *     Position Override: `nodes:write` on that source, signed in.
 */
import { Router, Request, Response } from 'express';
import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { requireAuth, requirePermission } from '../auth/authMiddleware.js';
import { requireSourceId } from '../utils/requireSourceId.js';
import { ok, fail } from '../utils/apiResponse.js';
import { canReadNodeTelemetry, isMeshCoreNodeId } from '../utils/nodeVisiblePosition.js';
import { normalizeTimeZone, resolveNodeTimezone } from '../utils/nodeTimezone.js';
import { isValidNodeNum } from '../constants/meshtastic.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { isMeshCoreManager } from '../sourceManagerTypes.js';

const router = Router();

// `!` required: checkNodeChannelAccess reads an unprefixed id as DECIMAL
// while the resolver reads hex, so the two gates must see the same node.
const MESHTASTIC_ID = /^![0-9a-fA-F]{8}$/;

function validNodeId(nodeId: unknown): nodeId is string {
  return typeof nodeId === 'string' && (isMeshCoreNodeId(nodeId) || MESHTASTIC_ID.test(nodeId));
}

/**
 * A MeshCore contact known only to a device source's live contact list gets
 * its identity row first, as the Position Override route does, so the
 * override does not land on a nameless stub. Unknown keys stay unknown (404).
 */
async function ensureMeshCoreRow(sourceId: string, publicKey: string, asSent: string): Promise<void> {
  if (await databaseService.meshcore.getNodeByPublicKeyAndSource(publicKey, sourceId)) return;
  const mgr = sourceManagerRegistry.getManager(sourceId);
  // The live contact map is keyed exactly as the radio reported the key.
  const contact = mgr && isMeshCoreManager(mgr) ? mgr.getContact(publicKey) ?? mgr.getContact(asSent) : undefined;
  if (!contact) return;
  await databaseService.meshcore.upsertNode(
    {
      publicKey,
      name: contact.advName ?? contact.name ?? null,
      advType: contact.advType ?? null,
      lastHeard: contact.lastSeen ?? null,
    },
    sourceId,
  );
}

router.get('/', requireSourceId('query'), async (req: Request, res: Response) => {
  try {
    const sourceId = req.query.sourceId as string;
    const nodeId = req.query.nodeId;
    if (!validNodeId(nodeId)) {
      return fail(res, 400, 'INVALID_NODE_ID', 'nodeId must be !XXXXXXXX or a 64-character public key');
    }
    if (!await canReadNodeTelemetry(req.user, sourceId, nodeId)) {
      return fail(res, 403, 'FORBIDDEN', 'Insufficient permissions');
    }
    return ok(res, await resolveNodeTimezone(req.user, sourceId, nodeId));
  } catch (error) {
    logger.error('Error resolving node timezone:', error);
    return fail(res, 500, 'INTERNAL_ERROR', 'Failed to resolve node timezone');
  }
});

router.put(
  '/',
  requireAuth(),
  requirePermission('nodes', 'write', { sourceIdFrom: 'body', requireSourceId: true }),
  async (req: Request, res: Response) => {
    try {
      const { sourceId, nodeId, timeZone } = (req.body ?? {}) as { sourceId: string; nodeId?: unknown; timeZone?: unknown };
      if (!validNodeId(nodeId)) {
        return fail(res, 400, 'INVALID_NODE_ID', 'nodeId must be !XXXXXXXX or a 64-character public key');
      }
      let zone: string | null = null;
      if (timeZone !== null) {
        zone = normalizeTimeZone(timeZone);
        if (!zone) return fail(res, 400, 'INVALID_TIMEZONE', 'timeZone must be an IANA time zone name or null');
      }

      let updated: boolean;
      if (isMeshCoreNodeId(nodeId)) {
        const publicKey = nodeId.toLowerCase();
        await ensureMeshCoreRow(sourceId, publicKey, nodeId);
        updated = await databaseService.setMeshCoreNodeTimezoneOverrideAsync(sourceId, publicKey, zone);
      } else {
        const nodeNum = parseInt(nodeId.replace('!', ''), 16);
        updated = isValidNodeNum(nodeNum) && await databaseService.setNodeTimezoneOverrideAsync(nodeNum, sourceId, zone);
      }
      if (!updated) return fail(res, 404, 'NODE_NOT_FOUND', 'Node not found on this source');

      return ok(res, await resolveNodeTimezone(req.user, sourceId, nodeId));
    } catch (error) {
      logger.error('Error setting node timezone override:', error);
      return fail(res, 500, 'INTERNAL_ERROR', 'Failed to set node timezone override');
    }
  },
);

export default router;
