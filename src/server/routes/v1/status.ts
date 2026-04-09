/**
 * Status endpoint
 *
 * Returns local node identity and connection status.
 * Used by API clients to identify the "self" node.
 */

import express from 'express';
import databaseService from '../../../services/database.js';
import meshtasticManager from '../../meshtasticManager.js';
import { sourceManagerRegistry } from '../../sourceManagerRegistry.js';
import { logger } from '../../../utils/logger.js';

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const statusSourceId = req.query.sourceId as string | undefined;
    const statusManager = statusSourceId ? (sourceManagerRegistry.getManager(statusSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager;

    const localNodeNum = await databaseService.settings.getSetting('localNodeNum');
    const localNodeId = await databaseService.settings.getSetting('localNodeId');
    const connectionStatus = await statusManager.getConnectionStatus();

    let longName: string | null = null;
    let shortName: string | null = null;

    if (localNodeNum) {
      const node = await databaseService.nodes.getNode(Number(localNodeNum));
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
