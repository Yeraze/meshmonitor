/**
 * v1 API - Packets Endpoint
 *
 * Provides access to raw packet log data from the mesh network
 */

import express from 'express';
import packetLogService from '../../services/packetLogService.js';
import { logger } from '../../../utils/logger.js';
import { requireScopedSourceId } from './sourceParam.js';
import { isAnyMeshCoreSourceType } from '../../../utils/nodeTypeCategory.js';
import { listMeshCorePacketsForViewer } from '../../services/meshcorePacketList.js';
import { parseMeshCorePacketFilters } from '../meshcorePacketRoutes.js';
import { meshcorePacketToV1, withMeshtasticProtocol } from '../../utils/protocolRows.js';
import databaseService from '../../../services/database.js';
import { fail } from '../../utils/apiResponse.js';
import { plaintextForPacket } from '../../services/meshcorePacketList.js';
import type { PacketDecodeViewer } from '../../utils/meshcorePacketPlaintext.js';

/** Meshtastic-only list filters: a MeshCore source refuses them rather than ignore them. */
const MESHTASTIC_ONLY_FILTERS = ['portnum', 'from_node', 'to_node', 'channel', 'encrypted'] as const;

type SourcedRequest = express.Request & { source?: { type?: string }; user?: PacketDecodeViewer };

/** Normalize a `since` timestamp to milliseconds (auto-detect seconds vs ms) */
function normalizeSinceToMs(value: string): number {
  const n = parseInt(value, 10);
  return n < 10_000_000_000 ? n * 1000 : n;
}

const router = express.Router({ mergeParams: true });

/**
 * GET /api/v1/packets
 * Get packet logs with optional filtering
 */
router.get('/', async (req, res) => {
  try {
    const sourceId = requireScopedSourceId(req, res);
    if (!sourceId) return;
    if (isAnyMeshCoreSourceType((req as SourcedRequest).source?.type)) {
      const bad = MESHTASTIC_ONLY_FILTERS.find((k) => req.query[k] !== undefined);
      if (bad) return fail(res, 400, 'UNSUPPORTED_FILTER', `${bad} is not supported on a MeshCore source`);
      const offsetRaw = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;
      const limitRaw = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;
      if (!(limitRaw >= 1)) return fail(res, 400, 'BAD_REQUEST', 'Limit must be at least 1');
      if (!(offsetRaw >= 0)) return fail(res, 400, 'BAD_REQUEST', 'Offset must be non-negative');
      const parsed = parseMeshCorePacketFilters(req.query);
      if (!parsed.ok) return fail(res, 400, parsed.code, parsed.message);
      const viewer = (req as SourcedRequest).user ?? null;
      const page = await listMeshCorePacketsForViewer({
        sourceId,
        filters: parsed.filters,
        offset: offsetRaw,
        requestedLimit: limitRaw,
        plaintextFor: { viewer },
      });
      const data = page.packets.map((p) =>
        meshcorePacketToV1(p, { plaintext: p.id !== undefined ? (page.plaintext?.get(p.id) ?? null) : null }),
      );
      return res.json({
        success: true,
        count: data.length,
        total: page.total,
        offset: offsetRaw,
        limit: page.limit,
        data,
      });
    }
    // MeshCore-only filters (payload_type, route_type) stay ignored here, so
    // existing Meshtastic clients see only the additive `protocol` field.

    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;
    let limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;

    // Enforce maximum limit to prevent unbounded queries
    const MAX_LIMIT = await packetLogService.getMaxCount();
    if (limit > MAX_LIMIT) {
      limit = MAX_LIMIT;
    }
    if (limit < 1) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Limit must be at least 1'
      });
    }
    if (offset < 0) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Offset must be non-negative'
      });
    }

    const portnum = req.query.portnum ? parseInt(req.query.portnum as string, 10) : undefined;
    const from_node = req.query.from_node ? parseInt(req.query.from_node as string, 10) : undefined;
    const to_node = req.query.to_node ? parseInt(req.query.to_node as string, 10) : undefined;
    const channel = req.query.channel ? parseInt(req.query.channel as string, 10) : undefined;
    const encrypted = req.query.encrypted === 'true' ? true : req.query.encrypted === 'false' ? false : undefined;
    const since = req.query.since ? normalizeSinceToMs(req.query.since as string) : undefined;

    const filterOptions = { portnum, from_node, to_node, channel, encrypted, since, sourceId };

    const [packets, total] = await Promise.all([
      packetLogService.getPacketsAsync({
        offset,
        limit,
        ...filterOptions
      }),
      packetLogService.getPacketCountAsync(filterOptions)
    ]);

    res.json({
      success: true,
      count: packets.length,
      total,
      offset,
      limit,
      data: packets.map(withMeshtasticProtocol)
    });
  } catch (error) {
    logger.error('❌ Error fetching packet logs:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to retrieve packet logs'
    });
  }
});

/**
 * GET /api/v1/packets/:id
 * Get single packet by ID
 */
router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Invalid packet ID'
      });
    }

    // Packet IDs are a global primary key, so scope the read to the caller's
    // source: require a sourceId and treat a packet from a different source as
    // Not Found — otherwise a caller on source A could read source B's packet
    // by guessing its id.
    const sourceId = requireScopedSourceId(req, res);
    if (!sourceId) return;

    if (isAnyMeshCoreSourceType((req as SourcedRequest).source?.type)) {
      const row = await databaseService.meshcore.getPacketByIdForSource(sourceId, id);
      if (!row) return fail(res, 404, 'NOT_FOUND', 'Packet not found');
      const plaintext = await plaintextForPacket((req as SourcedRequest).user ?? null, sourceId, row);
      return res.json({ success: true, data: meshcorePacketToV1(row, { plaintext }) });
    }

    const packet = await packetLogService.getPacketByIdAsync(id);
    if (!packet || packet.sourceId !== sourceId) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: 'Packet not found'
      });
    }

    res.json({
      success: true,
      data: withMeshtasticProtocol(packet)
    });
  } catch (error) {
    logger.error('❌ Error fetching packet:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to retrieve packet'
    });
  }
});

export default router;
