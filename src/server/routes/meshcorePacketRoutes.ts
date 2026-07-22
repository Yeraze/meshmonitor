/**
 * MeshCore API Routes — packets group
 *
 * OTA packet log (list/stats/export/clear) for the MeshCore Packet Monitor.
 * Extracted verbatim from the former monolithic `meshcoreRoutes.ts`
 * (epic #3962 Task 4.3).
 */

import { Router, Request, Response } from 'express';
import { logger } from '../../utils/logger.js';
import { requireAuth, optionalAuth, requirePermission } from '../auth/authMiddleware.js';
import meshcorePacketLogService from '../services/meshcorePacketLogService.js';
import { decodeMeshCorePacket } from '../../utils/meshcorePacketDecode.js';
import { auditMeshcoreEvent } from './meshcoreRouteShared.js';

const router = Router({ mergeParams: true });

/**
 * GET /api/sources/:id/meshcore/packets
 *
 * Paginated OTA packet log for the MeshCore Packet Monitor (newest first).
 * Filters: payload_type, route_type, since (ms). Returns the same envelope
 * shape as the Meshtastic packet monitor so the frontend can share logic.
 */
const MESHCORE_PACKET_MAX_LIMIT = 1000;

router.get(
  '/packets',
  optionalAuth(),
  requirePermission('packetmonitor', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id?: string }).id!;
      const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);
      // Honor the user-configured retention cap (meshcore_packet_log_max_count)
      // as the default effective limit, the same way the export endpoint does
      // (issue #3690). An explicit client-supplied `limit` still wins so a
      // caller can request fewer rows; both are clamped by the hard ceiling.
      const maxCount = await meshcorePacketLogService.getMaxCount();
      const requestedLimit = parseInt(req.query.limit as string, 10);
      const effectiveLimit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : maxCount;
      const limit = Math.min(Math.max(effectiveLimit, 1), MESHCORE_PACKET_MAX_LIMIT);
      const payloadType = req.query.payload_type !== undefined ? parseInt(req.query.payload_type as string, 10) : undefined;
      const routeType = req.query.route_type !== undefined ? parseInt(req.query.route_type as string, 10) : undefined;
      let since = req.query.since !== undefined ? parseInt(req.query.since as string, 10) : undefined;
      // Accept seconds or milliseconds (mirror Meshtastic packet routes).
      if (since !== undefined && since < 1e12) since = since * 1000;

      const query = {
        sourceId,
        offset,
        limit,
        payloadType: Number.isFinite(payloadType as number) ? payloadType : undefined,
        routeType: Number.isFinite(routeType as number) ? routeType : undefined,
        since: Number.isFinite(since as number) ? since : undefined,
      };

      const [packets, total, enabled, maxAgeHours] = await Promise.all([
        meshcorePacketLogService.getPackets(query),
        meshcorePacketLogService.getPacketCount({ sourceId, payloadType: query.payloadType, routeType: query.routeType, since: query.since }),
        meshcorePacketLogService.isEnabled(),
        meshcorePacketLogService.getMaxAgeHours(),
      ]);

      res.json({ packets, total, offset, limit, enabled, maxCount, maxAgeHours });
    } catch (error) {
      logger.error('[API] Error fetching MeshCore packets:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch packets' });
    }
  },
);

/**
 * GET /api/sources/:id/meshcore/packets/stats
 *
 * Summary stats for the MeshCore Packet Monitor: total count, enabled flag,
 * and the retention limits.
 */
router.get(
  '/packets/stats',
  optionalAuth(),
  requirePermission('packetmonitor', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id?: string }).id!;
      const [total, enabled, maxCount, maxAgeHours] = await Promise.all([
        meshcorePacketLogService.getPacketCount({ sourceId }),
        meshcorePacketLogService.isEnabled(),
        meshcorePacketLogService.getMaxCount(),
        meshcorePacketLogService.getMaxAgeHours(),
      ]);
      res.json({ total, enabled, maxCount, maxAgeHours });
    } catch (error) {
      logger.error('[API] Error fetching MeshCore packet stats:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch packet stats' });
    }
  },
);

