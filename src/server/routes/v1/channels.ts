/**
 * v1 API - Channels Endpoint
 *
 * Provides read-only access to mesh network channel configuration
 */

import express, { Request, Response } from 'express';
import databaseService from '../../../services/database.js';
import { logger } from '../../../utils/logger.js';

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
 */
router.get('/', (_req: Request, res: Response) => {
  try {
    const channels = databaseService.getAllChannels();

    res.json({
      success: true,
      count: channels.length,
      data: channels.map(transformChannel)
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
 */
router.get('/:channelId', (req: Request, res: Response) => {
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

    const channel = databaseService.getChannelById(channelId);

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
