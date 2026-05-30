/**
 * Shared packet-visibility permission helpers.
 *
 * Used by both the single-source packet routes (`packetRoutes.ts`) and the
 * cross-source Unified Packet Monitor (`unifiedRoutes.ts`) so the content-filtering
 * rule (channel-read + DM privacy) cannot drift between the two endpoints.
 */
import type { PermissionSet } from '../../types/permission.js';
import { PortNum } from '../constants/meshtastic.js';

export const BROADCAST_NODE = 4294967295; // 0xFFFFFFFF

/**
 * Get the set of channel indices (0-7) that the user has read permission for.
 */
export function getAllowedChannels(permissions: PermissionSet): Set<number> {
  const allowed = new Set<number>();
  for (let i = 0; i < 8; i++) {
    const key = `channel_${i}` as keyof PermissionSet;
    if (permissions[key]?.read === true) {
      allowed.add(i);
    }
  }
  return allowed;
}

/**
 * Filter packets based on channel and message permissions.
 * - Encrypted packets always pass through (content is not readable anyway)
 * - TEXT_MESSAGE_APP DMs (to_node != broadcast) require messages:read permission
 * - Decrypted packets require read permission on the packet's channel
 */
export function filterPacketsByPermissions<
  T extends { encrypted: boolean; channel?: number | null; portnum?: number | null; to_node?: number | null }
>(
  packets: T[],
  allowedChannels: Set<number>,
  isAdmin: boolean,
  canReadMessages: boolean
): T[] {
  if (isAdmin) return packets;
  return packets.filter(packet => {
    // Encrypted packets always visible
    if (packet.encrypted) return true;
    // TEXT_MESSAGE_APP DMs require messages:read permission
    if (packet.portnum === PortNum.TEXT_MESSAGE_APP &&
        packet.to_node !== undefined && packet.to_node !== null &&
        packet.to_node !== BROADCAST_NODE) {
      return canReadMessages;
    }
    // Decrypted packets require channel read permission
    if (packet.channel !== undefined && packet.channel !== null) {
      return allowedChannels.has(packet.channel);
    }
    // Packets with no channel info - allow (e.g. internal packets)
    return true;
  });
}
