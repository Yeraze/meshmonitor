import { Router, Request, Response } from 'express';
import { requirePermission } from '../auth/authMiddleware.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { getEffectiveDbNodePosition } from '../utils/nodeEnhancer.js';

const router = Router();

router.get('/', requirePermission('info', 'read'), async (req: Request, res: Response) => {
  try {
    const neighborInfoSourceId = req.query.sourceId as string | undefined;
    const neighborInfo = await databaseService.getLatestNeighborInfoPerNodeScopedAsync(neighborInfoSourceId);

    const maxNodeAgeStr = await databaseService.settings.getSetting('maxNodeAge');
    const maxNodeAgeHours = maxNodeAgeStr ? parseInt(maxNodeAgeStr, 10) : 24;
    const cutoffTime = Math.floor(Date.now() / 1000) - maxNodeAgeHours * 60 * 60;

    const linkKeys = new Set(neighborInfo.map(ni => `${ni.nodeNum}-${ni.neighborNodeNum}`));

    const enrichedNeighborInfo = (await Promise.all(neighborInfo
      .map(async ni => {
        const node = await databaseService.nodes.getNode(ni.nodeNum, neighborInfoSourceId);
        const neighbor = await databaseService.nodes.getNode(ni.neighborNodeNum, neighborInfoSourceId);
        const nodePos = getEffectiveDbNodePosition(node);
        const neighborPos = getEffectiveDbNodePosition(neighbor);

        return {
          ...ni,
          nodeId: node?.nodeId || `!${ni.nodeNum.toString(16).padStart(8, '0')}`,
          nodeName: node?.longName || `Node !${ni.nodeNum.toString(16).padStart(8, '0')}`,
          neighborNodeId: neighbor?.nodeId || `!${ni.neighborNodeNum.toString(16).padStart(8, '0')}`,
          neighborName: neighbor?.longName || `Node !${ni.neighborNodeNum.toString(16).padStart(8, '0')}`,
          bidirectional: linkKeys.has(`${ni.neighborNodeNum}-${ni.nodeNum}`),
          nodeLatitude: nodePos.latitude,
          nodeLongitude: nodePos.longitude,
          neighborLatitude: neighborPos.latitude,
          neighborLongitude: neighborPos.longitude,
          node,
          neighbor,
        };
      })))
      .filter(ni => {
        // Report-time freshness: show a neighbor edge only when its NeighborInfo
        // *report* falls within the window, matching the Map Analysis
        // "Neighbors" layer (which filters on the record `timestamp`). See the
        // longer note on GET /api/sources/:id/neighbor-info in sourceRoutes.ts.
        // Keying off the record timestamp keeps indirect-neighbor links whose
        // neighbor row has a null `lastHeard` (#3025/#2615).
        const reportSec = Math.floor((ni.timestamp ?? 0) / 1000);
        return reportSec >= cutoffTime;
      })
      .map(({ node, neighbor, ...rest }) => rest);

    res.json(enrichedNeighborInfo);
  } catch (error) {
    logger.error('Error fetching neighbor info:', error);
    res.status(500).json({ error: 'Failed to fetch neighbor info' });
  }
});

router.get('/:nodeNum', requirePermission('info', 'read'), async (req: Request, res: Response) => {
  try {
    const nodeNum = parseInt(req.params.nodeNum);
    const neighborSourceId = req.query.sourceId as string | undefined;
    const neighborInfo = await databaseService.getNeighborsForNodeAsync(nodeNum, neighborSourceId);

    const enrichedNeighborInfo = await Promise.all(neighborInfo.map(async ni => {
      const neighbor = await databaseService.nodes.getNode(ni.neighborNodeNum, neighborSourceId);
      const neighborPos = getEffectiveDbNodePosition(neighbor);

      return {
        ...ni,
        neighborNodeId: neighbor?.nodeId || `!${ni.neighborNodeNum.toString(16).padStart(8, '0')}`,
        neighborName: neighbor?.longName || `Node !${ni.neighborNodeNum.toString(16).padStart(8, '0')}`,
        neighborLatitude: neighborPos.latitude,
        neighborLongitude: neighborPos.longitude,
      };
    }));

    res.json(enrichedNeighborInfo);
  } catch (error) {
    logger.error('Error fetching neighbor info for node:', error);
    res.status(500).json({ error: 'Failed to fetch neighbor info for node' });
  }
});

export default router;
