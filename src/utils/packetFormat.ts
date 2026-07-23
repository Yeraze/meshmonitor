/**
 * Pure formatting/lookup helpers shared by the single-source Packet Monitor
 * (PacketMonitorPanel) and the cross-source Unified Packet Monitor.
 *
 * These intentionally have NO React/i18n/component-state dependencies — callers
 * pass in any locale-dependent values (timeFormat, dateFormat, translated
 * "Today" label) so the functions stay testable and reusable.
 */

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

/** Color for a PortNum, used to tint the Type column. */
export const getPortnumColor = (portnum: number): string => {
  switch (portnum) {
    case 1:
      return '#4a9eff'; // TEXT_MESSAGE - blue
    case 3:
      return '#4caf50'; // POSITION - green
    case 4:
      return '#00bcd4'; // NODEINFO - cyan
    case 67:
      return '#ff9800'; // TELEMETRY - orange
    case 70:
      return '#9c27b0'; // TRACEROUTE - purple
    case 71:
      return '#673ab7'; // NEIGHBORINFO - deep purple
    case 5:
      return '#f44336'; // ROUTING - red
    case 6:
      return '#e91e63'; // ADMIN - pink
    case 8:
      return '#4caf50'; // WAYPOINT - green
    case 11:
      return '#ff5722'; // ALERT - deep orange
    case 32:
      return '#2196f3'; // REPLY - light blue
    case 37:
      return '#3f51b5'; // MESH_BEACON_APP - indigo
    case 64: // SERIAL - brown
    case 65: // STORE_FORWARD - brown
    case 66:
      return '#795548'; // RANGE_TEST - brown
    case 72: // ATAK_PLUGIN - teal
    case 73:
      return '#009688'; // MAP_REPORT - teal
    case 78:
      return '#26a69a'; // ATAK_PLUGIN_V2 - lighter teal
    case 256: // PRIVATE_APP - gray
    case 257:
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
