/**
 * MQTT position history (#5364/#5365 Phase 3).
 *
 * TCP sources have always written every received fix to the `telemetry` table
 * (latitude / longitude / altitude rows), which feeds Position History and
 * the aircraft flight trails. MQTT sources only refreshed the node row, so a
 * node heard over MQTT had no history at all. This writes the same rows for
 * MQTT fixes.
 *
 * A regional feed delivers the same packet once per gateway that heard it, so
 * a short-lived seen-set keyed on (source, sender, packet id) stores each fix
 * once. Packets without an id (0) can't be matched and are stored as-is.
 */
import databaseService from '../../services/database.js';
import type { DbTelemetry } from '../../services/database.js';
import { logger } from '../../utils/logger.js';

/** How long a (source, sender, packet id) stays in the seen-set. */
export const MQTT_POSITION_DEDUPE_MS = 10 * 60_000;
/** Upper bound on the seen-set, so a busy feed can't grow it without limit. */
export const MQTT_POSITION_DEDUPE_MAX = 50_000;

const seen = new Map<string, number>();

/**
 * True the first time a (source, sender, packet id) is offered within the
 * window; false for repeats. Exported for tests.
 */
export function claimMqttPositionPacket(sourceId: string, fromNum: number, packetId: number, nowMs: number): boolean {
  if (!packetId) return true;
  const key = `${sourceId}:${fromNum}:${packetId}`;
  const at = seen.get(key);
  if (at != null && nowMs - at < MQTT_POSITION_DEDUPE_MS) return false;
  if (at != null) seen.delete(key);
  seen.set(key, nowMs);
  if (seen.size > MQTT_POSITION_DEDUPE_MAX) {
    // Map keeps insertion order: drop the oldest tenth in one pass.
    let drop = Math.ceil(MQTT_POSITION_DEDUPE_MAX / 10);
    for (const k of seen.keys()) {
      seen.delete(k);
      if (--drop <= 0) break;
    }
  }
  return true;
}

/** Test hook. */
export function resetMqttPositionDedupe(): void {
  seen.clear();
}

export interface MqttPositionFix {
  sourceId: string;
  fromNum: number;
  nodeId: string;
  packetId: number;
  latitude: number;
  longitude: number;
  altitude?: number;
  precisionBits?: number;
  channel?: number;
  /** Sender's own clock (seconds), if the packet carried one. */
  positionTimeSec?: number;
  nowMs: number;
}

/**
 * Store one MQTT fix as position telemetry, matching the TCP path's rows
 * (`meshtasticManager` "Always save position to telemetry"): server receive
 * time in `timestamp`, the sender's clock in `packetTimestamp`. Non-throwing.
 */
export async function recordMqttPositionHistory(fix: MqttPositionFix): Promise<boolean> {
  if (!claimMqttPositionPacket(fix.sourceId, fix.fromNum, fix.packetId, fix.nowMs)) return false;
  const base = {
    nodeId: fix.nodeId,
    nodeNum: fix.fromNum,
    timestamp: fix.nowMs,
    createdAt: fix.nowMs,
    packetTimestamp: fix.positionTimeSec ? fix.positionTimeSec * 1000 : undefined,
    packetId: fix.packetId || undefined,
    channel: fix.channel,
    precisionBits: fix.precisionBits,
  };
  const rows: DbTelemetry[] = [
    { ...base, telemetryType: 'latitude', value: fix.latitude, unit: '°' },
    { ...base, telemetryType: 'longitude', value: fix.longitude, unit: '°' },
  ];
  if (typeof fix.altitude === 'number') {
    rows.push({ ...base, telemetryType: 'altitude', value: fix.altitude, unit: 'm' });
  }
  try {
    for (const row of rows) {
      await databaseService.insertTelemetryAsync(row, fix.sourceId);
    }
    return true;
  } catch (err) {
    logger.error('MQTT position history insert failed:', err);
    return false;
  }
}
