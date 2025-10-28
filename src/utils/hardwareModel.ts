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
  33: 'NRF52840DK',
  34: 'PPR',
  35: 'GENIEBLOCKS',
  36: 'NRF52_UNKNOWN',
  37: 'PORTDUINO',
  38: 'ANDROID_SIM',
  39: 'DIY_V1',
  40: 'NRF52840_PCA10059',
  41: 'DR_DEV',
  42: 'M5STACK',
  43: 'HELTEC_V2',
  44: 'HELTEC_V1_433',
  45: 'HELTEC_V2_1_868',
  46: 'HELTEC_V2_1_433',
  47: 'HELTEC_WSL_V3',
  48: 'RPI_PICO',
  49: 'HELTEC_WIRELESS_TRACKER',
  50: 'HELTEC_WIRELESS_PAPER',
  51: 'T_DECK',
  52: 'T_WATCH_S3',
  53: 'PICOMPUTER_S3',
  54: 'HELTEC_HT62',
  55: 'EBYTE_ESP32_S3',
  56: 'ESP32_S3_PICO',
  57: 'CHATTER_2',
  58: 'HELTEC_WIRELESS_PAPER_V1_0',
  59: 'HELTEC_WIRELESS_TRACKER_V1_0',
  60: 'UNPHONE',
  61: 'TD_LORAC',
  62: 'CDEBYTE_EORA_S3',
  63: 'TWC_MESH_V4',
  64: 'NRF52_PROMICRO_DIY',
  65: 'RADIOMASTER_900_BANDIT_NANO',
  66: 'HELTEC_CAPSULE_SENSOR_V3',
  67: 'HELTEC_VISION_MASTER_T190',
  68: 'HELTEC_VISION_MASTER_E213',
  69: 'HELTEC_VISION_MASTER_E290',
  70: 'HELTEC_MESH_NODE_T114',
  71: 'SENSECAP_INDICATOR',
  72: 'TRACKER_T1000_E',
  73: 'RAK3172',
  74: 'WIO_E5',
  75: 'RADIOMASTER_900_BANDIT',
  76: 'ME25LS01_4Y10TD',
  77: 'RP2040_FEATHER_RFM95',
  78: 'M5STACK_COREBASIC',
  79: 'M5STACK_CORE2',
  80: 'RPI_PICO2',
  81: 'M5STACK_CORES3',
  82: 'SEEED_XIAO_S3',
  83: 'SEEED_WM1110',
  84: 'COSMO_H743',
  85: 'RADIOMASTER_POCKET',
  86: 'BETAFPV_ELRS_MICRO_TX',
  87: 'RPI_PICO_WAVESHARE',
  88: 'HELTEC_WIRELESS_TRACKER_V1_1',
  89: 'HELTEC_WIRELESS_PAPER_V1_1',
  90: 'SEEED_SENSECAP_CARD_TRACKER',
  91: 'TBEAM_LILYGO_SX1262',
  92: 'CDEBYTE_E108_GN02D',
  93: 'CDEBYTE_EB52_R40',
  94: 'ADAFRUIT_FEATHER_RP2040_RFM95',
  95: 'WIPHONE_V2',
  96: 'CHATTER',
  97: 'T_WATCH',
  98: 'M5STACK_CARDPUTER',
  99: 'MRFSSDK',
  100: 'HELTEC_V3',
  101: 'AIR_T5',
  102: 'BETAFPV_2400_TX',
  103: 'RD76XX_RAK5010',
  104: 'SEEED_CARD_TRACKER_T1000_E',
  105: 'RAK11310_PCA10059',
  106: 'M5STACK_STAMP_S3',
  107: 'M5STACK_CORE_INK',
  108: 'XL_SOLUTIONS_XLED',
  109: 'ESP32_C3_DEVKIT_LORA',
  110: 'DFROBOT_LORA_FIREBEETLE',
  111: 'BETAFPV_ELRS_NANO_TX',
  112: 'CDEBYTE_NRF52_PROTO',
  113: 'HELTEC_WSL_V3_EU868',
  114: 'HELTEC_WSL_V3_US915',
  115: 'DIY_TWATCH_S3',
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
