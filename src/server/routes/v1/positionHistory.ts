/**
 * v1 API - Position History Endpoint
 *
 * Provides read-only access to node position history data
 * Respects user permissions - requires nodes:read permission
 * Private-position nodes additionally require nodes_private:read
 */

import express, { Request, Response } from 'express';
import databaseService from '../../../services/database.js';
import { logger } from '../../../utils/logger.js';

const router = express.Router();

/**
 * Check if user has nodes:read permission
 */
async function hasNodesReadPermission(userId: number | null, isAdmin: boolean): Promise<boolean> {
  if (isAdmin) return true;

  const permissions = userId !== null
    ? await databaseService.getUserPermissionSetAsync(userId)
    : {};

  return permissions.nodes?.read === true;
}

/**
 * Check if user has nodes_private:read permission
 */
async function hasNodesPrivateReadPermission(userId: number | null, isAdmin: boolean): Promise<boolean> {
  if (isAdmin) return true;

  const permissions = userId !== null
    ? await databaseService.getUserPermissionSetAsync(userId)
    : {};

  return permissions.nodes_private?.read === true;
}

/**
 * GET /api/v1/nodes/:nodeId/position-history
 * Get position history for a specific node
 * Requires nodes:read permission
 * Private-position nodes additionally require nodes_private:read
 *
 * Query parameters:
 * - since: number - Unix timestamp (ms) to filter data after this time
 * - before: number - Unix timestamp (ms) to filter data before this time
 * - limit: number - Max number of position records to return (default: 1000, max: 10000)
 * - offset: number - Number of records to skip for pagination (default: 0)
 */
router.get('/:nodeId/position-history', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const userId = user?.id ?? null;
    const isAdmin = user?.isAdmin ?? false;

    // Check nodes:read permission
    if (!await hasNodesReadPermission(userId, isAdmin)) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'Insufficient permissions',
        required: { resource: 'nodes', action: 'read' }
      });
    }

    const { nodeId } = req.params;
    const { since, before, limit, offset } = req.query;

    const maxLimit = Math.min(parseInt(limit as string) || 1000, 10000);
    const offsetNum = parseInt(offset as string) || 0;
    const sinceTimestamp = since ? parseInt(since as string) : undefined;
    const beforeTimestamp = before ? parseInt(before as string) : undefined;

    // Check privacy for position history
    // nodeId is hex with '!' prefix (e.g., '!df6ab854'); getNode() expects the decimal nodeNum
    const nodeNum = parseInt(nodeId.replace('!', ''), 16);
    const node = databaseService.getNode(nodeNum);

    if (node?.positionOverrideIsPrivate === true) {
      if (!await hasNodesPrivateReadPermission(userId, isAdmin)) {
        return res.status(403).json({
          success: false,
          error: 'Forbidden',
          message: 'Node position is private',
          required: { resource: 'nodes_private', action: 'read' }
        });
      }
    }

    // Fetch position telemetry with a larger internal limit to account for grouping.
    // Each position produces up to 5 telemetry rows (latitude, longitude, altitude,
    // ground_speed, ground_track), so we multiply by 5 to ensure we fetch enough raw
    // rows. We include offset in the calculation so pagination works correctly and
    // `total` reflects all matching positions, not just the current page.
    const TELEMETRY_TYPES_PER_POSITION = 5;
    const internalLimit = (offsetNum + maxLimit) * TELEMETRY_TYPES_PER_POSITION;
    const positionTelemetry = await databaseService.getPositionTelemetryByNodeAsync(
      nodeId,
      internalLimit,
      sinceTimestamp
    );

    // Group by timestamp to build position objects
    const positionMap = new Map<number, {
      lat?: number;
      lon?: number;
      alt?: number;
      groundSpeed?: number;
      groundTrack?: number;
      packetId?: number;
    }>();

    positionTelemetry.forEach(t => {
      // Apply before filter (the DB method only supports since)
      if (beforeTimestamp !== undefined && t.timestamp >= beforeTimestamp) return;

      if (!positionMap.has(t.timestamp)) {
        positionMap.set(t.timestamp, {});
      }
      const pos = positionMap.get(t.timestamp)!;

      if (t.telemetryType === 'latitude') {
        pos.lat = t.value;
      } else if (t.telemetryType === 'longitude') {
        pos.lon = t.value;
      } else if (t.telemetryType === 'altitude') {
        pos.alt = t.value;
      } else if (t.telemetryType === 'ground_speed') {
        pos.groundSpeed = t.value;
      } else if (t.telemetryType === 'ground_track') {
        pos.groundTrack = t.value;
      }

      if (t.packetId !== undefined && pos.packetId === undefined) {
        pos.packetId = t.packetId;
      }
    });

    // Convert to array, filter incomplete, sort ascending
    const allPositions = Array.from(positionMap.entries())
      .filter(([_timestamp, pos]) => pos.lat !== undefined && pos.lon !== undefined)
      .map(([timestamp, pos]) => ({
        timestamp,
        latitude: pos.lat!,
        longitude: pos.lon!,
        ...(pos.alt !== undefined && { altitude: pos.alt }),
        ...(pos.groundSpeed !== undefined && { groundSpeed: pos.groundSpeed }),
        ...(pos.groundTrack !== undefined && { groundTrack: pos.groundTrack }),
        packetId: pos.packetId ?? null,
      }))
      .sort((a, b) => a.timestamp - b.timestamp);

    const total = allPositions.length;

    // Apply offset and limit
    const paginatedPositions = allPositions.slice(offsetNum, offsetNum + maxLimit);

    res.json({
      success: true,
      count: paginatedPositions.length,
      total,
      offset: offsetNum,
      limit: maxLimit,
      data: paginatedPositions
    });
  } catch (error) {
    logger.error('Error getting position history:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to retrieve position history'
    });
  }
});

export default router;
