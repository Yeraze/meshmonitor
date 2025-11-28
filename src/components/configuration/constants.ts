/**
 * Constant data for ConfigurationTab components
 */
import type { RoleOption, ModemPresetOption, RegionOption } from './types';

export const ROLE_OPTIONS: RoleOption[] = [
  {
    value: 0,
    name: 'CLIENT',
    shortDesc: 'App connected or stand alone messaging device. Rebroadcasts packets when no other node has done so.',
    description: 'General use for individuals needing to communicate over the Meshtastic network with support for client applications.'
  },
  {
    value: 1,
    name: 'CLIENT_MUTE',
    shortDesc: 'Device that does not forward packets from other devices.',
    description: 'Situations where a device needs to participate in the network without assisting in packet routing, reducing network load.'
  },
  {
    value: 2,
    name: 'ROUTER',
    shortDesc: 'Infrastructure node for extending network coverage by always rebroadcasting packets once. Visible in Nodes list.',
    description: 'Best positioned in strategic locations to maximize the network\'s overall coverage. Device is shown in topology.'
  },
  {
    value: 5,
    name: 'TRACKER',
    shortDesc: 'Broadcasts GPS position packets as priority.',
    description: 'Tracking the location of individuals or assets, especially in scenarios where timely and efficient location updates are critical.'
  },
  {
    value: 6,
    name: 'SENSOR',
    shortDesc: 'Broadcasts telemetry packets as priority.',
    description: 'Deploying in scenarios where gathering environmental or other sensor data is crucial, with efficient power usage and frequent updates.'
  },
  {
    value: 7,
    name: 'TAK',
    shortDesc: 'Optimized for ATAK system communication, reduces routine broadcasts.',
    description: 'Integration with ATAK systems (via the Meshtastic ATAK Plugin) for communication in tactical or coordinated operations.'
  },
  {
    value: 8,
    name: 'CLIENT_HIDDEN',
    shortDesc: 'Device that only broadcasts as needed for stealth or power savings.',
    description: 'Use in stealth/hidden deployments or to reduce airtime/power consumption while still participating in the network.'
  },
  {
    value: 9,
    name: 'LOST_AND_FOUND',
    shortDesc: 'Broadcasts location as message to default channel regularly to assist with device recovery.',
    description: 'Used for recovery efforts of a lost device.'
  },
  {
    value: 10,
    name: 'TAK_TRACKER',
    shortDesc: 'Enables automatic TAK PLI broadcasts and reduces routine broadcasts.',
    description: 'Standalone PLI integration with ATAK systems for communication in tactical or coordinated operations.'
  },
  {
    value: 11,
    name: 'ROUTER_LATE',
    shortDesc: 'Infrastructure node that always rebroadcasts packets once but only after all other modes, ensuring additional coverage for local clusters. Visible in Nodes list.',
    description: 'Ideal for covering dead spots or ensuring reliability for a cluster of nodes where placement doesn\'t benefit the broader mesh. Device is shown in topology.'
  },
  {
    value: 12,
    name: 'CLIENT_BASE',
    shortDesc: 'Personal base station: always rebroadcasts packets from or to its favorited nodes. Handles all other packets like CLIENT.',
    description: 'Use for stronger attic/roof "base station" nodes to distribute messages more widely from your own weaker, indoor, or less-well-positioned nodes.'
  }
];

export const MODEM_PRESET_OPTIONS: ModemPresetOption[] = [
  { value: 0, name: 'LONG_FAST', description: 'Long Range - Fast (Default)', params: 'BW: 250kHz, SF: 11, CR: 4/5' },
  { value: 1, name: 'LONG_SLOW', description: 'Long Range - Slow', params: 'BW: 125kHz, SF: 12, CR: 4/8' },
  { value: 3, name: 'MEDIUM_SLOW', description: 'Medium Range - Slow', params: 'BW: 250kHz, SF: 10, CR: 4/5' },
  { value: 4, name: 'MEDIUM_FAST', description: 'Medium Range - Fast', params: 'BW: 250kHz, SF: 9, CR: 4/5' },
  { value: 5, name: 'SHORT_SLOW', description: 'Short Range - Slow', params: 'BW: 250kHz, SF: 8, CR: 4/5' },
  { value: 6, name: 'SHORT_FAST', description: 'Short Range - Fast', params: 'BW: 250kHz, SF: 7, CR: 4/5' },
  { value: 7, name: 'LONG_MODERATE', description: 'Long Range - Moderately Fast', params: 'BW: 125kHz, SF: 11, CR: 4/8' },
  { value: 8, name: 'SHORT_TURBO', description: 'Short Range - Turbo (Fastest, widest bandwidth)', params: 'BW: 500kHz, SF: 7, CR: 4/5' }
];

export const REGION_OPTIONS: RegionOption[] = [
  { value: 0, label: 'UNSET - Region not set' },
  { value: 1, label: 'US - United States' },
  { value: 2, label: 'EU_433 - European Union 433MHz' },
  { value: 3, label: 'EU_868 - European Union 868MHz' },
  { value: 4, label: 'CN - China' },
  { value: 5, label: 'JP - Japan' },
  { value: 6, label: 'ANZ - Australia / New Zealand' },
  { value: 7, label: 'KR - Korea' },
  { value: 8, label: 'TW - Taiwan' },
  { value: 9, label: 'RU - Russia' },
  { value: 10, label: 'IN - India' },
  { value: 11, label: 'NZ_865 - New Zealand 865MHz' },
  { value: 12, label: 'TH - Thailand' },
  { value: 13, label: 'LORA_24 - WLAN Band' },
  { value: 14, label: 'UA_433 - Ukraine 433MHz' },
  { value: 15, label: 'UA_868 - Ukraine 868MHz' }
];

// Mapping from string role names to numeric values
export const ROLE_MAP: Record<string, number> = {
  'CLIENT': 0,
  'CLIENT_MUTE': 1,
  'ROUTER': 2,
  'TRACKER': 5,
  'SENSOR': 6,
  'TAK': 7,
  'CLIENT_HIDDEN': 8,
  'LOST_AND_FOUND': 9,
  'TAK_TRACKER': 10,
  'ROUTER_LATE': 11,
  'CLIENT_BASE': 12
};

// Mapping from string modem preset names to numeric values
export const PRESET_MAP: Record<string, number> = {
  'LONG_FAST': 0,
  'LONG_SLOW': 1,
  'MEDIUM_SLOW': 3,
  'MEDIUM_FAST': 4,
  'SHORT_SLOW': 5,
  'SHORT_FAST': 6,
  'LONG_MODERATE': 7,
  'SHORT_TURBO': 8
};

// Mapping from string region names to numeric values
export const REGION_MAP: Record<string, number> = {
  'UNSET': 0, 'US': 1, 'EU_433': 2, 'EU_868': 3, 'CN': 4, 'JP': 5,
  'ANZ': 6, 'KR': 7, 'TW': 8, 'RU': 9, 'IN': 10, 'NZ_865': 11,
  'TH': 12, 'LORA_24': 13, 'UA_433': 14, 'UA_868': 15
};
