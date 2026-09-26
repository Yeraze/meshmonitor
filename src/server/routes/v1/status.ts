/**
 * Status endpoint
 *
 * Returns local node identity and connection status.
 * Used by API clients to identify the "self" node.
 */

import express, { Request, Response } from 'express';
import databaseService from '../../../services/database.js';
import { resolveSourceManager } from '../../utils/resolveSourceManager.js';
import { logger } from '../../../utils/logger.js';
import { resolvedSourceIdFromPath } from './sourceParam.js';

const router = express.Router({ mergeParams: true });

router.get('/', async (req: Request, res: Response) => {
  try {
    // Scope to the :sourceId path param (resolved by attachSource, incl. the
    // `default` alias) on the /sources/:sourceId mount.
    const statusSourceId = resolvedSourceIdFromPath(req);
    const statusManager = resolveSourceManager(statusSourceId);

    // Per-source local node (#5377): the bare 'localNodeNum' key only ever
    // held the legacy `default` source's node.
    const localNodeNum = await databaseService.settings.getLocalNodeNumForSource(statusManager.sourceId);
    const localNodeId = localNodeNum
      ? `!${Number(localNodeNum).toString(16).padStart(8, '0')}`
      : null;
    const connectionStatus = await statusManager.getConnectionStatus();

    let longName: string | null = null;
    let shortName: string | null = null;

    if (localNodeNum) {
      const node = await databaseService.nodes.getNode(Number(localNodeNum), statusManager.sourceId);
      if (node) {
        longName = node.longName || null;
        shortName = node.shortName || null;
      }
    }

    res.json({
      success: true,
      data: {
        localNodeNum: localNodeNum ? Number(localNodeNum) : null,
        localNodeId: localNodeId || null,
        longName,
        shortName,
        connected: connectionStatus.connected,
        nodeResponsive: connectionStatus.nodeResponsive,
      }
    });
  } catch (err) {
    logger.error('[v1/status] Error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

export default router;
