/**
 * v1 API - Telemetry Endpoint
 *
 * Provides read-only access to telemetry data from mesh nodes
 */

import express, { Request, Response } from 'express';
import databaseService from '../../../services/database.js';
import { logger } from '../../../utils/logger.js';
import { fail } from '../../utils/apiResponse.js';
import type { DbTelemetry } from '../../../db/types.js';
import type { NodeViewAccess } from '../../utils/nodeEnhancer.js';
import { isValidNodeNum } from '../../constants/meshtastic.js';
import { canViewRowChannel, loadV1Access, requireScopedSourceId } from './sourceParam.js';

const router = express.Router({ mergeParams: true });

const POSITION_TYPES = new Set(['latitude', 'longitude', 'altitude']);
const MESHCORE_KEY = /^[0-9a-fA-F]{64}$/;

type TelemetryRow = { nodeNum?: number | null; telemetryType: string; channel?: number | null };

/**
 * What the token user may read about one node on one source, from grants
 * already loaded for the request.
 *
 *  - `allowed`: `viewOnMap` on the channel the node was last heard on, on this
 *    source (channel 0 when the source has no row for it). A MeshCore public
 *    key has no channel: `nodes:viewOnMap` on this source.
 *  - `hidePosition`: the node's position is private on this source and the
 *    user lacks `nodes_private:read` there, so position telemetry is left out
 *    (the rule `/api/telemetry/:nodeId` applies).
 */
async function nodeTelemetryAccess(
  nodeId: string,
  access: NodeViewAccess,
  sourceId: string,
): Promise<{ allowed: boolean; hidePosition: boolean }> {
  if (access.isAdmin) return { allowed: true, hidePosition: false };
  if (MESHCORE_KEY.test(nodeId)) {
    return { allowed: access.permissions.can('nodes', 'viewOnMap', sourceId), hidePosition: false };
  }
  const nodeNum = nodeId.startsWith('!') ? parseInt(nodeId.replace('!', ''), 16) : parseInt(nodeId, 10);
  const node = isValidNodeNum(nodeNum) ? await databaseService.nodes.getNode(nodeNum, sourceId) : null;
  return {
    allowed: access.canViewNode(sourceId, node?.channel ?? 0),
    hidePosition: !!node?.positionOverrideIsPrivate && !access.canViewPrivate(sourceId),
  };
}

/**
 * Rows of several nodes, as the token user may see them: the row's own
 * channel, the channel its node was last heard on, and private positions, all
 * on this source. One node read for the lot, none per row.
 */
async function scopeTelemetryRows<T extends TelemetryRow>(
  rows: T[],
  access: NodeViewAccess,
  sourceId: string,
): Promise<T[]> {
  if (access.isAdmin || rows.length === 0) return rows;
  const nodes = await databaseService.nodes.getAllNodes(sourceId);
  const byNum = new Map(nodes.map((n) => [Number(n.nodeNum), n]));
  const canViewPrivate = access.canViewPrivate(sourceId);
  return rows.filter((row) => {
    if (!canViewRowChannel(access, sourceId, row.channel)) return false;
    const node = row.nodeNum != null ? byNum.get(Number(row.nodeNum)) : undefined;
    if (!access.canViewNode(sourceId, node?.channel ?? 0)) return false;
    if (node?.positionOverrideIsPrivate && !canViewPrivate && POSITION_TYPES.has(row.telemetryType)) return false;
    return true;
  });
}

