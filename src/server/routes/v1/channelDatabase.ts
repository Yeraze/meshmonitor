/**
 * v1 API - Channel Database Endpoint
 *
 * Provides CRUD operations for the server-side channel database.
 * This enables MeshMonitor to store channel configurations beyond the device's 8 slots
 * and decrypt packets server-side using stored keys.
 *
 * Admin users can create, update, delete channels.
 * Regular users with permissions can view channel info (without PSK).
 */

import express, { Request, Response } from 'express';
import databaseService from '../../../services/database.js';
import { channelDecryptionService } from '../../services/channelDecryptionService.js';
import { retroactiveDecryptionService } from '../../services/retroactiveDecryptionService.js';
import { logger } from '../../../utils/logger.js';

const router = express.Router();

/**
 * Transform database channel to API response format
 * PSK is masked for security - only admins can see it
 */
function transformChannelForResponse(channel: any, includeFullPsk: boolean = false) {
  return {
    id: channel.id,
    name: channel.name,
    pskLength: channel.pskLength,
    pskPreview: includeFullPsk ? channel.psk : `${channel.psk.substring(0, 8)}...`,
    psk: includeFullPsk ? channel.psk : undefined,
    description: channel.description,
    isEnabled: channel.isEnabled,
    enforceNameValidation: channel.enforceNameValidation ?? false,
    sortOrder: channel.sortOrder ?? 0,
    decryptedPacketCount: channel.decryptedPacketCount,
    lastDecryptedAt: channel.lastDecryptedAt,
    createdBy: channel.createdBy,
    createdAt: channel.createdAt,
    updatedAt: channel.updatedAt,
  };
}

/**
 * GET /api/v1/channel-database
 * Get all channel database entries
 * Admins see full details including PSK
 * Regular users see masked PSK (if they have permission)
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const isAdmin = user?.isAdmin ?? false;

    // For now, only admins can access channel database
    // TODO: Add per-channel permissions for non-admin users
    if (!isAdmin) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'Admin access required for channel database'
      });
    }

    const channels = await databaseService.getAllChannelDatabaseEntriesAsync();

    res.json({
      success: true,
      count: channels.length,
      data: channels.map(ch => transformChannelForResponse(ch, isAdmin))
    });
  } catch (error) {
    logger.error('Error getting channel database entries:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to retrieve channel database entries'
    });
  }
});

/**
 * GET /api/v1/channel-database/retroactive-decrypt/progress
 * Get progress of current retroactive decryption process
 * Admin only
 * NOTE: This route must be defined BEFORE /:id to avoid route matching issues
 */
router.get('/retroactive-decrypt/progress', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const isAdmin = user?.isAdmin ?? false;

    if (!isAdmin) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'Admin access required'
      });
    }

    const progress = retroactiveDecryptionService.getProgress();
    const isRunning = retroactiveDecryptionService.isRunning();

    res.json({
      success: true,
      isRunning,
      progress
    });
  } catch (error) {
    logger.error('Error getting retroactive decryption progress:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to get retroactive decryption progress'
    });
  }
});

