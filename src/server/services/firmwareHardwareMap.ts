/**
 * Firmware Hardware Map Service
 *
 * Maps Meshtastic numeric hwModel enum values to firmware board names
 * used in release artifacts, determines platform architecture, and
 * checks OTA update capability.
 *
 * Board names match the naming convention used in Meshtastic firmware
 * release zips (e.g., firmware-heltec-v3-2.x.y.zip).
 */

import { HARDWARE_MODELS } from '../../utils/hardwareModel.js';

/**
 * Models that should not be mapped to a board name.
 * These are virtual/simulated or unset entries.
 */
const EXCLUDED_MODELS = new Set(['UNSET', 'ANDROID_SIM', 'PORTDUINO']);

/**
 * Manual overrides where the default enum-to-board conversion
 * (lowercase + replace _ with -) does not match firmware release naming.
 */
const BOARD_NAME_OVERRIDES: Record<string, string> = {
  LILYGO_TBEAM_S3_CORE: 'tbeam-s3-core',
  TBEAM: 'tbeam',
  TBEAM_V0P7: 'tbeam-v0p7',
  T_ECHO: 't-echo',
  T_ECHO_PLUS: 't-echo-plus',
  T_DECK: 't-deck',
  T_WATCH_S3: 't-watch-s3',
  HELTEC_HT62: 'heltec-ht62-esp32c3-sx1262',
  SENSECAP_INDICATOR: 'seeed-sensecap-indicator',
  M5STACK: 'm5stack-cores3',
  EBYTE_ESP32_S3: 'CDEBYTE_EoRa-S3',
  STATION_G1: 'station-g1',
  STATION_G2: 'station-g2',
};

/**
 * Platform architecture for each board name.
 * Used to determine which firmware zip to download and whether OTA is supported.
 */
