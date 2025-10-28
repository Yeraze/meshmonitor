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

  // If already a string, return it
  if (typeof role === 'string') {
    return role;
  }

  return DEVICE_ROLES[role] || `Unknown (${role})`;
}

/**
 * Get device role description
 * @param role - Numeric role ID or string role name
 * @returns Description of the role's function
 */
export function getDeviceRoleDescription(role: number | string | undefined): string {
  const numericRole = typeof role === 'string' ? undefined : role;

  if (numericRole === undefined || numericRole === null) {
    return 'No role specified';
  }

  const descriptions: Record<number, string> = {
    0: 'Standard mesh node',
    1: 'Client node that does not forward packets',
    2: 'Infrastructure node that routes packets',
    3: 'Router that also acts as a client (deprecated)',
    4: 'Node that repeats packets (deprecated)',
    5: 'GPS tracking device',
    6: 'Environmental sensor node',
    7: 'TAK integration node',
    8: 'Client not visible in node list',
    9: 'Lost and Found mode',
    10: 'TAK GPS tracking device',
    11: 'Router with delayed forwarding',
    12: 'Base station client',
  };

  return descriptions[numericRole] || 'Unknown role';
}

/**
 * Check if a role is a routing role
 * @param role - Numeric role ID or string role name
 * @returns True if the role involves routing packets
 */
export function isRoutingRole(role: number | string | undefined): boolean {
  const numericRole = typeof role === 'string' ? undefined : role;

  if (numericRole === undefined || numericRole === null) {
    return false;
  }

  // Roles that route/forward packets
  return [2, 3, 4, 11].includes(numericRole);
}
