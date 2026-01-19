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

const router = express.Router();

/**
 * Helper to convert role number to human-readable name
 */
function getRoleName(role: number | undefined): string {
  switch (role) {
    case 0:
      return 'Disabled';
    case 1:
      return 'Primary';
    case 2:
      return 'Secondary';
    default:
      return 'Unknown';
  }
}

/**
 * Transform database channel to API response format
 */
function transformChannel(channel: any) {
  return {
    id: channel.id,
    name: channel.name,
    role: channel.role,
    roleName: getRoleName(channel.role),
    uplinkEnabled: channel.uplinkEnabled,
    downlinkEnabled: channel.downlinkEnabled,
    positionPrecision: channel.positionPrecision
  };
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

    // Get all channels
    const allChannels = await databaseService.getAllChannelsAsync();

    // If admin, return all channels
    if (isAdmin) {
      return res.json({
        success: true,
        count: allChannels.length,
        data: allChannels.map(transformChannel)
      });
    }

    // Get user permissions
    const permissions = userId !== null
      ? await databaseService.getUserPermissionSetAsync(userId)
      : {};

    // Filter channels by read permission
    const accessibleChannels = allChannels.filter(channel => {
      const channelResource = `channel_${channel.id}` as ResourceType;
      return permissions[channelResource]?.read === true;
    });

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

    // Check permission (unless admin)
    if (!isAdmin) {
      const permissions = userId !== null
        ? await databaseService.getUserPermissionSetAsync(userId)
        : {};

      const channelResource = `channel_${channelId}` as ResourceType;
      if (permissions[channelResource]?.read !== true) {
        return res.status(403).json({
          success: false,
          error: 'Forbidden',
          message: 'Insufficient permissions',
          required: { resource: channelResource, action: 'read' }
        });
      }
    }

    const channel = await databaseService.getChannelByIdAsync(channelId);

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
