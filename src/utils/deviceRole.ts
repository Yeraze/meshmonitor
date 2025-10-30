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

/**
 * Get device role description
 * @param role - Numeric role ID or string role name
 * @returns Description of the role's function
 */
export function getDeviceRoleDescription(role: number | string | undefined): string {
  if (role === undefined || role === null) {
    return 'No role specified';
  }

  // Convert to number if it's a numeric string
  let numericRole: number;
  if (typeof role === 'string') {
    const parsed = parseInt(role, 10);
    if (isNaN(parsed)) {
      return 'No role specified';
    }
    numericRole = parsed;
  } else {
    numericRole = role;
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
  if (role === undefined || role === null) {
    return false;
  }

  // Convert to number if it's a numeric string
  let numericRole: number;
  if (typeof role === 'string') {
    const parsed = parseInt(role, 10);
    if (isNaN(parsed)) {
      return false;
    }
    numericRole = parsed;
  } else {
    numericRole = role;
  }

  // Roles that route/forward packets
  return [2, 3, 4, 11].includes(numericRole);
}
