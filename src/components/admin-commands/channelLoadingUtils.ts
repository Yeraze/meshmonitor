import type { Channel } from '../../types/device';

/**
 * Helper function to normalize channel role from various formats
 */
export function normalizeChannelRole(role: any, index: number, hasData: boolean): number {
  // Convert role to number if it's a string enum
  if (typeof role === 'string') {
    const roleMap: { [key: string]: number } = {
      'DISABLED': 0,
      'PRIMARY': 1,
      'SECONDARY': 2
    };
    const mappedRole = roleMap[role];
    if (mappedRole !== undefined) return mappedRole;
  } else if (role !== undefined && role !== null) {
    // If role is already a number, use it
    if (role === 0 && hasData) {
      // If role is DISABLED (0) but channel has data, infer the correct role
      return index === 0 ? 1 : 2; // PRIMARY for channel 0, SECONDARY for others
    }
    return role;
  }
  
  // Default: PRIMARY for channel 0, DISABLED for others
  return index === 0 ? 1 : 0;
}

/**
 * Helper function to create an empty channel slot
 */
export function createEmptyChannelSlot(index: number, now: number): Channel {
  return {
    id: index,
    name: '',
    psk: '',
    role: index === 0 ? 1 : 0, // Default to PRIMARY for channel 0, DISABLED for others
    uplinkEnabled: false,
    downlinkEnabled: false,
    positionPrecision: 32,
    createdAt: now,
    updatedAt: now
  };
}

/**
 * Helper function to create a channel from API response
 */
export function createChannelFromResponse(
  ch: any,
  index: number,
  now: number
): Channel {
  const hasData = (ch.name && ch.name.trim().length > 0) || (ch.psk && ch.psk.length > 0);
  const role = normalizeChannelRole(ch.role, index, hasData);

  return {
    id: index,
    name: ch.name || '',
    psk: ch.psk || '',
    role: role,
    uplinkEnabled: ch.uplinkEnabled !== undefined ? ch.uplinkEnabled : false,
    downlinkEnabled: ch.downlinkEnabled !== undefined ? ch.downlinkEnabled : false,
    positionPrecision: ch.positionPrecision !== undefined ? ch.positionPrecision : 32,
    createdAt: now,
    updatedAt: now
  };
}

/**
 * Helper function to check if an error is retryable
 */
export function isRetryableChannelError(error: any): boolean {
  const message = error?.message || '';
  return message.includes('404') || 
         message.includes('not received') ||
         message.includes('timeout');
}

/**
 * Helper function to count loaded channels with actual data
 */
export function countLoadedChannels(channels: Channel[]): number {
  return channels.filter(ch => {
    const hasName = ch.name && ch.name.trim().length > 0;
    const hasPsk = ch.psk && ch.psk.trim().length > 0;
    const isPrimary = ch.role === 1;
    return hasName || hasPsk || isPrimary;
  }).length;
}

