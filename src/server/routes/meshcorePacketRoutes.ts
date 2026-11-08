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
import { ok, fail } from '../utils/apiResponse.js';
import { decodeGroupPacketForViewer, type PacketDecodeViewer } from '../utils/meshcorePacketPlaintext.js';

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
const MESHCORE_SEARCH_MAX_LEN = 100;

type ParsedPacketFilters =
  | {
      ok: true;
      filters: {
        payloadType?: number;
        routeType?: number;
        since?: number;
        search?: string;
        srcHash?: string;
        senderPubKey?: string;
        pathHash?: string;
      };
    }
  | { ok: false; code: string; message: string };

/**
 * One parser for every packet endpoint (list, grouped, export, distribution).
 * Params: payload_type, route_type, since (s or ms), search, src_hash,
 * sender (alias advert_pubkey), path_hash.
 */
export function parseMeshCorePacketFilters(q: Request['query']): ParsedPacketFilters {
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
  const num = (v: unknown): number | undefined => {
    if (v === undefined) return undefined;
    const n = parseInt(String(v), 10);
    return Number.isFinite(n) ? n : undefined;
  };
  let since = num(q.since);
  // Accept seconds or milliseconds (mirror Meshtastic packet routes).
  if (since !== undefined && since < 1e12) since = since * 1000;

  const search = str(q.search)?.trim() || undefined;
  if (search && search.length > MESHCORE_SEARCH_MAX_LEN) {
    return { ok: false, code: 'INVALID_SEARCH', message: `search must be at most ${MESHCORE_SEARCH_MAX_LEN} characters` };
  }
  const hashOk = (v: string) => /^[0-9a-f]{2,6}$/i.test(v) && v.length % 2 === 0;
  const srcHash = str(q.src_hash);
  if (srcHash !== undefined && !hashOk(srcHash)) {
    return { ok: false, code: 'INVALID_SRC_HASH', message: 'src_hash must be 1 to 3 bytes of hex' };
  }
  const pathHash = str(q.path_hash);
  if (pathHash !== undefined && !hashOk(pathHash)) {
    return { ok: false, code: 'INVALID_PATH_HASH', message: 'path_hash must be 1 to 3 bytes of hex' };
  }
  const sender = str(q.sender) ?? str(q.advert_pubkey);
  if (sender !== undefined && !/^[0-9a-f]{2,64}$/i.test(sender)) {
    return { ok: false, code: 'INVALID_SENDER', message: 'sender must be 2 to 64 hex characters' };
  }
  return {
    ok: true,
    filters: {
      payloadType: num(q.payload_type),
      routeType: num(q.route_type),
      since,
      search,
      srcHash: srcHash?.toLowerCase(),
      senderPubKey: sender?.toLowerCase(),
      pathHash: pathHash?.toLowerCase(),
    },
  };
}

