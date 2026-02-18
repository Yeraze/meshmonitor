import { DeviceInfo } from '../types/device';
import { ROLE_NAMES, HARDWARE_MODELS } from '../constants/index.js';

/**
 * Infrastructure node roles (Router, Router Client, Repeater, Router Late)
 * These roles are typically used for mesh infrastructure and not end-user devices.
 */
const INFRASTRUCTURE_ROLES = new Set([2, 3, 4, 11]);

/**
 * Traceroute display time window in hours (7 days).
 * Used consistently across components that display traceroute data.
 */
export const TRACEROUTE_DISPLAY_HOURS = 7 * 24;

/**
 * Parse a node ID string (e.g., "!a1b2c3d4") to its numeric representation.
 * @param nodeId - The node ID string with optional "!" prefix
 * @returns The numeric node number, or null if parsing fails
 */
export const parseNodeId = (nodeId: string): number | null => {
  if (!nodeId) return null;
  const numStr = nodeId.replace('!', '');
  const num = parseInt(numStr, 16);
  return isNaN(num) ? null : num;
};

/**
 * Check if a node has an infrastructure role (Router, Repeater, etc.)
 * @param node - The device node to check
 * @returns true if the node has an infrastructure role
 */
export const isInfrastructureNode = (node: DeviceInfo): boolean => {
  const role = node.user?.role;
  if (role === undefined || role === null) return false;
  const roleNum = typeof role === 'string' ? parseInt(role, 10) : role;
  if (isNaN(roleNum)) return false;
  return INFRASTRUCTURE_ROLES.has(roleNum);
};

/**
 * Check if a node has a valid position (non-null latitude and longitude)
 * @param node - The device node to check
 * @returns true if the node has valid position coordinates
 */
export const hasValidPosition = (node: DeviceInfo): boolean => {
  return (
    node.position != null &&
    node.position.latitude != null &&
    node.position.longitude != null
  );
};

/**
 * Position data returned by getEffectivePosition
 */
export interface EffectivePosition {
  latitude: number | undefined;
  longitude: number | undefined;
  altitude: number | undefined;
}

/**
 * Get the effective position for a node, respecting position overrides.
 * If position override is enabled and has valid coordinates, use override values.
 * Otherwise, fall back to regular GPS position.
 *
 * This mirrors the backend getEffectivePosition logic in server.ts.
 *
 * @param node - The device node to get position from
 * @returns The effective position (override if enabled, otherwise GPS position)
 */
export const getEffectivePosition = (node: DeviceInfo | null | undefined): EffectivePosition => {
  if (!node) {
    return { latitude: undefined, longitude: undefined, altitude: undefined };
  }

  // Check for position override first
  if (
    node.positionOverrideEnabled === true &&
    node.latitudeOverride != null &&
    node.longitudeOverride != null
  ) {
    return {
      latitude: node.latitudeOverride,
      longitude: node.longitudeOverride,
      altitude: node.altitudeOverride,
    };
  }

  // Fall back to regular position
  return {
    latitude: node.position?.latitude,
    longitude: node.position?.longitude,
    altitude: node.position?.altitude,
  };
};

/**
 * Check if a node has a valid effective position (accounting for overrides).
 * @param node - The device node to check
 * @returns true if the node has valid effective position coordinates
 */
export const hasValidEffectivePosition = (node: DeviceInfo): boolean => {
  const pos = getEffectivePosition(node);
  return pos.latitude != null && pos.longitude != null;
};

export const getRoleName = (role: number | string | undefined): string | null => {
  if (role === undefined || role === null) return null;
  const roleNum = typeof role === 'string' ? parseInt(role) : role;
  if (isNaN(roleNum)) return null;
  return ROLE_NAMES[roleNum] || `Unknown (${roleNum})`;
};