/**
 * GET /api/v1/sources/{sourceId}/telemetry
 * Get telemetry data for all nodes
 *
 * Query parameters:
 * - nodeId: string - Filter by specific node
 * - type: string - Filter by telemetry type (battery_level, temperature, etc.)
 * - since: number - Unix timestamp (ms) to filter data after this time
 * - before: number - Unix timestamp (ms) to filter data before this time
 * - limit: number - Max number of records to return (default: 1000)
 * - offset: number - Number of records to skip for pagination (default: 0)
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { nodeId, type, since, before, limit, offset } = req.query;
    const sourceId = requireScopedSourceId(req, res);
    if (!sourceId) return;
    const access = await loadV1Access(req);

    const maxLimit = Math.min(parseInt(limit as string) || 1000, 10000);
    const offsetNum = parseInt(offset as string) || 0;
    const sinceTimestamp = since ? parseInt(since as string) : undefined;
    const beforeTimestamp = before ? parseInt(before as string) : undefined;

    let telemetry: DbTelemetry[];
    let total: number | undefined;

    if (nodeId) {
      // Check channel-based access for this node, on this source
      const nodeAccess = await nodeTelemetryAccess(nodeId as string, access, sourceId);
      if (!nodeAccess.allowed) {
        return fail(res, 403, 'FORBIDDEN', 'Insufficient permissions');
      }

      const typeStr = type ? type as string : undefined;
      telemetry = await databaseService.telemetry.getTelemetryByNode(nodeId as string, maxLimit, sinceTimestamp, beforeTimestamp, offsetNum, typeStr, sourceId);
      total = await databaseService.telemetry.getTelemetryCountByNode(nodeId as string, sinceTimestamp, beforeTimestamp, typeStr, sourceId);
      if (nodeAccess.hidePosition) {
        telemetry = telemetry.filter((t) => !POSITION_TYPES.has(t.telemetryType));
      }
    } else {
      if (type) {
        // This source's rows only. The read used to take no source, so it
        // returned every source's rows of the type under any source's path.
        telemetry = await databaseService.telemetry.getTelemetryByType(type as string, maxLimit, sourceId);
        // Filter by since/before if provided
        if (sinceTimestamp) {
          telemetry = telemetry.filter(t => t.timestamp >= sinceTimestamp);
        }
        if (beforeTimestamp) {
          telemetry = telemetry.filter(t => t.timestamp < beforeTimestamp);
        }
      } else {
        // Get all telemetry by getting this source's nodes and their telemetry.
        const nodes = await databaseService.nodes.getAllNodes(sourceId);
        telemetry = [];
        const perNodeLimit = Math.max(1, Math.floor(maxLimit / 10));
        for (const node of nodes.slice(0, 10)) { // Limit to first 10 nodes to avoid huge response
          const nodeTelemetry = await databaseService.telemetry.getTelemetryByNode(node.nodeId, perNodeLimit, sinceTimestamp, beforeTimestamp, 0, undefined, sourceId);
          telemetry.push(...nodeTelemetry);
        }
      }
      telemetry = await scopeTelemetryRows(telemetry, access, sourceId);
    }

    res.json({
      success: true,
      count: telemetry.length,
      total,
      offset: offsetNum,
      limit: maxLimit,
      data: telemetry
    });
  } catch (error) {
    logger.error('Error getting telemetry:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to retrieve telemetry data'
    });
  }
});

/**
 * GET /api/v1/telemetry/count
 * Get total count of telemetry records
 */
router.get('/count', async (req: Request, res: Response) => {
  try {
    const sourceId = requireScopedSourceId(req, res);
    if (!sourceId) return;
    // This source's rows. It used to count every source's.
    const count = await databaseService.telemetry.getTelemetryCount(sourceId);

    res.json({
      success: true,
      count
    });
  } catch (error) {
    logger.error('Error getting telemetry count:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to retrieve telemetry count'
    });
  }
});

/**
 * GET /api/v1/telemetry/:nodeId
 * Get all telemetry for a specific node
 *
 * Query parameters:
 * - type: string - Filter by telemetry type
 * - since: number - Unix timestamp (ms) to filter data after this time
 * - before: number - Unix timestamp (ms) to filter data before this time
 * - limit: number - Max number of records to return (default: 1000, max: 10000)
 * - offset: number - Number of records to skip for pagination (default: 0)
 */
router.get('/:nodeId', async (req: Request, res: Response) => {
  try {
    const { nodeId } = req.params;
    const sourceId = requireScopedSourceId(req, res);
    if (!sourceId) return;
    const access = await loadV1Access(req);

    // Check channel-based access for this node, on this source
    const nodeAccess = await nodeTelemetryAccess(nodeId, access, sourceId);
    if (!nodeAccess.allowed) {
      return fail(res, 403, 'FORBIDDEN', 'Insufficient permissions');
    }

    const { type, since, before, limit, offset } = req.query;

    const maxLimit = Math.min(parseInt(limit as string) || 1000, 10000);
    const offsetNum = parseInt(offset as string) || 0;
    const sinceTimestamp = since ? parseInt(since as string) : undefined;
    const beforeTimestamp = before ? parseInt(before as string) : undefined;

    const typeStr = type ? type as string : undefined;
    let telemetry = await databaseService.telemetry.getTelemetryByNode(nodeId, maxLimit, sinceTimestamp, beforeTimestamp, offsetNum, typeStr, sourceId);
    const total = await databaseService.telemetry.getTelemetryCountByNode(nodeId, sinceTimestamp, beforeTimestamp, typeStr, sourceId);
    if (nodeAccess.hidePosition) {
      telemetry = telemetry.filter((t) => !POSITION_TYPES.has(t.telemetryType));
    }

    res.json({
      success: true,
      count: telemetry.length,
      total,
      offset: offsetNum,
      limit: maxLimit,
      data: telemetry
    });
  } catch (error) {
    logger.error('Error getting node telemetry:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to retrieve node telemetry'
    });
  }
});

export default router;
