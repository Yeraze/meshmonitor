/**
 * Rolling-window hop statistics, shared by Meshtastic (`messageHops`
 * telemetry) and MeshCore (`meshcore_messages.hopCount`) smart-hops graphs.
 */

export interface HopSample {
  timestamp: number;
  value: number;
}

export interface HopStatsPoint {
  timestamp: number;
  minHops: number;
  maxHops: number;
  avgHops: number;
}

export const HOP_STATS_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Each output point holds min/max/avg of all samples in the 24 hours before it.
 * Points sit on interval boundaries from `sinceTs` to `now`. Samples must be
 * sorted ascending by timestamp (the function sorts a copy to be safe).
 */
export function computeRollingHopStats(
  samples: HopSample[],
  sinceTs: number,
  intervalMinutes: number = 15,
  now: number = Date.now()
): HopStatsPoint[] {
  if (samples.length === 0) return [];

  const telemetry = [...samples].sort((a, b) => a.timestamp - b.timestamp);
  const intervalMs = intervalMinutes * 60 * 1000;
  const results: HopStatsPoint[] = [];

  let currentTime = Math.ceil(sinceTs / intervalMs) * intervalMs;
  while (currentTime <= now) {
    const windowStart = currentTime - HOP_STATS_WINDOW_MS;
    const windowData = telemetry.filter((t) => t.timestamp >= windowStart && t.timestamp <= currentTime);
    if (windowData.length > 0) {
      const values = windowData.map((t) => t.value);
      const minHops = Math.min(...values);
      const maxHops = Math.max(...values);
      const avgHops = Math.round((values.reduce((sum, v) => sum + v, 0) / values.length) * 100) / 100;
      results.push({ timestamp: currentTime, minHops, maxHops, avgHops });
    }
    currentTime += intervalMs;
  }
  return results;
}
