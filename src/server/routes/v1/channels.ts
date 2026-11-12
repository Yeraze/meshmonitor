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
import { loadV1Access, requireScopedSourceId } from './sourceParam.js';
import { isAnyMeshCoreSourceType } from '../../../utils/nodeTypeCategory.js';
import { withMeshtasticProtocol } from '../../utils/protocolRows.js';
import type { NodeViewAccess } from '../../utils/nodeEnhancer.js';

type SourcedRequest = Request & { source?: { type?: string } };

/**
 * MeshCore channel VISIBILITY on one source: the per-channel read grant
 * (slots 0-7) OR the legacy `messages` grant, so slots above 7 are readable
 * with `messages:read` (the rule `canAccessMeshcoreChannel` applies, from
 * grants already loaded for the request). Never use this to decide whether
 * the raw key is returned — see canSeeMeshcorePsk.
 */
function canReadMeshcoreSlot(access: NodeViewAccess, idx: number, sourceId: string): boolean {
  if (access.isAdmin) return true;
  if (idx >= 0 && idx <= 7 && access.permissions.can(`channel_${idx}` as ResourceType, 'read', sourceId)) return true;
  return access.permissions.can('messages', 'read', sourceId);
}

/**
 * Whether the raw MeshCore channel `psk` may be returned. Mirrors the UI rule
 * in channelRoutes.ts (GET /api/channels/all and GET /api/channels): admin, or
 * `channel_<idx>:write` on this source. Slots above 7 have no channel grant,
 * so only admins see their key. `messages:write` never exposes a key.
 */
function canSeeMeshcorePsk(access: NodeViewAccess, idx: number, sourceId: string): boolean {
  if (access.isAdmin) return true;
  return idx >= 0 && idx <= 7 && access.permissions.can(`channel_${idx}` as ResourceType, 'write', sourceId);
}

const router = express.Router({ mergeParams: true });

/**
 * GET /api/v1/channels
 * Get all channels in the mesh network
 * Only returns channels the user has read permission for
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const sourceId = requireScopedSourceId(req, res);
    if (!sourceId) return;
    const access = await loadV1Access(req);

    const allChannels = await databaseService.channels.getAllChannels(sourceId);

    if (isAnyMeshCoreSourceType((req as SourcedRequest).source?.type)) {
      const visible = allChannels.filter((c) => canReadMeshcoreSlot(access, c.id, sourceId));
      const data = visible.map((c) => ({
        ...transformChannel(c, { includePsk: canSeeMeshcorePsk(access, c.id, sourceId) }),
        protocol: 'meshcore' as const,
      }));
      return res.json({ success: true, count: data.length, data });
    }

    // If admin, return all channels with PSKs included (admin can configure them)
    if (access.isAdmin) {
      return res.json({
        success: true,
        count: allChannels.length,
        data: allChannels.map((c) => withMeshtasticProtocol(transformChannel(c, { includePsk: true })))
      });
    }

    // Filter channels by read permission on this source. The actual `psk` is
    // included only when the caller has write permission for that specific
    // channel — see issue #2951 (the channel-config UI needs to show the
    // existing key to operators who are allowed to change it).
    const projected = allChannels
      .filter((channel) => access.permissions.can(`channel_${channel.id}` as ResourceType, 'read', sourceId))
      .map((channel) => withMeshtasticProtocol(transformChannel(channel, {
        includePsk: access.permissions.can(`channel_${channel.id}` as ResourceType, 'write', sourceId),
      })));

    res.json({
      success: true,
      count: projected.length,
      data: projected
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
    const isMeshCore = isAnyMeshCoreSourceType((req as SourcedRequest).source?.type);

    // Validate channel ID (MeshCore has up to 256 slots)
    if (isNaN(channelId) || channelId < 0 || channelId > (isMeshCore ? 255 : 7)) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: `Channel ID must be a number between 0 and ${isMeshCore ? 255 : 7}`
      });
    }

    const sourceId = requireScopedSourceId(req, res);
    if (!sourceId) return;
    const access = await loadV1Access(req);
    const channelResource = `channel_${channelId}` as ResourceType;

    // The channel grant is held per source: checked on this one (admins pass).
    const canRead = isMeshCore
      ? canReadMeshcoreSlot(access, channelId, sourceId)
      : access.permissions.can(channelResource, 'read', sourceId);
    if (!canRead) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'Insufficient permissions',
        required: { resource: channelResource, action: 'read' }
      });
    }

    const channel = await databaseService.channels.getChannelById(channelId, sourceId);

    if (!channel) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: `Channel ${channelId} not found`
      });
    }

    // Include the raw `psk` only for admins or callers with write permission
    // to this channel on this source (issue #2951). MeshCore follows the same
    // rule; the `messages` fallback grants visibility only, never the key.
    const includePsk = isMeshCore
      ? canSeeMeshcorePsk(access, channelId, sourceId)
      : access.permissions.can(channelResource, 'write', sourceId);

    res.json({
      success: true,
      data: isMeshCore
        ? { ...transformChannel(channel, { includePsk }), protocol: 'meshcore' as const }
        : withMeshtasticProtocol(transformChannel(channel, { includePsk }))
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