const formatHardwareName = (name: string): string => {
  // Keep certain abbreviations and codes uppercase
  const keepUppercase = [
    'LR', 'TX', 'HT', 'WM', 'RAK', 'RAK4631', 'RAK11200', 'RAK2560', 'RAK3172',
    'NRF', 'TWC', 'DIY', 'DR', 'PCA',
    'V1', 'V2', 'V3', 'V4', 'S3', 'G1', 'G2', 'RPI', 'TAK',
    'E290', 'E213', 'E5', 'T190', 'T114', 'T1000', 'WSL', 'HRU', 'HT62',
    'WM1110', 'MS24SF1', 'RFM95', 'C6', 'C6L', 'LS01', 'Y10TD', 'DK', 'PPR',
    'HRI', 'M1', 'M2', 'M5', 'L1'
  ];

  // Special brand capitalizations
  const brandMap: Record<string, string> = {
    'TLORA': 'TLora',
    'TBEAM': 'TBeam',
    'HELTEC': 'Heltec',
    'LILYGO': 'Lilygo',
    'BETAFPV': 'BetaFPV',
    'RADIOMASTER': 'RadioMaster',
    'CDEBYTE': 'CDebyte',
    'PORTDUINO': 'Portduino',
    'ANDROID': 'Android',
    'PICOMPUTER': 'PiComputer',
    'UNPHONE': 'Unphone',
    'SENSECAP': 'SenseCap',
    'SEEED': 'Seeed',
    'XIAO': 'Xiao',
    'WIPHONE': 'WiPhone',
    'TRACKER': 'Tracker',
    'NANO': 'Nano',
    'EXPLORER': 'Explorer',
    'ULTRA': 'Ultra',
    'TYPE': 'Type',
    'STATION': 'Station',
    'BANDIT': 'Bandit',
    'CAPSULE': 'Capsule',
    'SENSOR': 'Sensor',
    'WIRELESS': 'Wireless',
    'PAPER': 'Paper',
    'DECK': 'Deck',
    'WATCH': 'Watch',
    'MESH': 'Mesh',
    'NODE': 'Node',
    'INDICATOR': 'Indicator',
    'MASTER': 'Master',
    'VISION': 'Vision',
    'UNKNOWN': 'Unknown',
    'SIM': 'Sim',
    'DEV': 'Dev',
    'M5STACK': 'M5Stack',
    'PICO': 'Pico',
    'PICO2': 'Pico2',
    'CONNECT': 'Connect',
    'CHATTER': 'Chatter',
    'EORA': 'Eora',
    'LORAC': 'LoRaC',
    'SENSELORA': 'SenseLoRA',
    'CANARYONE': 'CanaryOne',
    'GENIEBLOCKS': 'GenieBlocks',
    'EBYTE': 'EByte',
    'ROUTASTIC': 'Routastic',
    'MESHLINK': 'MeshLink',
    'NOMADSTAR': 'NomadStar',
    'CROWPANEL': 'CrowPanel',
    'MUZI': 'Muzi',
    'WISMESH': 'WisMesh',
    'BRIDGE': 'Bridge',
    'RELAY': 'Relay',
    'PROMICRO': 'ProMicro',
    'FEATHER': 'Feather',
    'COREBASIC': 'CoreBasic',
    'CORE2': 'Core2',
    'CORES3': 'CoreS3',
    'TAP': 'Tap',
    'TAB': 'Tab',
    'LINK': 'Link',
    'PAGER': 'Pager',
    'RESERVED': 'Reserved',
    'FRIED': 'Fried',
    'CHICKEN': 'Chicken',
    'METEOR': 'Meteor',
    'PRO': 'Pro',
    'SOLAR': 'Solar',
    'ELITE': 'Elite',
    'HUB': 'Hub',
    'POCKET': 'Pocket',
    'CARDPUTER': 'Cardputer',
    'ADV': 'Adv',
    'LITE': 'Lite',
    'UNSET': 'Unset',
    'PRIVATE': 'Private',
    'HW': 'HW',
    'EINK': 'Eink',
    'NEO': 'Neo',
    'THINKNODE': 'ThinkNode',
    'ETH': 'Eth',
    'WIO': 'Wio',
    'TD': 'TD',
    'RP2040': 'RP2040',
    'ESP32': 'ESP32',
    'NRF52840': 'nRF52840',
    'NRF52': 'nRF52',
    'ME25LS01': 'ME25LS01',
    '4Y10TD': '4Y10TD',
    'LORA': 'LoRa'
  };

  return name
    .split('_')
    .map(word => {
      // Check if word should stay uppercase
      if (keepUppercase.includes(word)) {
        return word;
      }
      // Check for special brand names
      if (brandMap[word]) {
        return brandMap[word];
      }
      // Check if word contains version numbers (like V2P0, V1P3)
      if (/^V\d+P\d+$/.test(word)) {
        return word.replace('P', '.');
      }
      // Check if it's a number with letter prefix (like 2400, 900)
      if (/^\d+$/.test(word)) {
        return word;
      }
      // Default title case
      return word.charAt(0) + word.slice(1).toLowerCase();
    })
    .join(' ');
};

