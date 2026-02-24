/**
 * Device role decoder utility
 * Maps numeric role IDs to readable names
 * Based on Meshtastic protobuf definitions:
 * https://github.com/meshtastic/protobufs/blob/master/meshtastic/config.proto
 */

export const DEVICE_ROLES: Record<number, string> = {
  0: 'Client',
  1: 'Client (Mute)',
  2: 'Router',
  3: 'Router Client', // deprecated
  4: 'Repeater', // deprecated
  5: 'Tracker',
  6: 'Sensor',
  7: 'TAK',
  8: 'Client (Hidden)',
  9: 'Lost and Found',
  10: 'TAK Tracker',
  11: 'Router (Late)',
  12: 'Client (Base)',
};

/**
 * Get human-readable device role name
 * @param role - Numeric role ID or string role name
 * @returns Readable device role name or 'N/A' if not found
 */
export function getDeviceRoleName(role: number | string | undefined): string {
  if (role === undefined || role === null) {
    return 'N/A';
  }

  // Convert to number if it's a numeric string
  let numericRole: number;
  if (typeof role === 'string') {
    const parsed = parseInt(role, 10);
    // If it's a valid number string, use it; otherwise assume it's already a readable name
    if (!isNaN(parsed)) {
      numericRole = parsed;
    } else {
      return role;
    }
  } else {
    numericRole = role;
  }

  return DEVICE_ROLES[numericRole] || `Unknown (${numericRole})`;
}