const BOARD_PLATFORM_MAP: Record<string, string> = {
  // ESP32 (original)
  tbeam: 'esp32',
  'tbeam-v0p7': 'esp32',
  'tlora-v2': 'esp32',
  'tlora-v1': 'esp32',
  'tlora-v2-1-1p6': 'esp32',
  'tlora-v1-1p3': 'esp32',
  'tlora-v2-1-1p8': 'esp32',
  'heltec-v2-0': 'esp32',
  'heltec-v2-1': 'esp32',
  'heltec-v1': 'esp32',
  'heltec-wireless-bridge': 'esp32',
  'station-g1': 'esp32',
  'rak11200': 'esp32',
  'nano-g1': 'esp32',
  'nano-g1-explorer': 'esp32',
  'lora-relay-v1': 'esp32',
  'lora-type': 'esp32',
  wiphone: 'esp32',
  'diy-v1': 'esp32',
  'dr-dev': 'esp32',
  'betafpv-2400-tx': 'esp32',
  'betafpv-900-nano-tx': 'esp32',
  'tbeam-1-watt': 'esp32',

  // ESP32-S3
  'tbeam-s3-core': 'esp32s3',
  'heltec-v3': 'esp32s3',
  'heltec-v4': 'esp32s3',
  'heltec-wsl-v3': 'esp32s3',
  'heltec-wireless-tracker': 'esp32s3',
  'heltec-wireless-tracker-v1-0': 'esp32s3',
  'heltec-wireless-tracker-v2': 'esp32s3',
  'heltec-wireless-paper': 'esp32s3',
  'heltec-wireless-paper-v1-0': 'esp32s3',
  'heltec-capsule-sensor-v3': 'esp32s3',
  'heltec-vision-master-t190': 'esp32s3',
  'heltec-vision-master-e213': 'esp32s3',
  'heltec-vision-master-e290': 'esp32s3',
  'heltec-mesh-node-t114': 'esp32s3',
  'heltec-sensor-hub': 'esp32s3',
  'heltec-mesh-pocket': 'esp32s3',
  'heltec-mesh-solar': 'esp32s3',
  't-deck': 'esp32s3',
  't-deck-pro': 'esp32s3',
  't-watch-s3': 'esp32s3',
  't-watch-ultra': 'esp32s3',
  't-lora-pager': 'esp32s3',
  'station-g2': 'esp32s3',
  'seeed-sensecap-indicator': 'esp32s3',
  'm5stack-cores3': 'esp32s3',
  'm5stack-corebasic': 'esp32s3',
  'm5stack-core2': 'esp32s3',
  'm5stack-cardputer-adv': 'esp32s3',
  'CDEBYTE_EoRa-S3': 'esp32s3',
  'cdebyte-eora-s3': 'esp32s3',
  'tlora-t3-s3': 'esp32s3',
  'nano-g2-ultra': 'esp32s3',
  'picomputer-s3': 'esp32s3',
  'esp32-s3-pico': 'esp32s3',
  chatter2: 'esp32s3',
  'chatter-2': 'esp32s3',
  unphone: 'esp32s3',
  'td-lorac': 'esp32s3',
  'twc-mesh-v4': 'esp32s3',
  'seeed-xiao-s3': 'esp32s3',
  senselora_s3: 'esp32s3',
  'senselora-s3': 'esp32s3',
  routastic: 'esp32s3',
  'mesh-tab': 'esp32s3',
  meshlink: 'esp32s3',
  'thinknode-m1': 'esp32s3',
  'thinknode-m2': 'esp32s3',
  'thinknode-m3': 'esp32s3',
  'thinknode-m4': 'esp32s3',
  'thinknode-m5': 'esp32s3',
  'thinknode-m6': 'esp32s3',
  'muzi-base': 'esp32s3',
  'muzi-r1-neo': 'esp32s3',
  'nomadstar-meteor-pro': 'esp32s3',
  crowpanel: 'esp32s3',
  'link-32': 'esp32s3',
  't-eth-elite': 'esp32s3',
  't5-s3-epaper-pro': 'esp32s3',
  'radiomaster-900-bandit-nano': 'esp32s3',
  'radiomaster-900-bandit': 'esp32s3',

  // ESP32-C3
  'heltec-ht62-esp32c3-sx1262': 'esp32c3',
  'heltec-hru-3601': 'esp32c3',

  // ESP32-C6
  'tlora-c6': 'esp32c6',
  'm5stack-c6l': 'esp32c6',

  // NRF52840 (not OTA capable via WiFi)
  rak4631: 'nrf52840',
  't-echo': 'nrf52840',
  't-echo-plus': 'nrf52840',
  't-echo-lite': 'nrf52840',
  canaryone: 'nrf52840',
  'wio-wm1110': 'nrf52840',
  rak2560: 'nrf52840',
  'nrf52-unknown': 'nrf52840',
  'nrf52840-pca10059': 'nrf52840',
  'nrf52-promicro-diy': 'nrf52840',
  'tracker-t1000-e': 'nrf52840',
  'xiao-nrf52-kit': 'nrf52840',
  'wismesh-tap': 'nrf52840',
  'wismesh-tap-v2': 'nrf52840',
  'wismesh-tag': 'nrf52840',
  'seeed-solar-node': 'nrf52840',
  'seeed-wio-tracker-l1': 'nrf52840',
  'seeed-wio-tracker-l1-eink': 'nrf52840',
  rak3401: 'nrf52840',
  rak6421: 'nrf52840',
  meshstick1262: 'nrf52840',
  'meshstick-1262': 'nrf52840',

  // RP2040 (not OTA capable)
  'rpi-pico': 'rp2040',
  'rpi-pico2': 'rp2040',
  'senselora-rp2040': 'rp2040',
  'rp2040-lora': 'rp2040',
  'rp2040-feather-rfm95': 'rp2040',

  // STM32 (not OTA capable)
  rak3172: 'stm32',
  'wio-e5': 'stm32',
  rak11310: 'stm32',
  rak3312: 'stm32',
  ms24sf1: 'stm32',
  'me25ls01-4y10td': 'stm32',
};

