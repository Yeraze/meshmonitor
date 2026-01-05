/**
 * Device role enum from meshtastic.Config.DeviceConfig.Role
 * See: https://github.com/meshtastic/protobufs/
 */
export const DeviceRole = {
  CLIENT: 0,
  CLIENT_MUTE: 1,
  ROUTER: 2,
  ROUTER_CLIENT: 3,
  REPEATER: 4,
  TRACKER: 5,
  SENSOR: 6,
  TAK: 7,
  CLIENT_HIDDEN: 8,
  LOST_AND_FOUND: 9,
  TAK_TRACKER: 10,
  ROUTER_LATE: 11,
  CLIENT_BASE: 12,
} as const;

export type DeviceRoleType = typeof DeviceRole[keyof typeof DeviceRole];

// Device role names for Meshtastic nodes
export const ROLE_NAMES: Record<number, string> = {
  [DeviceRole.CLIENT]: 'Client',
  [DeviceRole.CLIENT_MUTE]: 'Client Mute',
  [DeviceRole.ROUTER]: 'Router',
  [DeviceRole.ROUTER_CLIENT]: 'Router Client',
  [DeviceRole.REPEATER]: 'Repeater',
  [DeviceRole.TRACKER]: 'Tracker',
  [DeviceRole.SENSOR]: 'Sensor',
  [DeviceRole.TAK]: 'TAK',
  [DeviceRole.CLIENT_HIDDEN]: 'Client Hidden',
  [DeviceRole.LOST_AND_FOUND]: 'Lost and Found',
  [DeviceRole.TAK_TRACKER]: 'TAK Tracker',
  [DeviceRole.ROUTER_LATE]: 'Router Late',
  [DeviceRole.CLIENT_BASE]: 'Client Base',
};

/**
 * Check if a device role is a relay-capable role (Router or Client_Base)
 */
export function isRelayRole(role: number | undefined): boolean {
  return role === DeviceRole.ROUTER || role === DeviceRole.CLIENT_BASE;
}

// Re-export HARDWARE_MODELS from the specialized utility file
export { HARDWARE_MODELS } from '../utils/hardwareModel.js';