/**
 * GET /api/v1/channel-database/:id
 * Get a specific channel database entry by ID
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const isAdmin = user?.isAdmin ?? false;
    const id = parseInt(req.params.id, 10);

    if (isNaN(id)) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Invalid channel database ID'
      });
    }

    if (!isAdmin) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'Admin access required for channel database'
      });
    }

    const channel = await databaseService.getChannelDatabaseByIdAsync(id);

    if (!channel) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: `Channel database entry ${id} not found`
      });
    }

    res.json({
      success: true,
      data: transformChannelForResponse(channel, isAdmin)
    });
  } catch (error) {
    logger.error('Error getting channel database entry:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to retrieve channel database entry'
    });
  }
});

/**
 * POST /api/v1/channel-database
 * Create a new channel database entry
 * Admin only
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const isAdmin = user?.isAdmin ?? false;

    if (!isAdmin) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'Admin access required to create channel database entries'
      });
    }

    const { name, psk, pskLength, description, isEnabled, enforceNameValidation } = req.body;

    // Validate required fields
    if (!name || typeof name !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'name is required and must be a string'
      });
    }

    if (!psk || typeof psk !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'psk is required and must be a Base64-encoded string'
      });
    }

    // Validate PSK is valid Base64
    try {
      const pskBuffer = Buffer.from(psk, 'base64');
      if (pskBuffer.length !== 16 && pskBuffer.length !== 32) {
        return res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'PSK must be 16 bytes (AES-128) or 32 bytes (AES-256) when decoded'
        });
      }

      // Validate pskLength matches actual length
      const expectedLength = pskLength ?? pskBuffer.length;
      if (expectedLength !== pskBuffer.length) {
        return res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: `pskLength (${expectedLength}) does not match actual PSK length (${pskBuffer.length})`
        });
      }
    } catch (_err) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'psk must be a valid Base64-encoded string'
      });
    }

    const newChannelId = await databaseService.createChannelDatabaseEntryAsync({
      name,
      psk,
      pskLength: pskLength ?? Buffer.from(psk, 'base64').length,
      description: description ?? null,
      isEnabled: isEnabled ?? true,
      enforceNameValidation: enforceNameValidation ?? false,
      createdBy: user?.id ?? null,
    });

    // Get the created entry
    const newChannel = await databaseService.getChannelDatabaseByIdAsync(newChannelId);

    // Invalidate the decryption cache so the new channel is available
    channelDecryptionService.invalidateCache();

    // Start retroactive decryption in the background if the channel is enabled
    if (newChannelId && (isEnabled ?? true)) {
      retroactiveDecryptionService.processForChannel(newChannelId).catch(err => {
        logger.warn(`Background retroactive decryption failed for channel ${newChannelId}:`, err);
      });
    }

    logger.info(`Channel database entry created: "${name}" (id=${newChannelId}) by user ${user?.username ?? 'unknown'}`);

    res.status(201).json({
      success: true,
      data: newChannel ? transformChannelForResponse(newChannel, true) : null,
      message: 'Channel database entry created successfully'
    });
  } catch (error) {
    logger.error('Error creating channel database entry:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to create channel database entry'
    });
  }
});

/**
 * PUT /api/v1/channel-database/reorder
 * Reorder channel database entries
 * Admin only
 * NOTE: This route must be defined BEFORE /:id to avoid route matching issues
 */
router.put('/reorder', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const isAdmin = user?.isAdmin ?? false;

    if (!isAdmin) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'Admin access required to reorder channel database entries'
      });
    }

    const { channels } = req.body;

    // Validate request body
    if (!Array.isArray(channels)) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'channels must be an array'
      });
    }

    // Validate each entry
    const updates: { id: number; sortOrder: number }[] = [];
    for (const entry of channels) {
      if (typeof entry.id !== 'number' || !Number.isInteger(entry.id)) {
        return res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Each channel entry must have a numeric id'
        });
      }
      if (typeof entry.sortOrder !== 'number' || !Number.isInteger(entry.sortOrder)) {
        return res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Each channel entry must have a numeric sortOrder'
        });
      }
      updates.push({ id: entry.id, sortOrder: entry.sortOrder });
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'At least one channel entry is required'
      });
    }

    await databaseService.reorderChannelDatabaseEntriesAsync(updates);

    // Invalidate the decryption cache
    channelDecryptionService.invalidateCache();

    logger.info(`Channel database reordered (${updates.length} entries) by user ${user?.username ?? 'unknown'}`);

    res.json({
      success: true,
      message: `Channel database order updated for ${updates.length} entries`
    });
  } catch (error) {
    logger.error('Error reordering channel database entries:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to reorder channel database entries'
    });
  }
});