/**
 * Platforms that support WiFi OTA firmware updates.
 */
const OTA_CAPABLE_PLATFORMS = new Set(['esp32', 'esp32s3', 'esp32c3', 'esp32c6']);

/**
 * Display name overrides for hardware models where the auto-generated
 * title case doesn't look right.
 */
const DISPLAY_NAME_OVERRIDES: Record<string, string> = {
  TBEAM: 'TBeam',
  TBEAM_V0P7: 'TBeam V0.7',
  LILYGO_TBEAM_S3_CORE: 'Lilygo TBeam S3 Core',
  RAK4631: 'RAK4631',
  RAK11200: 'RAK11200',
  RAK2560: 'RAK2560',
  RAK11310: 'RAK11310',
  RAK3172: 'RAK3172',
  RAK3312: 'RAK3312',
  RAK3401: 'RAK3401',
  RAK6421: 'RAK6421',
  T_ECHO: 'T Echo',
  T_ECHO_PLUS: 'T Echo Plus',
  T_ECHO_LITE: 'T Echo Lite',
  T_DECK: 'T Deck',
  T_DECK_PRO: 'T Deck Pro',
  T_WATCH_S3: 'T Watch S3',
  T_WATCH_ULTRA: 'T Watch Ultra',
  T_LORA_PAGER: 'T Lora Pager',
  T_ETH_ELITE: 'T Eth Elite',
};

/**
 * Convert an enum name to default board name: lowercase and replace _ with -.
 */
function defaultBoardName(enumName: string): string {
  return enumName.toLowerCase().replace(/_/g, '-');
}

/**
 * Convert an enum name to a human-readable display name.
 * Uses title case, replacing underscores with spaces.
 */
function formatDisplayName(enumName: string): string {
  return enumName
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Maps a numeric hwModel value to the firmware board name used in
 * Meshtastic release artifacts.
 *
 * @param hwModel - Numeric hardware model ID from the Meshtastic protobuf enum
 * @returns Board name string (e.g., 'heltec-v3') or null if the model
 *          is unknown, virtual, or excluded
 */
export function getBoardName(hwModel: number): string | null {
  const enumName = HARDWARE_MODELS[hwModel];
  if (!enumName || EXCLUDED_MODELS.has(enumName)) {
    return null;
  }

  if (BOARD_NAME_OVERRIDES[enumName]) {
    return BOARD_NAME_OVERRIDES[enumName];
  }

  return defaultBoardName(enumName);
}

/**
 * Maps a firmware board name to its platform architecture.
 *
 * @param boardName - Board name as returned by getBoardName
 * @returns Platform string (e.g., 'esp32s3', 'nrf52840') or null if unknown
 */
export function getPlatformForBoard(boardName: string): string | null {
  return BOARD_PLATFORM_MAP[boardName] ?? null;
}

/**
 * Checks whether a platform supports WiFi OTA firmware updates.
 * Only ESP32 variants (esp32, esp32s3, esp32c3, esp32c6) support OTA.
 *
 * @param platform - Platform string as returned by getPlatformForBoard
 * @returns true if the platform supports OTA updates
 */
export function isOtaCapable(platform: string): boolean {
  return OTA_CAPABLE_PLATFORMS.has(platform);
}

/**
 * Returns a human-readable display name for a hardware model.
 *
 * @param hwModel - Numeric hardware model ID
 * @returns Display name string (e.g., 'Heltec V3') or 'Unknown' if not found
 */
export function getHardwareDisplayName(hwModel: number): string {
  const enumName = HARDWARE_MODELS[hwModel];
  if (!enumName || enumName === 'UNSET') {
    return 'Unknown';
  }

  if (DISPLAY_NAME_OVERRIDES[enumName]) {
    return DISPLAY_NAME_OVERRIDES[enumName];
  }

  return formatDisplayName(enumName);
}
