/**
 * Per-source configuration for MQTT-native send (#4305).
 *
 * Stored as per-source settings (`source:{id}:<key>`), written ONLY by
 * `PUT /api/sources/:id/mqtt/native` so the clamps below cannot be bypassed
 * through the generic settings POST (see PER_SOURCE_KEYS_NOT_POSTABLE).
 *
 * Limits are policy decided on the issue, not tunables:
 *   - user sends: at most 6 per minute and 60 per hour per source. An admin
 *     may set lower values; anything higher is clamped back to the cap.
 *   - hop limit: default 3, clamped 0-7.
 *   - NodeInfo announce: every 3 hours, counted apart from the send cap.
 */
import databaseService from '../../../services/database.js';
import { DEFAULT_HOP_LIMIT, MAX_HOP_LIMIT } from '../../constants/meshtastic.js';
import { normalizeRootTopic } from './mqttNativePacket.js';

export const MQTT_NATIVE_SETTING_KEYS = {
  enabled: 'mqttNativeSendEnabled',
  hopLimit: 'mqttNativeHopLimit',
  maxPerMinute: 'mqttNativeMaxPerMinute',
  maxPerHour: 'mqttNativeMaxPerHour',
  longName: 'mqttNativeLongName',
  shortName: 'mqttNativeShortName',
  rootTopic: 'mqttNativeRootTopic',
  announceChannelId: 'mqttNativeAnnounceChannelId',
} as const;

/** Hard server caps on user sends per source. Never raised by configuration. */
export const MQTT_NATIVE_HARD_MAX_PER_MINUTE = 6;
export const MQTT_NATIVE_HARD_MAX_PER_HOUR = 60;
/** NodeInfo announce cadence. */
export const MQTT_NATIVE_NODEINFO_INTERVAL_MS = 3 * 60 * 60 * 1000;
/** Firmware User.long_name / short_name byte limits (nanopb max_size - 1). */
export const MQTT_NATIVE_LONG_NAME_MAX_BYTES = 24;
export const MQTT_NATIVE_SHORT_NAME_MAX_BYTES = 4;

export interface MqttNativeConfig {
  enabled: boolean;
  hopLimit: number;
  maxPerMinute: number;
  maxPerHour: number;
  /** Empty means "use the default name". */
  longName: string;
  shortName: string;
  /** Admin-set MQTT root, or null to derive it from the source. */
  rootTopic: string | null;
  /** channel_database id NodeInfo announces go out on, or null for the default. */
  announceChannelId: number | null;
}

function clampInt(raw: string | undefined, min: number, max: number, fallback: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Clamp a hop limit to 0-7, defaulting to 3. */
export function clampHopLimit(raw: unknown): number {
  return clampInt(raw === undefined || raw === null ? undefined : String(raw), 0, MAX_HOP_LIMIT, DEFAULT_HOP_LIMIT);
}

/** Clamp a per-minute cap to 1..6 (lower only). */
export function clampMaxPerMinute(raw: unknown): number {
  return clampInt(
    raw === undefined || raw === null ? undefined : String(raw),
    1,
    MQTT_NATIVE_HARD_MAX_PER_MINUTE,
    MQTT_NATIVE_HARD_MAX_PER_MINUTE,
  );
}

/** Clamp a per-hour cap to 1..60 (lower only). */
export function clampMaxPerHour(raw: unknown): number {
  return clampInt(
    raw === undefined || raw === null ? undefined : String(raw),
    1,
    MQTT_NATIVE_HARD_MAX_PER_HOUR,
    MQTT_NATIVE_HARD_MAX_PER_HOUR,
  );
}

/** Truncate a name to a byte budget without splitting a UTF-8 character. */
export function truncateUtf8(value: string, maxBytes: number): string {
  let out = '';
  for (const ch of value) {
    if (Buffer.byteLength(out + ch, 'utf8') > maxBytes) break;
    out += ch;
  }
  return out;
}

export function parseMqttNativeConfig(settings: Record<string, string | undefined>): MqttNativeConfig {
  const k = MQTT_NATIVE_SETTING_KEYS;
  const announceRaw = settings[k.announceChannelId];
  const announce = announceRaw !== undefined && announceRaw !== '' ? Number(announceRaw) : NaN;
  return {
    enabled: settings[k.enabled] === 'true',
    hopLimit: clampHopLimit(settings[k.hopLimit]),
    maxPerMinute: clampMaxPerMinute(settings[k.maxPerMinute]),
    maxPerHour: clampMaxPerHour(settings[k.maxPerHour]),
    longName: truncateUtf8((settings[k.longName] ?? '').trim(), MQTT_NATIVE_LONG_NAME_MAX_BYTES),
    shortName: truncateUtf8((settings[k.shortName] ?? '').trim(), MQTT_NATIVE_SHORT_NAME_MAX_BYTES),
    rootTopic: normalizeRootTopic(settings[k.rootTopic]),
    announceChannelId: Number.isInteger(announce) && announce > 0 ? announce : null,
  };
}

export async function readMqttNativeConfig(sourceId: string): Promise<MqttNativeConfig> {
  const settings = await databaseService.settings.getSourceSettings(sourceId);
  return parseMqttNativeConfig(settings);
}

/** Default names: "MeshMonitor abcd" / "abcd" from the node id's last 4 hex digits. */
export function defaultMqttNativeNames(nodeNum: number): { longName: string; shortName: string } {
  const tail = (nodeNum >>> 0).toString(16).padStart(8, '0').slice(-4);
  return { longName: `MeshMonitor ${tail}`, shortName: tail };
}