/**
 * PUT /api/v1/channel-database/:id
 * Update an existing channel database entry
 * Admin only
 */
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const isAdmin = user?.isAdmin ?? false;
    const id = parseInt(req.params.id, 10);

    if (isNaN(id)) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Invalid channel database ID'
      });
    }

    if (!isAdmin) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'Admin access required to update channel database entries'
      });
    }

    // Check if entry exists
    const existing = await databaseService.getChannelDatabaseByIdAsync(id);
    if (!existing) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: `Channel database entry ${id} not found`
      });
    }

    const { name, psk, pskLength, description, isEnabled, enforceNameValidation, sortOrder } = req.body;
    const updates: any = {};

    if (name !== undefined) {
      if (typeof name !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'name must be a string'
        });
      }
      updates.name = name;
    }

    if (psk !== undefined) {
      if (typeof psk !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'psk must be a Base64-encoded string'
        });
      }

      try {
        const pskBuffer = Buffer.from(psk, 'base64');
        if (pskBuffer.length !== 16 && pskBuffer.length !== 32) {
          return res.status(400).json({
            success: false,
            error: 'Bad Request',
            message: 'PSK must be 16 bytes (AES-128) or 32 bytes (AES-256) when decoded'
          });
        }
        updates.psk = psk;
        updates.pskLength = pskBuffer.length;
      } catch (_err) {
        return res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'psk must be a valid Base64-encoded string'
        });
      }
    }

    if (pskLength !== undefined && !psk) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'pskLength cannot be changed without also providing psk'
      });
    }

    if (description !== undefined) {
      updates.description = description;
    }

    if (isEnabled !== undefined) {
      updates.isEnabled = Boolean(isEnabled);
    }

    if (enforceNameValidation !== undefined) {
      updates.enforceNameValidation = Boolean(enforceNameValidation);
    }

    if (sortOrder !== undefined) {
      if (typeof sortOrder !== 'number' || !Number.isInteger(sortOrder)) {
        return res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'sortOrder must be an integer'
        });
      }
      updates.sortOrder = sortOrder;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'No valid update fields provided'
      });
    }

    await databaseService.updateChannelDatabaseEntryAsync(id, updates);

    // Invalidate the decryption cache
    channelDecryptionService.invalidateCache();

    // If PSK changed and channel is enabled, run retroactive decryption
    if (psk !== undefined && (isEnabled ?? existing.isEnabled)) {
      retroactiveDecryptionService.processForChannel(id).catch(err => {
        logger.warn(`Background retroactive decryption failed for channel ${id}:`, err);
      });
    }

    // Get updated entry
    const updatedChannel = await databaseService.getChannelDatabaseByIdAsync(id);

    logger.info(`Channel database entry ${id} updated by user ${user?.username ?? 'unknown'}`);

    res.json({
      success: true,
      data: updatedChannel ? transformChannelForResponse(updatedChannel, true) : null,
      message: 'Channel database entry updated successfully'
    });
  } catch (error) {
    logger.error('Error updating channel database entry:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to update channel database entry'
    });
  }
});

/**
 * DELETE /api/v1/channel-database/:id
 * Delete a channel database entry
 * Admin only
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const isAdmin = user?.isAdmin ?? false;
    const id = parseInt(req.params.id, 10);

    if (isNaN(id)) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Invalid channel database ID'
      });
    }

    if (!isAdmin) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'Admin access required to delete channel database entries'
      });
    }

    // Check if entry exists
    const existing = await databaseService.getChannelDatabaseByIdAsync(id);
    if (!existing) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: `Channel database entry ${id} not found`
      });
    }

    await databaseService.deleteChannelDatabaseEntryAsync(id);

    // Invalidate the decryption cache
    channelDecryptionService.invalidateCache();

    logger.info(`Channel database entry ${id} ("${existing.name}") deleted by user ${user?.username ?? 'unknown'}`);

    res.json({
      success: true,
      message: `Channel database entry ${id} deleted successfully`
    });
  } catch (error) {
    logger.error('Error deleting channel database entry:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to delete channel database entry'
    });
  }
});

/**
 * POST /api/v1/channel-database/:id/retroactive-decrypt
 * Trigger retroactive decryption for a specific channel
 * Admin only
 */
router.post('/:id/retroactive-decrypt', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const isAdmin = user?.isAdmin ?? false;
    const id = parseInt(req.params.id, 10);

    if (isNaN(id)) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Invalid channel database ID'
      });
    }

    if (!isAdmin) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'Admin access required to trigger retroactive decryption'
      });
    }

    // Check if entry exists
    const existing = await databaseService.getChannelDatabaseByIdAsync(id);
    if (!existing) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: `Channel database entry ${id} not found`
      });
    }

    if (!existing.isEnabled) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Cannot run retroactive decryption for disabled channel'
      });
    }

    // Check if already processing
    if (retroactiveDecryptionService.isRunning()) {
      return res.status(409).json({
        success: false,
        error: 'Conflict',
        message: 'Retroactive decryption already in progress',
        progress: retroactiveDecryptionService.getProgress()
      });
    }

    // Start retroactive decryption (don't await - run in background)
    retroactiveDecryptionService.processForChannel(id).catch(err => {
      logger.error(`Retroactive decryption failed for channel ${id}:`, err);
    });

    res.json({
      success: true,
      message: `Retroactive decryption started for channel ${id}`,
      progress: retroactiveDecryptionService.getProgress()
    });
  } catch (error) {
    logger.error('Error triggering retroactive decryption:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to trigger retroactive decryption'
    });
  }
});

