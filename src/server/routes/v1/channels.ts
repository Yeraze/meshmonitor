/**
 * v1 API - Channels Endpoint
 *
 * Provides read-only access to mesh network channel configuration
 * Respects user permissions - only returns channels the user has read access to
 */

import express, { Request, Response } from 'express';
import databaseService from '../../../services/database.js';
import { logger } from '../../../utils/logger.js';
import { ResourceType } from '../../../types/permission.js';
import { transformChannel } from '../../utils/channelView.js';

const router = express.Router({ mergeParams: true });

/** Resolve sourceId from path (new /sources/:sourceId mount) or query (legacy). */
function getScopedSourceId(req: Request): string | undefined {
  const fromPath = typeof req.params.sourceId === 'string' ? req.params.sourceId : undefined;
  if (fromPath) return fromPath;
  const fromQuery = typeof req.query.sourceId === 'string' ? req.query.sourceId : undefined;
  return fromQuery;
}

/**
 * GET /api/v1/channels
 * Get all channels in the mesh network
 * Only returns channels the user has read permission for
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const userId = user?.id ?? null;
    const isAdmin = user?.isAdmin ?? false;
    const sourceIdQ = getScopedSourceId(req);

    // Get all channels (scoped to source if provided)
    const allChannels = await databaseService.channels.getAllChannels(sourceIdQ);

    // If admin, return all channels
    if (isAdmin) {
      return res.json({
        success: true,
        count: allChannels.length,
        data: allChannels.map(transformChannel)
      });
    }

    // Filter channels by read permission (scoped to source)
    const accessibleChannels: any[] = [];
    for (const channel of allChannels) {
      const channelResource = `channel_${channel.id}` as ResourceType;
      const allowed = userId !== null
        ? await databaseService.checkPermissionAsync(userId, channelResource, 'read', sourceIdQ)
        : false;
      if (allowed) accessibleChannels.push(channel);
    }

    res.json({
      success: true,
      count: accessibleChannels.length,
      data: accessibleChannels.map(transformChannel)
    });
  } catch (error) {
    logger.error('Error getting channels:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to retrieve channels'
    });
  }
});

/**
 * GET /api/v1/channels/:channelId
 * Get a specific channel by ID (0-7)
 * Requires read permission for the specific channel
 */
router.get('/:channelId', async (req: Request, res: Response) => {
  try {
    const channelId = parseInt(req.params.channelId);

    // Validate channel ID
    if (isNaN(channelId) || channelId < 0 || channelId > 7) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Channel ID must be a number between 0 and 7'
      });
    }

    const user = (req as any).user;
    const userId = user?.id ?? null;
    const isAdmin = user?.isAdmin ?? false;
    const sourceIdQ = getScopedSourceId(req);

    // Check permission (unless admin), scoped to source if provided
    if (!isAdmin) {
      const channelResource = `channel_${channelId}` as ResourceType;
      const allowed = userId !== null
        ? await databaseService.checkPermissionAsync(userId, channelResource, 'read', sourceIdQ)
        : false;
      if (!allowed) {
        return res.status(403).json({
          success: false,
          error: 'Forbidden',
          message: 'Insufficient permissions',
          required: { resource: channelResource, action: 'read' }
        });
      }
    }

    const channel = await databaseService.channels.getChannelById(channelId, sourceIdQ);

    if (!channel) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: `Channel ${channelId} not found`
      });
    }

    res.json({
      success: true,
      data: transformChannel(channel)
    });
  } catch (error) {
    logger.error('Error getting channel:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to retrieve channel'
    });
  }
});

export default router;
