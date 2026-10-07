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
import { fail } from '../../utils/apiResponse.js';
import { isValidNodeNum } from '../../constants/meshtastic.js';
import { loadV1Access, requireScopedSourceId } from './sourceParam.js';

const router = express.Router({ mergeParams: true });

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
    // `attachSource('nodes', 'read')` has checked the grant on this source.
    const sourceId = requireScopedSourceId(req, res);
    if (!sourceId) return;
    const access = await loadV1Access(req);

    const { nodeId } = req.params;
    const { since, before, limit, offset } = req.query;

    const maxLimit = Math.min(parseInt(limit as string) || 1000, 10000);
    const offsetNum = parseInt(offset as string) || 0;
    const sinceTimestamp = since ? parseInt(since as string) : undefined;
    const beforeTimestamp = before ? parseInt(before as string) : undefined;

    if (!access.isAdmin) {
      if (/^[0-9a-fA-F]{64}$/.test(nodeId)) {
        // A MeshCore public key has no channel: `nodes:viewOnMap` on this
        // source, the gate the MeshCore position reads use (#4559).
        if (!access.permissions.can('nodes', 'viewOnMap', sourceId)) {
          return fail(res, 403, 'FORBIDDEN', 'Insufficient permissions');
        }
      } else {
        // nodeId is hex with '!' prefix (e.g., '!df6ab854') or a decimal
        // nodeNum; getNode() expects the number. The row is THIS source's: the
        // channel the node was last heard on and its privacy flag differ per
        // source, and the lookup used to name no source.
        const nodeNum = nodeId.startsWith('!') ? parseInt(nodeId.replace('!', ''), 16) : parseInt(nodeId, 10);
        const node = isValidNodeNum(nodeNum) ? await databaseService.nodes.getNode(nodeNum, sourceId) : null;

        // Check channel-based access for this node
        if (!access.canViewNode(sourceId, node?.channel ?? 0)) {
          return fail(res, 403, 'FORBIDDEN', 'Insufficient permissions');
        }

        // Check privacy for position history
        if (node?.positionOverrideIsPrivate && !access.canViewPrivate(sourceId)) {
          return fail(res, 403, 'FORBIDDEN', 'Node position is private', {
            required: { resource: 'nodes_private', action: 'read' },
          });
        }
      }
    }

    // Fetch position telemetry with a larger internal limit to account for grouping.
    // Each position produces up to 5 telemetry rows (latitude, longitude, altitude,
    // ground_speed, ground_track), so we multiply by 5 to ensure we fetch enough raw
    // rows. We include offset in the calculation so pagination works correctly and
    // `total` reflects all matching positions, not just the current page.
    const TELEMETRY_TYPES_PER_POSITION = 5;
    const internalLimit = (offsetNum + maxLimit) * TELEMETRY_TYPES_PER_POSITION;
    const positionTelemetry = await databaseService.telemetry.getPositionTelemetryByNode(
      nodeId,
      internalLimit,
      sinceTimestamp,
      sourceId
    );

    // Group by timestamp to build position objects
    const positionMap = new Map<number, {
      lat?: number;
      lon?: number;
      alt?: number;
      groundSpeed?: number;
      groundTrack?: number;
      packetId?: number;
      snr?: number;
      hopStart?: number;
      hopLimit?: number;
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

      if (t.packetId != null && pos.packetId === undefined) {
        pos.packetId = t.packetId ?? undefined;
      }

      // Receive SNR + hop metadata are stored on the lat/lon rows (#3492).
      // Capture from whichever row carries them (only fixes received after
      // migration 089 have these).
      if (t.rxSnr != null && pos.snr === undefined) pos.snr = t.rxSnr ?? undefined;
      if (t.hopStart != null && pos.hopStart === undefined) pos.hopStart = t.hopStart ?? undefined;
      if (t.hopLimit != null && pos.hopLimit === undefined) pos.hopLimit = t.hopLimit ?? undefined;
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
        ...(pos.snr !== undefined && { snr: pos.snr }),
        ...(pos.hopStart !== undefined && { hopStart: pos.hopStart }),
        ...(pos.hopLimit !== undefined && { hopLimit: pos.hopLimit }),
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