// ============ PERMISSION ENDPOINTS ============

/**
 * GET /api/v1/channel-database/:id/permissions
 * Get all user permissions for a specific channel database entry
 * Admin only
 */
router.get('/:id/permissions', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const isAdmin = user?.isAdmin ?? false;
    const id = parseInt(req.params.id, 10);

    if (isNaN(id)) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Invalid channel database ID'
      });
    }

    if (!isAdmin) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'Admin access required to view channel permissions'
      });
    }

    // Check if entry exists
    const channel = await databaseService.getChannelDatabaseByIdAsync(id);
    if (!channel) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: `Channel database entry ${id} not found`
      });
    }

    const permissions = await databaseService.getChannelDatabasePermissionsForChannelAsync(id);

    res.json({
      success: true,
      channelId: id,
      channelName: channel.name,
      count: permissions.length,
      data: permissions.map(p => ({
        userId: p.userId,
        canViewOnMap: p.canViewOnMap,
        canRead: p.canRead,
        grantedBy: p.grantedBy,
        grantedAt: p.grantedAt
      }))
    });
  } catch (error) {
    logger.error('Error getting channel database permissions:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to retrieve channel database permissions'
    });
  }
});

/**
 * PUT /api/v1/channel-database/:id/permissions/:userId
 * Set or update a user's permission for a channel database entry
 * Admin only
 */
router.put('/:id/permissions/:userId', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const isAdmin = user?.isAdmin ?? false;
    const channelId = parseInt(req.params.id, 10);
    const targetUserId = parseInt(req.params.userId, 10);

    if (isNaN(channelId)) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Invalid channel database ID'
      });
    }

    if (isNaN(targetUserId)) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Invalid user ID'
      });
    }

    if (!isAdmin) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'Admin access required to modify channel permissions'
      });
    }

    // Check if channel exists
    const channel = await databaseService.getChannelDatabaseByIdAsync(channelId);
    if (!channel) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: `Channel database entry ${channelId} not found`
      });
    }

    // Check if target user exists
    const targetUser = await databaseService.findUserByIdAsync(targetUserId);
    if (!targetUser) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: `User ${targetUserId} not found`
      });
    }

    const { canViewOnMap, canRead } = req.body;

    // Validate permission values
    if (typeof canViewOnMap !== 'boolean' || typeof canRead !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'canViewOnMap and canRead are required and must be boolean values'
      });
    }

    await databaseService.setChannelDatabasePermissionAsync({
      userId: targetUserId,
      channelDatabaseId: channelId,
      canViewOnMap,
      canRead,
      grantedBy: user?.id ?? null
    });

    logger.info(`Channel database permission set: user ${targetUserId} on channel ${channelId} (viewOnMap=${canViewOnMap}, read=${canRead}) by ${user?.username ?? 'unknown'}`);

    res.json({
      success: true,
      message: `Permission updated for user ${targetUserId} on channel ${channelId}`,
      data: {
        userId: targetUserId,
        channelDatabaseId: channelId,
        canViewOnMap,
        canRead
      }
    });
  } catch (error) {
    logger.error('Error setting channel database permission:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to set channel database permission'
    });
  }
});

/**
 * DELETE /api/v1/channel-database/:id/permissions/:userId
 * Remove a user's permission for a channel database entry
 * Admin only
 */
router.delete('/:id/permissions/:userId', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const isAdmin = user?.isAdmin ?? false;
    const channelId = parseInt(req.params.id, 10);
    const targetUserId = parseInt(req.params.userId, 10);

    if (isNaN(channelId)) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Invalid channel database ID'
      });
    }

    if (isNaN(targetUserId)) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Invalid user ID'
      });
    }

    if (!isAdmin) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'Admin access required to modify channel permissions'
      });
    }

    // Check if channel exists
    const channel = await databaseService.getChannelDatabaseByIdAsync(channelId);
    if (!channel) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: `Channel database entry ${channelId} not found`
      });
    }

    await databaseService.deleteChannelDatabasePermissionAsync(targetUserId, channelId);

    logger.info(`Channel database permission deleted: user ${targetUserId} on channel ${channelId} by ${user?.username ?? 'unknown'}`);

    res.json({
      success: true,
      message: `Permission removed for user ${targetUserId} on channel ${channelId}`
    });
  } catch (error) {
    logger.error('Error deleting channel database permission:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to delete channel database permission'
    });
  }
});

export default router;
