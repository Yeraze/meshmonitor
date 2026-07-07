import { Router, Request, Response } from 'express';
import { requireAdmin } from '../auth/authMiddleware.js';
import databaseService from '../../services/database.js';
import { ALL_SOURCES } from '../../db/repositories/index.js';
import { logger } from '../../utils/logger.js';
import { resolveSourceManager } from '../utils/resolveSourceManager.js';

const router = Router();

router.use(requireAdmin());

router.post('/nodes', async (req: Request, res: Response) => {
  try {
    const { sourceId: purgeNodesSourceId } = req.body || {};
    // intentional cross-source: purge stats reflect global total before wipe
    const nodeCount = await databaseService.nodes.getNodeCount(ALL_SOURCES);
    await databaseService.purgeAllNodesAsync(purgeNodesSourceId);
    const purgeNodesManager = resolveSourceManager(purgeNodesSourceId);
    await purgeNodesManager.refreshNodeDatabase();

    void databaseService.auditLogAsync(
      req.user!.id,
      'nodes_purged',
      'nodes',
      JSON.stringify({ count: nodeCount, sourceId: purgeNodesSourceId ?? null }),
      req.ip || null
    );

    res.json({
      success: true,
      message: purgeNodesSourceId
        ? `Nodes and traceroutes purged for source ${purgeNodesSourceId}, refresh triggered`
        : 'All nodes and traceroutes purged, refresh triggered',
    });
  } catch (error) {
    logger.error('Error purging nodes:', error);
    res.status(500).json({ error: 'Failed to purge nodes' });
  }
});

router.post('/telemetry', async (req: Request, res: Response) => {
  try {
    const { sourceId: purgeTelemetrySourceId } = req.body || {};
    await databaseService.purgeAllTelemetryAsync(purgeTelemetrySourceId);

    void databaseService.auditLogAsync(
      req.user!.id,
      'telemetry_purged',
      'telemetry',
      JSON.stringify({ sourceId: purgeTelemetrySourceId ?? null }),
      req.ip || null
    );

    res.json({
      success: true,
      message: purgeTelemetrySourceId
        ? `Telemetry purged for source ${purgeTelemetrySourceId}`
        : 'All telemetry data purged',
    });
  } catch (error) {
    logger.error('Error purging telemetry:', error);
    res.status(500).json({ error: 'Failed to purge telemetry' });
  }
});

router.post('/messages', async (req: Request, res: Response) => {
  try {
    // intentional cross-source: message purge is a global operation across all sources
    const messageCount = await databaseService.messages.getMessageCount(ALL_SOURCES);
    await databaseService.messages.deleteAllMessages(ALL_SOURCES);

    void databaseService.auditLogAsync(
      req.user!.id,
      'messages_purged',
      'messages',
      JSON.stringify({ count: messageCount }),
      req.ip || null
    );

    res.json({ success: true, message: 'All messages purged' });
  } catch (error) {
    logger.error('Error purging messages:', error);
    res.status(500).json({ error: 'Failed to purge messages' });
  }
});

router.post('/traceroutes', async (req: Request, res: Response) => {
  try {
    await databaseService.traceroutes.deleteAllTraceroutes();
    await databaseService.traceroutes.deleteAllRouteSegments();

    void databaseService.auditLogAsync(
      req.user!.id,
      'traceroutes_purged',
      'traceroute',
      'All traceroutes and route segments purged',
      req.ip || null
    );

    res.json({ success: true, message: 'All traceroutes and route segments purged' });
  } catch (error) {
    logger.error('Error purging traceroutes:', error);
    res.status(500).json({ error: 'Failed to purge traceroutes' });
  }
});

export default router;
