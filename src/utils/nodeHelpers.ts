import { DeviceInfo } from '../types/device';
import { ROLE_NAMES, HARDWARE_MODELS } from '../constants';

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
    return nodeId.substring(1, 5);
  }

  // Fallback to full nodeId if it's too short or doesn't match expected format
  return nodeId;
};