/**
 * GET /api/sources/:id/meshcore/packets/export
 *
 * Export this source's OTA packet log as JSONL (newest first), honoring the
 * same payload_type / route_type / since filters as the list endpoint. Streams
 * one JSON object per line as an attachment download — the MeshCore analogue of
 * the Meshtastic packet-monitor export (issue #3391).
 *
 * Each line is the raw DB row plus a `decoded` field carrying the decoded
 * unencrypted on-wire data (ADVERT name/lat/lon/pubkey/flags, ACK codes, and
 * the plaintext dest/src hash prefix of encrypted messages), matching the
 * Packet Monitor's decode modal (issue #3937). Encrypted message bodies stay
 * undecoded by design.
 */
router.get(
  '/packets/export',
  optionalAuth(),
  requirePermission('packetmonitor', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id?: string }).id!;
      const payloadType = req.query.payload_type !== undefined ? parseInt(req.query.payload_type as string, 10) : undefined;
      const routeType = req.query.route_type !== undefined ? parseInt(req.query.route_type as string, 10) : undefined;
      let since = req.query.since !== undefined ? parseInt(req.query.since as string, 10) : undefined;
      // Accept seconds or milliseconds (mirror the list endpoint).
      if (since !== undefined && since < 1e12) since = since * 1000;

      // Export every retained packet matching the filters (up to the cap).
      const maxCount = await meshcorePacketLogService.getMaxCount();
      const packets = await meshcorePacketLogService.getPackets({
        sourceId,
        offset: 0,
        limit: maxCount,
        payloadType: Number.isFinite(payloadType as number) ? payloadType : undefined,
        routeType: Number.isFinite(routeType as number) ? routeType : undefined,
        since: Number.isFinite(since as number) ? since : undefined,
      });

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
      const hasActiveFilters = req.query.payload_type !== undefined ||
                               req.query.route_type !== undefined ||
                               req.query.since !== undefined;
      const filterInfo = hasActiveFilters ? '-filtered' : '';
      const filename = `meshcore-packet-monitor${filterInfo}-${timestamp}.jsonl`;

      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      for (const packet of packets) {
        // Attach a decoded view of the (unencrypted) on-wire fields alongside
        // the raw DB row so exports carry the same information the Packet
        // Monitor's "click to decode" modal shows — full ADVERT decode
        // (name, lat/lon, pubkey, flags), ACK codes, and the plaintext
        // dest/src hash prefix of encrypted message payloads. Encrypted
        // message bodies remain undecoded by design. `rawHex` is preserved so
        // nothing is lost for callers doing their own analysis. Decoding never
        // throws — failures surface as null / a `.errors` array (issue #3937).
        const decoded = decodeMeshCorePacket(packet.rawHex);
        res.write(JSON.stringify({ ...packet, decoded }) + '\n');
      }
      res.end();
      logger.debug(`[API] Exported ${packets.length} MeshCore packets to ${filename}`);
    } catch (error) {
      logger.error('[API] Error exporting MeshCore packets:', error);
      res.status(500).json({ success: false, error: 'Failed to export packets' });
    }
  },
);

/**
 * DELETE /api/sources/:id/meshcore/packets
 *
 * Clear this source's OTA packet log. Requires packetmonitor:write.
 */
router.delete(
  '/packets',
  requireAuth(),
  requirePermission('packetmonitor', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id?: string }).id!;
      const deleted = await meshcorePacketLogService.clearPackets(sourceId);
      auditMeshcoreEvent(req, 'meshcore_packets_cleared', 'configuration', { sourceId, deleted });
      res.json({ success: true, deleted });
    } catch (error) {
      logger.error('[API] Error clearing MeshCore packets:', error);
      res.status(500).json({ success: false, error: 'Failed to clear packets' });
    }
  },
);

export default router;
