/**
 * One viewer-correct page of a MeshCore source's OTA packet log (#6263).
 *
 * Shared by the Packet Monitor route (`meshcorePacketRoutes.ts`) and the v1 API.
 * The caller has already checked `packetmonitor:read` on the source. Plaintext
 * for group packets (GRP_TXT / GRP_DATA) is added only when `viewer` is given
 * and may read a channel holding the key (`decodeGroupPacketForViewer`); a
 * viewer without access gets `null`, the same answer as a server without the key.
 */
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import type { DbMeshCorePacket, MeshCorePacketQuery } from '../../db/repositories/meshcore.js';
import meshcorePacketLogService from './meshcorePacketLogService.js';
import { decodeGroupPacketForViewer, type PacketDecodeViewer } from '../utils/meshcorePacketPlaintext.js';

export const MESHCORE_PACKET_MAX_LIMIT = 1000;

/**
 * True when `sourceId` names a `meshcore_mqtt` ingest source. Swallows lookup
 * failures (only used to choose which retention cap to report).
 */
export async function isMeshCoreIngestSource(sourceId: string): Promise<boolean> {
  try {
    const src = await databaseService.sources?.getSource?.(sourceId);
    return src?.type === 'meshcore_mqtt';
  } catch (err) {
    logger.debug(`isMeshCoreIngestSource lookup failed for ${sourceId}:`, err);
    return false;
  }
}

export interface MeshCorePacketListOptions {
  sourceId: string;
  /** Filters from `parseMeshCorePacketFilters`. */
  filters: Omit<MeshCorePacketQuery, 'sourceId' | 'offset' | 'limit' | 'untilTs' | 'untilId'>;
  offset: number;
  /** Requested limit; clamped to 1..MESHCORE_PACKET_MAX_LIMIT, default = retention cap. */
  requestedLimit?: number;
  cursor?: { untilTs: number; untilId: number } | null;
  /** When set, group packets get a `plaintext` entry decided for this viewer. */
  plaintextFor?: { viewer: PacketDecodeViewer | null };
}

export async function listMeshCorePacketsForViewer(opts: MeshCorePacketListOptions) {
  const { sourceId, filters, offset, cursor } = opts;
  // The user-configured retention cap is the default effective limit; an
  // explicit client `limit` still wins, both clamped by the hard ceiling.
  const maxCount = await meshcorePacketLogService.getMaxCount();
  const effectiveLimit =
    typeof opts.requestedLimit === 'number' && Number.isFinite(opts.requestedLimit) && opts.requestedLimit > 0
      ? opts.requestedLimit
      : maxCount;
  const limit = Math.min(Math.max(effectiveLimit, 1), MESHCORE_PACKET_MAX_LIMIT);

  const filterQuery = { sourceId, ...filters };
  const query = { ...filterQuery, offset: cursor ? 0 : offset, limit, ...(cursor ?? {}) };

  // Non-fatal by design: only decides which cap NUMBER to display.
  const isIngestSource = await isMeshCoreIngestSource(sourceId);
  const [packets, total, enabled, maxAgeHours] = await Promise.all([
    meshcorePacketLogService.getPackets(query),
    meshcorePacketLogService.getPacketCount(filterQuery),
    meshcorePacketLogService.isEnabled(),
    meshcorePacketLogService.getMaxAgeHours(),
  ]);
  // A short page is the last one. A full page may or may not be: offset paging
  // compares against the total; cursor paging counts what remains below the cursor.
  let hasMore = false;
  if (packets.length >= limit) {
    hasMore = cursor
      ? Number(await meshcorePacketLogService.getPacketCount({ ...filterQuery, ...cursor })) > limit
      : offset + packets.length < Number(total);
  }
  const last = packets[packets.length - 1];
  const nextCursor = hasMore && last ? `${last.timestamp}_${last.id}` : null;

  let plaintext: Map<number, string | null> | undefined;
  if (opts.plaintextFor) {
    plaintext = new Map();
    for (const p of packets) {
      if (p.id === undefined) continue;
      plaintext.set(p.id, await plaintextForPacket(opts.plaintextFor.viewer, sourceId, p));
    }
  }

  return {
    packets,
    total,
    offset,
    limit,
    hasMore,
    nextCursor,
    enabled,
    maxCount: isIngestSource ? await meshcorePacketLogService.getIngestMaxCount() : maxCount,
    maxAgeHours,
    isIngestSource,
    plaintext,
  };
}

/** Text of a group packet the viewer may read, else null. Non-group packets: null. */
export async function plaintextForPacket(
  viewer: PacketDecodeViewer | null,
  sourceId: string,
  packet: DbMeshCorePacket,
): Promise<string | null> {
  if ((packet.payloadType !== 0x05 && packet.payloadType !== 0x06) || !packet.rawHex) return null;
  try {
    const result = await decodeGroupPacketForViewer(viewer, sourceId, packet.rawHex);
    if (result && result.decrypted) return result.text?.text ?? null;
  } catch (err) {
    logger.debug('plaintextForPacket failed:', err);
  }
  return null;
}
