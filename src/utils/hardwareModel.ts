/**
 * Hardware model decoder utility
 * Maps numeric hardware model IDs to readable names
 * Based on Meshtastic protobuf definitions:
 * https://github.com/meshtastic/protobufs/blob/master/meshtastic/mesh.proto
 */

export const HARDWARE_MODELS: Record<number, string> = {
  0: 'UNSET',
  1: 'TLORA_V2',
  2: 'TLORA_V1',
  3: 'TLORA_V2_1_1P6',
  4: 'TBEAM',
  5: 'HELTEC_V2_0',
  6: 'TBEAM_V0P7',
  7: 'T_ECHO',
  8: 'TLORA_V1_1P3',
  9: 'RAK4631',
  10: 'HELTEC_V2_1',
  11: 'HELTEC_V1',
  12: 'LILYGO_TBEAM_S3_CORE',
  13: 'RAK11200',
  14: 'NANO_G1',
  15: 'TLORA_V2_1_1P8',
  16: 'TLORA_T3_S3',
  17: 'NANO_G1_EXPLORER',
  18: 'NANO_G2_ULTRA',
  19: 'LORA_TYPE',
  20: 'WIPHONE',
  21: 'WIO_WM1110',
  22: 'RAK2560',
  23: 'HELTEC_HRU_3601',
  24: 'HELTEC_WIRELESS_BRIDGE',
  25: 'STATION_G1',
  26: 'RAK11310',
  27: 'SENSELORA_RP2040',
  28: 'SENSELORA_S3',
  29: 'CANARYONE',
  30: 'RP2040_LORA',
  31: 'STATION_G2',
  32: 'LORA_RELAY_V1',
  33: 'T_ECHO_PLUS',
  34: 'PPR',
  35: 'GENIEBLOCKS',
  36: 'NRF52_UNKNOWN',
  37: 'PORTDUINO',
  38: 'ANDROID_SIM',
  39: 'DIY_V1',
  40: 'NRF52840_PCA10059',
  41: 'DR_DEV',
  42: 'M5STACK',
  43: 'HELTEC_V3',
  44: 'HELTEC_WSL_V3',
  45: 'BETAFPV_2400_TX',
  46: 'BETAFPV_900_NANO_TX',
  47: 'RPI_PICO',
  48: 'HELTEC_WIRELESS_TRACKER',
  49: 'HELTEC_WIRELESS_PAPER',
  50: 'T_DECK',
  51: 'T_WATCH_S3',
  52: 'PICOMPUTER_S3',
  53: 'HELTEC_HT62',
  54: 'EBYTE_ESP32_S3',
  55: 'ESP32_S3_PICO',
  56: 'CHATTER_2',
  57: 'HELTEC_WIRELESS_PAPER_V1_0',
  58: 'HELTEC_WIRELESS_TRACKER_V1_0',
  59: 'UNPHONE',
  60: 'TD_LORAC',
  61: 'CDEBYTE_EORA_S3',
  62: 'TWC_MESH_V4',
  63: 'NRF52_PROMICRO_DIY',
  64: 'RADIOMASTER_900_BANDIT_NANO',
  65: 'HELTEC_CAPSULE_SENSOR_V3',
  66: 'HELTEC_VISION_MASTER_T190',
  67: 'HELTEC_VISION_MASTER_E213',
  68: 'HELTEC_VISION_MASTER_E290',
  69: 'HELTEC_MESH_NODE_T114',
  70: 'SENSECAP_INDICATOR',
  71: 'TRACKER_T1000_E',
  72: 'RAK3172',
  73: 'WIO_E5',
  74: 'RADIOMASTER_900_BANDIT',
  75: 'ME25LS01_4Y10TD',
  76: 'RP2040_FEATHER_RFM95',
  77: 'M5STACK_COREBASIC',
  78: 'M5STACK_CORE2',
  79: 'RPI_PICO2',
  80: 'M5STACK_CORES3',
  81: 'SEEED_XIAO_S3',
  82: 'MS24SF1',
  83: 'TLORA_C6',
  84: 'WISMESH_TAP',
  85: 'ROUTASTIC',
  86: 'MESH_TAB',
  87: 'MESHLINK',
  88: 'XIAO_NRF52_KIT',
  89: 'THINKNODE_M1',
  90: 'THINKNODE_M2',
  91: 'T_ETH_ELITE',
  92: 'HELTEC_SENSOR_HUB',
  93: 'MUZI_BASE',
  94: 'HELTEC_MESH_POCKET',
  95: 'SEEED_SOLAR_NODE',
  96: 'NOMADSTAR_METEOR_PRO',
  97: 'CROWPANEL',
  98: 'LINK_32',
  99: 'SEEED_WIO_TRACKER_L1',
  100: 'SEEED_WIO_TRACKER_L1_EINK',
  101: 'MUZI_R1_NEO',
  102: 'T_DECK_PRO',
  103: 'T_LORA_PAGER',
  104: 'M5STACK_RESERVED',
  105: 'WISMESH_TAG',
  106: 'RAK3312',
  107: 'THINKNODE_M5',
  108: 'HELTEC_MESH_SOLAR',
  109: 'T_ECHO_LITE',
  110: 'HELTEC_V4',
  111: 'M5STACK_C6L',
  112: 'M5STACK_CARDPUTER_ADV',
  113: 'HELTEC_WIRELESS_TRACKER_V2',
  114: 'T_WATCH_ULTRA',
  115: 'THINKNODE_M3',
  116: 'WISMESH_TAP_V2',
  117: 'RAK3401',
  118: 'RAK6421',
  119: 'THINKNODE_M4',
  120: 'THINKNODE_M6',
  121: 'MESHSTICK_1262',
  122: 'TBEAM_1_WATT',
  123: 'T5_S3_EPAPER_PRO',
  255: 'PRIVATE_HW',
};

/**
 * Get human-readable hardware model name
 * @param hwModel - Numeric hardware model ID
 * @returns Readable hardware model name or 'Unknown' if not found
 */
export function getHardwareModelName(hwModel: number | undefined): string {
  if (hwModel === undefined || hwModel === null) {
    return 'N/A';
  }
  return HARDWARE_MODELS[hwModel] || `Unknown (${hwModel})`;
}

/**
 * Get short hardware model name (simplified version)
 * Removes version numbers and underscores for display
 * @param hwModel - Numeric hardware model ID
 * @returns Simplified hardware model name
 */
export function getHardwareModelShortName(hwModel: number | undefined): string {
  const fullName = getHardwareModelName(hwModel);
  if (fullName === 'N/A' || fullName.startsWith('Unknown')) {
    return fullName;
  }

  // Remove version suffixes and simplify common names
  return fullName
    .replace(/_V\d+(_\d+)?(_\d+)?/g, '') // Remove version numbers
    .replace(/_/g, ' ') // Replace underscores with spaces
    .replace(/\s+/g, ' ') // Normalize spaces
    .trim();
}
