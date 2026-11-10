/**
 * One reader for the MeshCore packet log over a time window (#6281 S2).
 *
 * Mesh Issues C2 (advert cadence) and the MeshCore security scan both read the
 * log through this loader, so the paging bounds live in one place. It is the
 * former private `loadMeshcoreAdverts` of `meshIssuesAnalysisService`, with
 * the rows widened to carry `rawHex`, `payloadType` and `srcHash`.
 *
 * Bounds: 5,000 rows per page, at most 10 pages per source (50,000 rows).
 */
import databaseService from '../../services/database.js';

export const MESHCORE_PACKET_PAGE_SIZE = 5000;
export const MESHCORE_PACKET_MAX_PAGES = 10;

export interface MeshcorePacketRow {
  id?: number;
  sourceId: string;
  /** Server receive time, ms. */
  timestamp: number;
  payloadType: number;
  routeType: number | null;
  hopCount: number | null;
  senderPubKey: string | null;
  srcHash: string | null;
  rawHex: string | null;
  observerId: string | null;
}

/**
 * Packets of `sourceIds` captured at or after `sinceMs`, newest first per
 * source. `payloadType` narrows the read. Throws on a repository failure so a
 * caller can degrade (the loader never swallows it).
 */
export async function loadMeshcorePackets(
  sourceIds: string[],
  sinceMs: number,
  opts: { payloadType?: number } = {},
): Promise<MeshcorePacketRow[]> {
  const out: MeshcorePacketRow[] = [];
  for (const sourceId of sourceIds) {
    for (let page = 0; page < MESHCORE_PACKET_MAX_PAGES; page++) {
      const rows = await databaseService.meshcore.getPackets({
        sourceId,
        ...(opts.payloadType !== undefined ? { payloadType: opts.payloadType } : {}),
        since: sinceMs,
        limit: MESHCORE_PACKET_PAGE_SIZE,
        offset: page * MESHCORE_PACKET_PAGE_SIZE,
      });
      for (const r of rows) {
        out.push({
          id: r.id,
          sourceId: r.sourceId,
          timestamp: Number(r.timestamp),
          payloadType: Number(r.payloadType),
          routeType: r.routeType ?? null,
          hopCount: r.hopCount ?? null,
          senderPubKey: r.senderPubKey ?? null,
          srcHash: r.srcHash ?? null,
          rawHex: r.rawHex ?? null,
          observerId: r.observerId ?? null,
        });
      }
      if (rows.length < MESHCORE_PACKET_PAGE_SIZE) break;
    }
  }
  return out;
}
