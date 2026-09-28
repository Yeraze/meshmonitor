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
 *
 * The board name is the PlatformIO env name (`[env:<board>]` in
 * `variants/<platform>/<dir>/platformio.ini`), which is also the `board` in
 * the release manifest (`firmware-<ver>.json`) and the `<board>` in
 * `firmware-<board>-<ver>.bin`. Release names mix `-` and `_` freely, so
 * never derive them by rule — copy them from the manifest (#5423 audit;
 * fixtures in firmwareHardwareMap.releaseNames.test.ts).
 *
 * hw models shared by more than one release build are NOT mapped here: they
 * live in AMBIGUOUS_OTA_MODELS below and OTA preflight refuses them. The one
 * exception is HELTEC_V4 (heltec-v4 / heltec-v4-tft), which predates the
 * audit and is kept on heltec-v4 on purpose (#5402).
 */
const BOARD_NAME_OVERRIDES: Record<string, string> = {
  LILYGO_TBEAM_S3_CORE: 'tbeam-s3-core',
  TBEAM: 'tbeam',
  // Variant-only (board_level = extra, not in release zips): env names.
  TBEAM_V0P7: 'tbeam0_7',
  HELTEC_V2_0: 'heltec-v2_0',
  HELTEC_V2_1: 'heltec-v2_1',
  TLORA_V2_1_1P8: 'tlora-v2-1-1_8',
  DR_DEV: 'meshtastic-dr-dev',
  EBYTE_ESP32_S3: 'EBYTE_ESP32-S3',
  HELTEC_WIRELESS_PAPER_V1_0: 'heltec-wireless-paper-v1_0',
  HELTEC_WIRELESS_TRACKER_V1_0: 'heltec-wireless-tracker-V1-0',
  BETAFPV_2400_TX: 'betafpv_2400_tx_micro',
  BETAFPV_900_NANO_TX: 'betafpv_900_tx_nano',
  ESP32_S3_PICO: 'ESP32-S3-Pico',
  LINK_32: 'link32-s3-v1',
  T_ECHO: 't-echo',
  T_ECHO_PLUS: 't-echo-plus',
  T_DECK: 't-deck',
  T_WATCH_S3: 't-watch-s3',
  HELTEC_HT62: 'heltec-ht62-esp32c3-sx1262',
  SENSECAP_INDICATOR: 'seeed-sensecap-indicator',
  STATION_G1: 'station-g1',
  STATION_G2: 'station-g2',
  // #5423: variants/esp32s3/station-g3 (hw model 134); ships as
  // firmware-station-g3-<ver>.bin in the esp32s3 release zip.
  STATION_G3: 'station-g3',

  // ---- Release builds (verified against the 2.7.26 and 2.8.0 manifests) ----
  CHATTER_2: 'chatter2',
  CDEBYTE_EORA_S3: 'CDEBYTE_EoRa-S3',
  RADIOMASTER_900_BANDIT: 'radiomaster_900_bandit',
  HELTEC_CAPSULE_SENSOR_V3: 'heltec_capsule_sensor_v3',
  THINKNODE_M2: 'thinknode_m2',
  HELTEC_SENSOR_HUB: 'heltec_sensor_hub',
  T_LORA_PAGER: 'tlora-pager',
  THINKNODE_M5: 'thinknode_m5',
  M5STACK_C6L: 'm5stack-unitc6l',
  WISMESH_TAP_V2: 'rak_wismesh_tap_v2',
  TBEAM_1_WATT: 't-beam-1w',
  TBEAM_BPF: 't-beam-bpf',
  THINKNODE_M7: 'thinknode_m7',
  THINKNODE_M9: 'thinknode_m9',
  // The plain seeed_wio_tracker_L2 env is board_level = extra; the -tft
  // build is the only one the release ships for hw model 137.
  SEEED_WIO_TRACKER_L2: 'seeed_wio_tracker_L2-tft',
  MESHNOLOGY_W10: 'meshnology_w10',

  // ---- nRF52840 boards (not OTA capable) — env names from variants/ ----
  THINKNODE_M1: 'thinknode_m1',
  THINKNODE_M3: 'thinknode_m3',
  THINKNODE_M4: 'thinknode_m4',
  THINKNODE_M6: 'thinknode_m6',
  NOMADSTAR_METEOR_PRO: 'rak4631_nomadstar_meteor_pro',
  MUZI_R1_NEO: 'r1-neo',
  TWC_MESH_V4: 'TWC_mesh_v4',
  // RP2040 (not OTA capable)
  SENSELORA_RP2040: 'senselora_rp2040',
};

/**
 * Platform architecture for each board name.
 * Used to determine which firmware zip to download and whether OTA is supported.
 */
const BOARD_PLATFORM_MAP: Record<string, string> = {
  // ESP32 (original)
  tbeam: 'esp32',
  tbeam0_7: 'esp32',
  'tlora-v2': 'esp32',
  'tlora-v1': 'esp32',
  'tlora-v2-1-1_6': 'esp32',
  'tlora-v1-1p3': 'esp32',
  'tlora-v2-1-1_8': 'esp32',
  'heltec-v2_0': 'esp32',
  'heltec-v2_1': 'esp32',
  'heltec-v1': 'esp32',
  'heltec-wireless-bridge': 'esp32',
  'station-g1': 'esp32',
  rak11200: 'esp32',
  'nano-g1': 'esp32',
  'nano-g1-explorer': 'esp32',
  'lora-relay-v1': 'esp32',
  'lora-type': 'esp32',
  wiphone: 'esp32',
  'meshtastic-diy-v1': 'esp32',
  'meshtastic-dr-dev': 'esp32',
  betafpv_2400_tx_micro: 'esp32',
  betafpv_900_tx_nano: 'esp32',
  'm5stack-core': 'esp32',
  chatter2: 'esp32',
  radiomaster_900_bandit_nano: 'esp32',
  radiomaster_900_bandit: 'esp32',

  // ESP32-S3
  'tbeam-s3-core': 'esp32s3',
  'heltec-v3': 'esp32s3',
  'heltec-v4': 'esp32s3',
  'heltec-v4-r8-oled': 'esp32s3',
  'heltec-wsl-v3': 'esp32s3',
  'heltec-wireless-tracker': 'esp32s3',
  'heltec-wireless-tracker-V1-0': 'esp32s3',
  'heltec-wireless-tracker-v2': 'esp32s3',
  'heltec-wireless-paper': 'esp32s3',
  'heltec-wireless-paper-v1_0': 'esp32s3',
  heltec_capsule_sensor_v3: 'esp32s3',
  'heltec-vision-master-t190': 'esp32s3',
  'heltec-vision-master-e213': 'esp32s3',
  'heltec-vision-master-e290': 'esp32s3',
  heltec_sensor_hub: 'esp32s3',
  'heltec-rc32': 'esp32s3',
  't-deck': 'esp32s3',
  't-deck-pro': 'esp32s3',
  't-watch-s3': 'esp32s3',
  't-watch-ultra': 'esp32s3',
  'tlora-pager': 'esp32s3',
  't-beam-1w': 'esp32s3',
  't-beam-bpf': 'esp32s3',
  'station-g2': 'esp32s3',
  'station-g3': 'esp32s3',
  'seeed-sensecap-indicator': 'esp32s3',
  'seeed_wio_tracker_L2-tft': 'esp32s3',
  'm5stack-cores3': 'esp32s3',
  'm5stack-corebasic': 'esp32s3',
  'm5stack-core2': 'esp32s3',
  'm5stack-cardputer-adv': 'esp32s3',
  'CDEBYTE_EoRa-S3': 'esp32s3',
  'EBYTE_ESP32-S3': 'esp32s3',
  'tlora-t3s3-v1': 'esp32s3',
  'picomputer-s3': 'esp32s3',
  'ESP32-S3-Pico': 'esp32s3',
  unphone: 'esp32s3',
  'td-lorac': 'esp32s3',
  'seeed-xiao-s3': 'esp32s3',
  'senselora-s3': 'esp32s3',
  routastic: 'esp32s3',
  'mesh-tab': 'esp32s3',
  rak3312: 'esp32s3',
  rak_wismesh_tap_v2: 'esp32s3',
  thinknode_m2: 'esp32s3',
  thinknode_m5: 'esp32s3',
  thinknode_m7: 'esp32s3',
  thinknode_m9: 'esp32s3',
  meshnology_w10: 'esp32s3',
  'mini-epaper-s3': 'esp32s3',
  crowpanel: 'esp32s3',
  'link32-s3-v1': 'esp32s3',
  't-eth-elite': 'esp32s3',
  't5-s3-epaper-pro': 'esp32s3',

  // ESP32-C3
  'heltec-ht62-esp32c3-sx1262': 'esp32c3',
  'heltec-hru-3601': 'esp32c3',

  // ESP32-C6
  'tlora-c6': 'esp32c6',
  'm5stack-unitc6l': 'esp32c6',
  'heltec-rcc6': 'esp32c6',

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
  'wismesh-tag': 'nrf52840',
  'seeed-solar-node': 'nrf52840',
  'seeed-wio-tracker-l1': 'nrf52840',
  'seeed-wio-tracker-l1-eink': 'nrf52840',
  rak3401: 'nrf52840',
  rak6421: 'nrf52840',
  'meshstick-1262': 'nrf52840',
  'nano-g2-ultra': 'nrf52840',
  'heltec-mesh-node-t114': 'nrf52840',
  'heltec-mesh-pocket': 'nrf52840',
  'heltec-mesh-solar': 'nrf52840',
  'muzi-base': 'nrf52840',
  'r1-neo': 'nrf52840',
  rak4631_nomadstar_meteor_pro: 'nrf52840',
  thinknode_m1: 'nrf52840',
  thinknode_m3: 'nrf52840',
  thinknode_m4: 'nrf52840',
  thinknode_m6: 'nrf52840',
  meshlink: 'nrf52840',
  TWC_mesh_v4: 'nrf52840',

  // RP2040 (not OTA capable)
  'rpi-pico': 'rp2040',
  'rpi-pico2': 'rp2040',
  senselora_rp2040: 'rp2040',
  'rp2040-lora': 'rp2040',
  'rp2040-feather-rfm95': 'rp2040',
  rak11310: 'rp2040',

  // STM32 (not OTA capable)
  rak3172: 'stm32',
  'wio-e5': 'stm32',
  ms24sf1: 'stm32',
  'me25ls01-4y10td': 'stm32',
};

/**
 * hw models that more than one release build reports (#5423). The node only
 * tells us its hw model, so MeshMonitor cannot know which build it runs, and
 * flashing the wrong one can leave the node without a working display or
 * radio. OTA preflight refuses these for release and nightly updates; a
 * custom URL or uploaded .bin (where the operator picks the build) still
 * works. Candidate builds are the release manifest board names; evidence is
 * `custom_meshtastic_hw_model` / architecture.h HW_VENDOR at v2.8.0.
 *
 * HELTEC_V4 (heltec-v4 / heltec-v4-tft, both tagged hw model 110) has the
 * same ambiguity but is intentionally NOT listed: it has always mapped to
 * heltec-v4 and existing users rely on that (#5402).
 */
export const AMBIGUOUS_OTA_MODELS: Readonly<
  Record<string, { platform: string; builds: readonly string[] }>
> = {
  TLORA_V2_1_1P6: { platform: 'esp32', builds: ['tlora-v2-1-1_6', 'tlora-v3-3-0-tcxo'] },
  TLORA_T3_S3: { platform: 'esp32s3', builds: ['tlora-t3s3-v1', 'tlora-t3s3-epaper'] },
  DIY_V1: { platform: 'esp32', builds: ['meshtastic-diy-v1', 'hydra'] },
  M5STACK: { platform: 'esp32', builds: ['m5stack-core', 'm5stack-coreink'] },
  RADIOMASTER_900_BANDIT_NANO: {
    platform: 'esp32',
    builds: ['radiomaster_900_bandit_nano', 'radiomaster_900_bandit_micro'],
  },
  HELTEC_V4_R8: { platform: 'esp32s3', builds: ['heltec-v4-r8-oled', 'heltec-v4-r8-tft'] },
};

/**
 * Returns the candidate builds and platform when a hw model is shared by
 * several release builds, or null when the model maps to one board.
 */
export function getAmbiguousOtaModel(
  hwModel: number
): { enumName: string; platform: string; builds: readonly string[] } | null {
  const enumName = HARDWARE_MODELS[hwModel];
  const entry = enumName ? AMBIGUOUS_OTA_MODELS[enumName] : undefined;
  return entry ? { enumName, ...entry } : null;
}

export interface OtaSiblingBuild {
  /** Release manifest board name of the sibling build. */
  build: string;
  /** How the operator would describe a node running that build. */
  label: string;
}

/**
 * hw models that map to one base build but share their hw model with other
 * release builds (#5423). Unlike AMBIGUOUS_OTA_MODELS these still update:
 * the base build is the usual one and existing users rely on it (HELTEC_V4,
 * #5402). OTA preflight attaches a warning naming each sibling so the
 * operator can cancel and pick the build by custom URL or upload.
 *
 * Evidence (v2.8.0): the sibling env either sets the same
 * `custom_meshtastic_hw_model`, `extends` the base env, or defines the same
 * architecture.h HW_VENDOR macro.
 */
export const OTA_SIBLING_BUILDS: Readonly<
  Record<string, { baseLabel?: string; siblings: readonly OtaSiblingBuild[] }>
> = {
  HELTEC_V4: { baseLabel: 'OLED', siblings: [{ build: 'heltec-v4-tft', label: 'Heltec V4 TFT' }] },
  HELTEC_WIRELESS_TRACKER: {
    siblings: [
      { build: 'tracksenger', label: 'Tracksenger' },
      { build: 'tracksenger-lcd', label: 'Tracksenger LCD' },
      { build: 'tracksenger-oled', label: 'Tracksenger OLED' },
    ],
  },
  T_DECK_PRO: { siblings: [{ build: 't-deck-pro-v1_1', label: 'T-Deck Pro v1.1' }] },
  T_DECK: { siblings: [{ build: 't-deck-tft', label: 'T-Deck running the TFT (MUI) build' }] },
  PICOMPUTER_S3: {
    siblings: [{ build: 'picomputer-s3-tft', label: 'PiComputer S3 running the TFT (MUI) build' }],
  },
  SENSECAP_INDICATOR: {
    siblings: [
      { build: 'seeed-sensecap-indicator-tft', label: 'SenseCAP Indicator running the TFT (MUI) build' },
    ],
  },
  WISMESH_TAP_V2: {
    siblings: [{ build: 'rak_wismesh_tap_v2-tft', label: 'WisMesh Tap V2 running the TFT (MUI) build' }],
  },
  THINKNODE_M9: {
    siblings: [{ build: 'thinknode_m9-tft', label: 'ThinkNode M9 running the TFT (MUI) build' }],
  },
  HELTEC_WIRELESS_PAPER: {
    siblings: [
      { build: 'heltec-wireless-paper-inkhud', label: 'Heltec Wireless Paper running the InkHUD build' },
    ],
  },
  HELTEC_VISION_MASTER_E213: {
    siblings: [
      { build: 'heltec-vision-master-e213-inkhud', label: 'Vision Master E213 running the InkHUD build' },
    ],
  },
  HELTEC_VISION_MASTER_E290: {
    siblings: [
      { build: 'heltec-vision-master-e290-inkhud', label: 'Vision Master E290 running the InkHUD build' },
    ],
  },
  MINI_EPAPER_S3: {
    siblings: [{ build: 'mini-epaper-s3-inkhud', label: 'Mini E-Paper S3 running the InkHUD build' }],
  },
};

export interface OtaSiblingWarning {
  code: 'OTA_SIBLING_BUILD';
  /** Board MeshMonitor will flash, e.g. `heltec-v4`. */
  board: string;
  /** Board plus its variant note, e.g. `heltec-v4 (OLED)`. */
  boardLabel: string;
  sibling: string;
  siblingLabel: string;
  /** English text; the frontend renders its own translated copy. */
  message: string;
}

/**
 * Warnings for a hw model whose base build has sibling release builds, or an
 * empty array when the model maps to exactly one build.
 */
export function getOtaSiblingWarnings(hwModel: number): OtaSiblingWarning[] {
  const enumName = HARDWARE_MODELS[hwModel];
  const entry = enumName ? OTA_SIBLING_BUILDS[enumName] : undefined;
  const board = getBoardName(hwModel);
  if (!entry || !board) return [];
  const boardLabel = entry.baseLabel ? `${board} (${entry.baseLabel})` : board;
  return entry.siblings.map(({ build, label }) => ({
    code: 'OTA_SIBLING_BUILD' as const,
    board,
    boardLabel,
    sibling: build,
    siblingLabel: label,
    message:
      `This will flash ${boardLabel}. If your node is a ${label}, cancel and use a custom ` +
      `firmware URL or upload the ${build} .bin instead.`,
  }));
}

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
