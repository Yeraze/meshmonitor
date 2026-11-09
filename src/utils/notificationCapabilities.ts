/**
 * Which notification controls a source supports (P11 S8).
 *
 * One pure table replaces the scattered `isMeshCore` checks in the
 * Notifications tab. Meshtastic keeps every control it had. A MeshCore
 * Companion gets DMs (which include room posts), channels, emoji, mentions,
 * trace/path alerts and new-node alerts. A MeshCore Repeater only sees channel
 * traffic, so DM, trace, new-node and mention controls are hidden.
 */
import api from '../services/api.js';
import type { Channel } from '../types/device.js';

/** MeshCore device type codes (match `status.deviceType`). */
export const MESHCORE_DEVICE_TYPE_COMPANION = 1;
export const MESHCORE_DEVICE_TYPE_REPEATER = 2;

export interface NotificationCapabilities {
  dm: boolean;
  /** Room posts arrive on the DM row (Companion only). */
  rooms: boolean;
  channels: boolean;
  emoji: boolean;
  mqtt: boolean;
  traceroute: boolean;
  newNode: 'on' | 'unsupported';
  waypoint: boolean;
  mention: boolean;
  batteryUnit: 'percent' | 'voltage';
  /** Keyword filters, message templates and the filter-order info box. */
  messageFilters: boolean;
}

export function notificationCapabilities(
  sourceType: string | null | undefined,
  meshcoreDeviceType?: number | null,
): NotificationCapabilities {
  if (sourceType !== 'meshcore') {
    return {
      dm: true,
      rooms: false,
      channels: true,
      emoji: true,
      mqtt: true,
      traceroute: true,
      newNode: 'on',
      waypoint: true,
      mention: false,
      batteryUnit: 'percent',
      messageFilters: true,
    };
  }
  const repeater = meshcoreDeviceType === MESHCORE_DEVICE_TYPE_REPEATER;
  return {
    dm: !repeater,
    rooms: !repeater,
    channels: true,
    emoji: true,
    mqtt: false,
    traceroute: !repeater,
    newNode: repeater ? 'unsupported' : 'on',
    waypoint: false,
    mention: !repeater,
    batteryUnit: 'voltage',
    messageFilters: true,
  };
}

/**
 * Load the channel list used by notification pickers. Meshtastic keeps the
 * plain `/api/channels` list. MeshCore uses `/api/channels/all`, so slots above
 * 7 and keyed/virtual rows appear. Throws on a failed request.
 */
export async function loadNotificationChannels(
  sourceId: string | null | undefined,
  sourceType: string | null | undefined,
): Promise<Channel[]> {
  const qs = sourceId ? `?sourceId=${encodeURIComponent(sourceId)}` : '';
  const path = sourceType === 'meshcore' ? '/api/channels/all' : '/api/channels';
  const response = await api.get<Channel[]>(`${path}${qs}`);
  return Array.isArray(response) ? response : [];
}