export const getHardwareModelName = (hwModel: number | undefined): string | null => {
  if (hwModel === undefined || hwModel === null) return null;
  const modelName = HARDWARE_MODELS[hwModel];
  if (!modelName) return `Unknown (${hwModel})`;
  return formatHardwareName(modelName);
};

export const getNodeName = (nodes: DeviceInfo[], nodeId: string): string => {
  if (!nodeId) return 'Unknown';
  const node = nodes.find(n => n.user?.id === nodeId);
  return node?.user?.longName || nodeId;
};

export const getNodeShortName = (nodes: DeviceInfo[], nodeId: string): string => {
  if (!nodeId) return '';
  const node = nodes.find(n => n.user?.id === nodeId);

  // Check if node has a shortName
  if (node?.user?.shortName && node.user.shortName.trim()) {
    return node.user.shortName.trim();
  }

  // Safely extract substring from nodeId
  // Node IDs are typically formatted as !XXXXXXXX (8 hex chars)
  if (nodeId.length >= 5 && nodeId.startsWith('!')) {
    return nodeId.slice(-4);
  }

  // Fallback to full nodeId if it's too short or doesn't match expected format
  return nodeId;
};

/**
 * Database node object shape for isNodeComplete checks.
 * This matches the DbNode interface from database.ts for type safety.
 */
interface DbNodeLike {
  nodeId?: string;
  longName?: string;
  shortName?: string;
  hwModel?: number | null;
}

/**
 * Determines if a node has complete information (verified on mesh).
 * A node is considered complete when we've received a NODEINFO packet from it,
 * which provides the longName, shortName, and hwModel fields.
 *
 * Incomplete nodes are typically created when we see a packet from a node
 * but haven't received its NODEINFO yet. On secure/private channels,
 * incomplete nodes should be filtered out as they haven't been verified
 * as being on the same encrypted channel.
 *
 * @param node - The node to check, can be DeviceInfo or a database node object
 * @returns true if the node has complete information, false otherwise
 */
export const isNodeComplete = (node: DeviceInfo | DbNodeLike): boolean => {
  if (!node) return false;

  // Determine if this is a DeviceInfo (has 'user' property) or DbNodeLike
  const isDeviceInfo = 'user' in node;

  // Get node ID for checking default names
  const nodeId = isDeviceInfo ? node.user?.id : (node as DbNodeLike).nodeId;

  // Get fields - handle both DeviceInfo (user.field) and database node (field) formats
  const longName = isDeviceInfo ? node.user?.longName : (node as DbNodeLike).longName;
  const shortName = isDeviceInfo ? node.user?.shortName : (node as DbNodeLike).shortName;
  const hwModel = isDeviceInfo ? node.user?.hwModel : (node as DbNodeLike).hwModel;

  // Check if longName exists and is not the default "Node !xxxxxxxx" format
  if (!longName || longName.startsWith('Node !')) {
    return false;
  }

  // Check if shortName exists and is not just the first 4 chars of nodeId
  if (!shortName) {
    return false;
  }

  // If we have a nodeId, verify shortName isn't just derived from it
  if (nodeId && nodeId.startsWith('!')) {
    const defaultShortName = nodeId.slice(-4);
    if (shortName === defaultShortName) {
      return false;
    }
  }

  // Check if hwModel exists (proves we received NODEINFO_APP packet)
  if (hwModel === undefined || hwModel === null) {
    return false;
  }

  return true;
};