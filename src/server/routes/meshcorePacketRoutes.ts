/**
 * MeshCore API Routes — packets group
 *
 * OTA packet log (list/stats/export/clear) for the MeshCore Packet Monitor.
 * Extracted verbatim from the former monolithic `meshcoreRoutes.ts`
 * (epic #3962 Task 4.3).
 */

import { Router, Request, Response } from 'express';
import databaseService from '../../services/database.js';
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
/**
 * True when `sourceId` names a `meshcore_mqtt` ingest source.
 *
 * Swallows lookup failures and answers `false`, because every caller uses this
 * only to pick which retention cap to *report*. A source-table hiccup should
 * cost a slightly wrong number in the settings box, not a 500 on the packet
 * list itself.
 */
async function isMeshCoreIngestSource(sourceId: string): Promise<boolean> {
  try {
    const src = await databaseService.sources?.getSource?.(sourceId);
    return src?.type === 'meshcore_mqtt';
  } catch {
    return false;
  }
}

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

      // The cap that applies to THIS source: retention is per-source-kind
      // (#5040 Phase 2), so a region feed reports its own, far larger cap.
      //
      // Non-fatal by design. This only decides which cap NUMBER to display, so
      // a source row that cannot be read must degrade to the device default,
      // never fail the packet list — the packets are the point of the endpoint.
      const isIngestSource = await isMeshCoreIngestSource(sourceId);
      const [packets, total, enabled, maxAgeHours] = await Promise.all([
        meshcorePacketLogService.getPackets(query),
        meshcorePacketLogService.getPacketCount({ sourceId, payloadType: query.payloadType, routeType: query.routeType, since: query.since }),
        meshcorePacketLogService.isEnabled(),
        meshcorePacketLogService.getMaxAgeHours(),
      ]);

      res.json({ packets, total, offset, limit, enabled, maxCount: isIngestSource ? await meshcorePacketLogService.getIngestMaxCount() : maxCount, maxAgeHours, isIngestSource });
    } catch (error) {
      logger.error('[API] Error fetching MeshCore packets:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch packets' });
    }
  },
);

/**
 * GET /api/sources/:id/meshcore/packets/grouped
 *
 * The collapsed Packet Monitor view (#5040 Phase 2b): one entry per distinct
 * frame, with a `meshcore_mqtt` source's per-observer receptions folded into
 * `observerCount` / `receptionCount` and the best signal any observer reported.
 *
 * A device-backed source records one reception per frame, so this endpoint is
 * equivalent to `/packets` for it — the frontend can offer the toggle on every
 * MeshCore source rather than branching on source type.
 *
 * NOTE `observerCount === 0` means "our own radio heard it", not "nobody heard
 * it": COUNT(DISTINCT) skips the NULL observerId a local reception carries.
 * Renderers must show that as "local", never as the digit 0.
 */
router.get(
  '/packets/grouped',
  optionalAuth(),
  requirePermission('packetmonitor', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id?: string }).id!;
      const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);
      const maxCount = await meshcorePacketLogService.getMaxCount();
      const requestedLimit = parseInt(req.query.limit as string, 10);
      const effectiveLimit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : maxCount;
      const limit = Math.min(Math.max(effectiveLimit, 1), MESHCORE_PACKET_MAX_LIMIT);
      const payloadType = req.query.payload_type !== undefined ? parseInt(req.query.payload_type as string, 10) : undefined;
      const routeType = req.query.route_type !== undefined ? parseInt(req.query.route_type as string, 10) : undefined;
      let since = req.query.since !== undefined ? parseInt(req.query.since as string, 10) : undefined;
      if (since !== undefined && since < 1e12) since = since * 1000;

      const query = {
        sourceId,
        offset,
        limit,
        payloadType: Number.isFinite(payloadType as number) ? payloadType : undefined,
        routeType: Number.isFinite(routeType as number) ? routeType : undefined,
        since: Number.isFinite(since as number) ? since : undefined,
      };

      // The cap that applies to THIS source: retention is per-source-kind
      // (#5040 Phase 2), so a region feed reports its own, far larger cap.
      const src = await databaseService.sources.getSource(sourceId);
      const isIngestSource = src?.type === 'meshcore_mqtt';
      const [packets, total, enabled, maxAgeHours] = await Promise.all([
        meshcorePacketLogService.getGroupedPackets(query),
        // Group count, not row count — paging is over groups here.
        meshcorePacketLogService.getGroupedPacketCount({
          sourceId,
          payloadType: query.payloadType,
          routeType: query.routeType,
          since: query.since,
        }),
        meshcorePacketLogService.isEnabled(),
        meshcorePacketLogService.getMaxAgeHours(),
      ]);

      res.json({ packets, total, offset, limit, enabled, maxCount: isIngestSource ? await meshcorePacketLogService.getIngestMaxCount() : maxCount, maxAgeHours, isIngestSource });
    } catch (error) {
      logger.error('[API] Error fetching grouped MeshCore packets:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch grouped packets' });
    }
  },
);

/**
 * GET /api/sources/:id/meshcore/packets/receptions?raw_hex=...
 *
 * Expands one grouped row into the individual observer receptions behind it,
 * oldest-first (#5040 Phase 2b). Each carries its own SNR/RSSI and the key of
 * the observer that heard it — the coverage detail the collapsed row summarises.
 */
router.get(
  '/packets/receptions',
  optionalAuth(),
  requirePermission('packetmonitor', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id?: string }).id!;
      const rawHex = typeof req.query.raw_hex === 'string' ? req.query.raw_hex.trim() : '';
      if (!rawHex) {
        return res.status(400).json({ success: false, error: 'raw_hex is required' });
      }
      const receptions = await meshcorePacketLogService.getPacketReceptions(sourceId, rawHex);
      res.json({ receptions, total: receptions.length });
    } catch (error) {
      logger.error('[API] Error fetching MeshCore packet receptions:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch receptions' });
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
      // Report the cap that actually applies to THIS source. Retention is
      // per-source-kind (#5040 Phase 2): a region feed writes one row per
      // observer and gets its own, far larger cap, so showing the device
      // default here would misreport when the log is about to trim.
      const isIngest = await isMeshCoreIngestSource(sourceId);
      const [total, enabled, deviceMaxCount, ingestMaxCount, maxAgeHours] = await Promise.all([
        meshcorePacketLogService.getPacketCount({ sourceId }),
        meshcorePacketLogService.isEnabled(),
        meshcorePacketLogService.getMaxCount(),
        meshcorePacketLogService.getIngestMaxCount(),
        meshcorePacketLogService.getMaxAgeHours(),
      ]);
      const maxCount = isIngest ? ingestMaxCount : deviceMaxCount;
      res.json({ total, enabled, maxCount, maxAgeHours, isIngestSource: isIngest });
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
