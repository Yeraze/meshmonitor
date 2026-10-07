/**
 * Status endpoint
 *
 * Returns local node identity and connection status.
 * Used by API clients to identify the "self" node.
 */

import express, { Request, Response } from 'express';
import databaseService from '../../../services/database.js';
import { resolveOwnMeshtasticManager } from '../../utils/resolveSourceManager.js';
import { sourceManagerRegistry } from '../../sourceManagerRegistry.js';
import { logger } from '../../../utils/logger.js';
import { loadV1Access, requireScopedSourceId } from './sourceParam.js';

const router = express.Router({ mergeParams: true });

// What each caller gets, for the source in the path (the rule `/api/status`
// applies to the primary source):
//
//   - any token past the `info:read` gate: `connected` and `nodeResponsive`,
//     THIS source's link state.
//   - `nodes:read` on this source (or admin): the local node's number, id and
//     names. Null otherwise. `info` is an install-wide permission, so it alone
//     does not show a source's node identity.
//
// The link state and the node are this source's own. A source with no
// Meshtastic device (MQTT, MeshCore) used to answer with the PRIMARY source's
// node and link.
router.get('/', async (req: Request, res: Response) => {
  try {
    // The :sourceId path param, resolved by attachSource (incl. the `default`
    // alias) on the /sources/:sourceId mount.
    const sourceId = requireScopedSourceId(req, res);
    if (!sourceId) return;
    const access = await loadV1Access(req);

    const ownManager = resolveOwnMeshtasticManager(sourceId);
    let connected: boolean;
    let nodeResponsive: boolean;
    if (ownManager) {
      const connectionStatus = await ownManager.getConnectionStatus();
      connected = connectionStatus.connected;
      nodeResponsive = connectionStatus.nodeResponsive;
    } else {
      connected = sourceManagerRegistry.getManager(sourceId)?.getStatus().connected === true;
      nodeResponsive = connected;
    }

    let localNodeNum: number | null = null;
    let longName: string | null = null;
    let shortName: string | null = null;

    if (access.permissions.can('nodes', 'read', sourceId)) {
      // Per-source local node (#5377): the bare 'localNodeNum' key only ever
      // held the legacy `default` source's node.
      const stored = await databaseService.settings.getLocalNodeNumForSource(sourceId);
      localNodeNum = stored ? Number(stored) : null;
      if (localNodeNum) {
        const node = await databaseService.nodes.getNode(localNodeNum, sourceId);
        if (node) {
          longName = node.longName || null;
          shortName = node.shortName || null;
        }
      }
    }

    res.json({
      success: true,
      data: {
        localNodeNum,
        localNodeId: localNodeNum ? `!${localNodeNum.toString(16).padStart(8, '0')}` : null,
        longName,
        shortName,
        connected,
        nodeResponsive,
      }
    });
  } catch (err) {
    logger.error('[v1/status] Error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

export default router;
