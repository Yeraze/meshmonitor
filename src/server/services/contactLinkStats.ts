/**
 * Contact graph series (Smart Hops, Link Quality) for the shared
 * `/api/telemetry/:nodeId/{smarthops,linkquality}` endpoints (#6262).
 *
 * A Meshtastic node id keeps reading its stored telemetry. A MeshCore public
 * key (64 hex) is served by a read-side adapter: hop samples come from the
 * messages we received from that contact, and the same shared scoring code
 * (`computeRollingHopStats`, `replayLinkQuality`) produces the series. No new
 * writer, timer or per-contact state.
 */
import databaseService from '../../services/database.js';
import { computeRollingHopStats, HOP_STATS_WINDOW_MS, type HopStatsPoint } from '../utils/hopStats.js';
import { replayLinkQuality } from '../utils/linkQuality.js';

const MESHCORE_PUBKEY_RE = /^[0-9a-f]{64}$/i;

export function isMeshCorePubKey(nodeId: string): boolean {
  return MESHCORE_PUBKEY_RE.test(nodeId);
}

export async function getSmartHopsSeries(
  nodeId: string,
  sourceId: string,
  since: number,
  intervalMinutes: number
): Promise<HopStatsPoint[]> {
  if (!isMeshCorePubKey(nodeId)) {
    return databaseService.getSmartHopsStatsAsync(nodeId, since, intervalMinutes, sourceId);
  }
  const samples = await databaseService.meshcore.getContactHopSamples(
    sourceId,
    nodeId.toLowerCase(),
    since - HOP_STATS_WINDOW_MS
  );
  return computeRollingHopStats(samples, since, intervalMinutes, Date.now());
}

export async function getLinkQualitySeries(
  nodeId: string,
  sourceId: string,
  since: number
): Promise<Array<{ timestamp: number; quality: number }>> {
  if (!isMeshCorePubKey(nodeId)) {
    return databaseService.getLinkQualityHistoryAsync(nodeId, since, sourceId);
  }
  // Warm the score up with the day before the window so a series does not
  // restart from the initial score at the window edge.
  const samples = await databaseService.meshcore.getContactHopSamples(
    sourceId,
    nodeId.toLowerCase(),
    since - HOP_STATS_WINDOW_MS
  );
  return replayLinkQuality(samples, since);
}