/** Parse `cursor=<ts>_<id>`; null when absent, undefined when malformed. */
function parseCursor(v: unknown): { untilTs: number; untilId: number } | null | undefined {
  if (v === undefined || v === '') return null;
  const m = /^(\d{1,16})_(\d{1,16})$/.exec(String(v));
  if (!m) return undefined;
  return { untilTs: Number(m[1]), untilId: Number(m[2]) };
}

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
      const parsed = parseMeshCorePacketFilters(req.query);
      if (!parsed.ok) return fail(res, 400, parsed.code, parsed.message);
      const cursor = parseCursor(req.query.cursor);
      if (cursor === undefined) return fail(res, 400, 'INVALID_CURSOR', 'cursor must be <timestamp>_<id>');

      const filterQuery = { sourceId, ...parsed.filters };
      const query = {
        ...filterQuery,
        offset: cursor ? 0 : offset,
        limit,
        ...(cursor ?? {}),
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
        meshcorePacketLogService.getPacketCount(filterQuery),
        meshcorePacketLogService.isEnabled(),
        meshcorePacketLogService.getMaxAgeHours(),
      ]);
      // A short page is the last one. A full page may or may not be: offset
      // paging compares against the total; cursor paging counts what remains
      // below the cursor (the total ignores the cursor).
      let hasMore = false;
      if (packets.length >= limit) {
        hasMore = cursor
          ? Number(await meshcorePacketLogService.getPacketCount({ ...filterQuery, ...cursor })) > limit
          : offset + packets.length < Number(total);
      }
      const last = packets[packets.length - 1];
      const nextCursor = hasMore && last ? `${last.timestamp}_${last.id}` : null;

      res.json({ packets, total, offset, limit, hasMore, nextCursor, enabled, maxCount: isIngestSource ? await meshcorePacketLogService.getIngestMaxCount() : maxCount, maxAgeHours, isIngestSource });
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
      const parsed = parseMeshCorePacketFilters(req.query);
      if (!parsed.ok) return fail(res, 400, parsed.code, parsed.message);

      const query = { sourceId, offset, limit, ...parsed.filters };

      // The cap that applies to THIS source: retention is per-source-kind
      // (#5040 Phase 2), so a region feed reports its own, far larger cap.
      const src = await databaseService.sources.getSource(sourceId);
      const isIngestSource = src?.type === 'meshcore_mqtt';
      const [packets, total, enabled, maxAgeHours] = await Promise.all([
        meshcorePacketLogService.getGroupedPackets(query),
        // Group count, not row count — paging is over groups here.
        meshcorePacketLogService.getGroupedPacketCount({ sourceId, ...parsed.filters }),
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
 * GET /api/sources/:id/meshcore/packets/stats/distribution
 *
 * Payload-type, route-type and top-advert-sender distribution under the same
 * filters as the list. Response: { byPayloadType, byRouteType, topSenders, total, enabled }.
 * Counts are receptions (rows), like the flat list.
 */
router.get(
  '/packets/stats/distribution',
  optionalAuth(),
  requirePermission('packetmonitor', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id?: string }).id!;
      const parsed = parseMeshCorePacketFilters(req.query);
      if (!parsed.ok) return fail(res, 400, parsed.code, parsed.message);
      const [distribution, enabled] = await Promise.all([
        meshcorePacketLogService.getDistribution({ sourceId, ...parsed.filters }),
        meshcorePacketLogService.isEnabled(),
      ]);
      return res.json({ ...distribution, enabled });
    } catch (error) {
      logger.error('[API] Error fetching MeshCore packet distribution:', error);
      return fail(res, 500, 'DISTRIBUTION_FAILED', 'Failed to fetch packet distribution');
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
      const parsed = parseMeshCorePacketFilters(req.query);
      if (!parsed.ok) return fail(res, 400, parsed.code, parsed.message);

      // Export every retained packet matching the filters (up to the cap).
      const maxCount = await meshcorePacketLogService.getMaxCount();
      const packets = await meshcorePacketLogService.getPackets({
        sourceId,
        offset: 0,
        limit: maxCount,
        ...parsed.filters,
      });

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
      const hasActiveFilters = Object.values(parsed.filters).some((v) => v !== undefined);
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
 * Longest `rawHex` the decode endpoint reads, in hex characters. A MeshCore
 * frame tops out at 255 bytes (firmware MAX_TRANS_UNIT); 512 bytes leaves room
 * without letting a caller hand the decoder an arbitrary blob.
 */
export const MESHCORE_DECODE_MAX_HEX_CHARS = 1024;

/**
 * POST /api/sources/:id/meshcore/packets/decode   body: { rawHex }
 *
 * Decrypt-on-read for the Packet Monitor decode modal (#5567, #5568): opens
 * one GRP_TXT / GRP_DATA frame with a channel key the server holds, if the
 * caller may read a channel with that key. Nothing is stored and no secret is
 * returned. A caller without access to the key gets the same body as when no
 * key exists (`decrypted: false`), so the endpoint does not reveal which keys
 * the server holds.
 *
 * POST because the frame rides the body, not because it changes anything. It
 * sends no mesh traffic. Rate limiting is the global `apiLimiter` on `/api`.
 */
router.post(
  '/packets/decode',
  optionalAuth(),
  requirePermission('packetmonitor', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id?: string }).id!;
      const raw = (req.body as { rawHex?: unknown } | undefined)?.rawHex;
      if (typeof raw !== 'string') {
        return fail(res, 400, 'INVALID_RAW_HEX', 'rawHex is required');
      }
      if (raw.length > MESHCORE_DECODE_MAX_HEX_CHARS) {
        return fail(res, 413, 'PAYLOAD_TOO_LARGE', 'rawHex is too long');
      }
      const rawHex = raw.trim();
      if (rawHex.length === 0 || rawHex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(rawHex)) {
        return fail(res, 400, 'INVALID_RAW_HEX', 'rawHex must be an even-length hex string');
      }

      const viewer = (req as Request & { user?: PacketDecodeViewer }).user ?? null;
      const result = await decodeGroupPacketForViewer(viewer, sourceId, rawHex);
      if (!result) {
        return fail(res, 400, 'NOT_GROUP_PACKET', 'Not a GRP_TXT or GRP_DATA packet');
      }
      return ok(res, result);
    } catch (error) {
      logger.error('[API] Error decoding MeshCore group packet:', error);
      return fail(res, 500, 'DECODE_FAILED', 'Failed to decode packet');
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
