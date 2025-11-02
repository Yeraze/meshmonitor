// Device role names for Meshtastic nodes
export const ROLE_NAMES: Record<number, string> = {
  0: 'Client',
  1: 'Client Mute',
  2: 'Router',
  3: 'Router Client',
  4: 'Repeater',
  5: 'Tracker',
  6: 'Sensor',
  7: 'TAK',
  8: 'Client Hidden',
  9: 'Lost and Found',
  10: 'TAK Tracker',
  11: 'Router Late',
  12: 'Client Base'
};

// Re-export HARDWARE_MODELS from the specialized utility file
export { HARDWARE_MODELS } from '../utils/hardwareModel';