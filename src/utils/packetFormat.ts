/**
 * Pure formatting/lookup helpers shared by the single-source Packet Monitor
 * (PacketMonitorPanel) and the cross-source Unified Packet Monitor.
 *
 * These intentionally have NO React/i18n/component-state dependencies — callers
 * pass in any locale-dependent values (timeFormat, dateFormat, translated
 * "Today" label) so the functions stay testable and reusable.
 */

import { PortNum } from '../server/constants/meshtastic.js';

// Transport mechanism display names (matches protobufs/meshtastic/mesh.proto
// TransportMechanism enum).
export const TRANSPORT_MECHANISM_NAMES: Record<number, { short: string; full: string }> = {
  0: { short: 'INT', full: 'Internal - Node generated packet' },
  1: { short: 'LoRa', full: 'LoRa - Primary radio' },
  2: { short: 'LoR1', full: 'LoRa Alt 1 - Secondary radio' },
  3: { short: 'LoR2', full: 'LoRa Alt 2 - Tertiary radio' },
  4: { short: 'LoR3', full: 'LoRa Alt 3 - Quaternary radio' },
  5: { short: 'MQTT', full: 'MQTT - Message queue' },
  6: { short: 'UDP', full: 'Multicast UDP' },
  7: { short: 'API', full: 'API - Direct connection' },
};

/** Get display name for a transport mechanism. */
export const getTransportMechanismName = (
  mechanism: number | undefined | null
): { short: string; full: string } => {
  if (mechanism === undefined || mechanism === null) {
    return { short: '?', full: 'Unknown transport' };
  }
  return TRANSPORT_MECHANISM_NAMES[mechanism] || { short: '?', full: `Unknown (${mechanism})` };
};

// Friendly PortNum names, mirroring the meshtastic.PortNum enum
// (src/server/constants/meshtastic.ts). Kept as a plain frontend map so the
// message detail view can name a portnum without importing server code — the
// backend Packet Monitor supplies `portnum_name` over the wire, but chat
// messages only carry the numeric `portnum`.
export const PORTNUM_NAMES: Record<number, string> = {
  0: 'UNKNOWN',
  1: 'TEXT_MESSAGE',
  2: 'REMOTE_HARDWARE',
  3: 'POSITION',
  4: 'NODEINFO',
  5: 'ROUTING',
  6: 'ADMIN',
  7: 'TEXT_MESSAGE_COMPRESSED',
  8: 'WAYPOINT',
  9: 'AUDIO',
  10: 'DETECTION_SENSOR',
  11: 'ALERT',
  12: 'KEY_VERIFICATION',
  13: 'REMOTE_SHELL',
  32: 'REPLY',
  33: 'IP_TUNNEL',
  34: 'PAXCOUNTER',
  35: 'STORE_FORWARD_PLUSPLUS',
  36: 'NODE_STATUS',
  37: 'MESH_BEACON',
  64: 'SERIAL',
  65: 'STORE_FORWARD',
  66: 'RANGE_TEST',
  67: 'TELEMETRY',
  68: 'ZPS',
  69: 'SIMULATOR',
  70: 'TRACEROUTE',
  71: 'NEIGHBORINFO',
  72: 'ATAK_PLUGIN',
  73: 'MAP_REPORT',
  74: 'POWERSTRESS',
  75: 'LORAWAN_BRIDGE',
  76: 'RETICULUM_TUNNEL',
  77: 'CAYENNE',
  78: 'ATAK_PLUGIN_V2',
  79: 'LORA_OTA',
  112: 'GROUPALARM',
  256: 'PRIVATE',
  257: 'ATAK_FORWARDER',
  511: 'MAX',
};

/** Human-readable name for a PortNum (e.g. 1 -> "TEXT_MESSAGE"). */
export const getPortnumName = (portnum: number | undefined | null): string => {
  if (portnum === undefined || portnum === null) return 'UNKNOWN';
  return PORTNUM_NAMES[portnum] ?? `PORT_${portnum}`;
};

/** Color for a PortNum, used to tint the Type column. */
export const getPortnumColor = (portnum: number): string => {
  switch (portnum) {
    case PortNum.TEXT_MESSAGE_APP:
      return '#4a9eff'; // TEXT_MESSAGE - blue
    case PortNum.POSITION_APP:
      return '#4caf50'; // POSITION - green
    case PortNum.NODEINFO_APP:
      return '#00bcd4'; // NODEINFO - cyan
    case PortNum.TELEMETRY_APP:
      return '#ff9800'; // TELEMETRY - orange
    case PortNum.TRACEROUTE_APP:
      return '#9c27b0'; // TRACEROUTE - purple
    case PortNum.NEIGHBORINFO_APP:
      return '#673ab7'; // NEIGHBORINFO - deep purple
    case PortNum.ROUTING_APP:
      return '#f44336'; // ROUTING - red
    case PortNum.ADMIN_APP:
      return '#e91e63'; // ADMIN - pink
    case PortNum.WAYPOINT_APP:
      return '#4caf50'; // WAYPOINT - green
    case PortNum.ALERT_APP:
      return '#ff5722'; // ALERT - deep orange
    case PortNum.REPLY_APP:
      return '#2196f3'; // REPLY - light blue
    case PortNum.MESH_BEACON_APP:
      return '#3f51b5'; // MESH_BEACON_APP - indigo
    case PortNum.SERIAL_APP: // SERIAL - brown
    case PortNum.STORE_FORWARD_APP: // STORE_FORWARD - brown
    case PortNum.RANGE_TEST_APP:
      return '#795548'; // RANGE_TEST - brown
    case PortNum.ATAK_PLUGIN: // ATAK_PLUGIN - teal
    case PortNum.MAP_REPORT_APP:
      return '#009688'; // MAP_REPORT - teal
    case PortNum.ATAK_PLUGIN_V2:
      return '#26a69a'; // ATAK_PLUGIN_V2 - lighter teal
    case PortNum.PRIVATE_APP: // PRIVATE_APP - gray
    case PortNum.ATAK_FORWARDER:
      return '#757575'; // ATAK_FORWARDER - gray
    default:
      return '#9e9e9e'; // UNKNOWN - gray
  }
};

/** Convert a timestamp to milliseconds (handles legacy seconds and modern ms data). */
export const toMs = (ts: number): number => (ts < 10_000_000_000 ? ts * 1000 : ts);

/**
 * Format the compact Date column — "Today" or a short month/day, honoring the
 * user's dateFormat preference.
 */
export const formatPacketDateColumn = (
  timestamp: number,
  dateFormat: string,
  todayLabel: string
): string => {
  const date = new Date(toMs(timestamp));
  const now = new Date();
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  if (isToday) {
    return todayLabel;
  }

  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  if (dateFormat === 'DD/MM/YYYY') {
    return `${day}/${month}`;
  } else if (dateFormat === 'YYYY-MM-DD') {
    return `${month}-${day}`;
  }
  return `${month}/${day}`;
};

/** Format the Time column with milliseconds, honoring the user's timeFormat preference. */
export const formatPacketTimestamp = (timestamp: number, timeFormat: string): string => {
  const date = new Date(toMs(timestamp));
  const time = date.toLocaleTimeString('en-US', {
    hour12: timeFormat === '12',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  // Insert ms before AM/PM if 12h format (e.g. "12:09:55 PM" → "12:09:55.979 PM")
  return timeFormat === '12'
    ? time.replace(/(\d{2}:\d{2}:\d{2})\s*(AM|PM)/i, `$1.${ms} $2`)
    : `${time}.${ms}`;
};
