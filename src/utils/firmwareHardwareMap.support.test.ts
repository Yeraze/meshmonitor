/**
 * #5677: one list decides which hardware MeshMonitor can update. The Firmware
 * Updates pane reads `firmwareUpdateSupport`; OTA preflight walks the same
 * steps. This file pins the verdict for EVERY hardware model, so a model
 * added to `HARDWARE_MODELS` without a decision fails here.
 */
import { describe, it, expect } from 'vitest';
import { HARDWARE_MODELS } from './hardwareModel';
import {
  EXCLUDED_MODELS,
  FIRMWARE_UPDATE_REFUSAL_CODES,
  MESHTASTICD_DOCS_URL,
  firmwareUpdateRefusalMessage,
  firmwareUpdateSupport,
  getBoardName,
  noBoardReason,
  type FirmwareUpdateUnsupportedReason,
} from './firmwareHardwareMap';

type Decision =
  | { supported: true; board: string | null; platform: string; ambiguous: boolean }
  | { supported: false; reason: FirmwareUpdateUnsupportedReason };

const ok = (board: string, platform: string): Decision => ({ supported: true, board, platform, ambiguous: false });
/** Several release builds share the model (#5423): custom URL or upload only. */
const shared = (platform: string): Decision => ({ supported: true, board: null, platform, ambiguous: true });
const no = (reason: FirmwareUpdateUnsupportedReason): Decision => ({ supported: false, reason });

/**
 * The decision for each hardware model name. Adding a model to
 * `HARDWARE_MODELS` means adding a line here: either the board and platform
 * it updates as, or the reason it cannot be updated.
 */
const DECISIONS: Record<string, Decision> = {
  UNSET: no('unset'),
  TLORA_V2: ok('tlora-v2', 'esp32'),
  TLORA_V1: ok('tlora-v1', 'esp32'),
  TLORA_V2_1_1P6: shared('esp32'),
  TBEAM: ok('tbeam', 'esp32'),
  HELTEC_V2_0: ok('heltec-v2_0', 'esp32'),
  TBEAM_V0P7: ok('tbeam0_7', 'esp32'),
  T_ECHO: no('platform-not-ota'),
  TLORA_V1_1P3: ok('tlora-v1-1p3', 'esp32'),
  RAK4631: no('platform-not-ota'),
  HELTEC_V2_1: ok('heltec-v2_1', 'esp32'),
  HELTEC_V1: ok('heltec-v1', 'esp32'),
  LILYGO_TBEAM_S3_CORE: ok('tbeam-s3-core', 'esp32s3'),
  RAK11200: ok('rak11200', 'esp32'),
  NANO_G1: ok('nano-g1', 'esp32'),
  TLORA_V2_1_1P8: ok('tlora-v2-1-1_8', 'esp32'),
  TLORA_T3_S3: shared('esp32s3'),
  NANO_G1_EXPLORER: ok('nano-g1-explorer', 'esp32'),
  NANO_G2_ULTRA: no('platform-not-ota'),
  LORA_TYPE: ok('lora-type', 'esp32'),
  WIPHONE: ok('wiphone', 'esp32'),
  WIO_WM1110: no('platform-not-ota'),
  RAK2560: no('platform-not-ota'),
  HELTEC_HRU_3601: ok('heltec-hru-3601', 'esp32c3'),
  HELTEC_WIRELESS_BRIDGE: ok('heltec-wireless-bridge', 'esp32'),
  STATION_G1: ok('station-g1', 'esp32'),
  RAK11310: no('platform-not-ota'),
  SENSELORA_RP2040: no('platform-not-ota'),
  SENSELORA_S3: ok('senselora-s3', 'esp32s3'),
  CANARYONE: no('platform-not-ota'),
  RP2040_LORA: no('platform-not-ota'),
  STATION_G2: ok('station-g2', 'esp32s3'),
  LORA_RELAY_V1: ok('lora-relay-v1', 'esp32'),
  T_ECHO_PLUS: no('platform-not-ota'),
  PPR: no('unmapped-board'),
  GENIEBLOCKS: no('unmapped-board'),
  NRF52_UNKNOWN: no('platform-not-ota'),
  PORTDUINO: no('linux-native'),
  ANDROID_SIM: no('simulator'),
  DIY_V1: shared('esp32'),
  NRF52840_PCA10059: no('platform-not-ota'),
  DR_DEV: ok('meshtastic-dr-dev', 'esp32'),
  M5STACK: shared('esp32'),
  HELTEC_V3: ok('heltec-v3', 'esp32s3'),
  HELTEC_WSL_V3: ok('heltec-wsl-v3', 'esp32s3'),
  BETAFPV_2400_TX: ok('betafpv_2400_tx_micro', 'esp32'),
  BETAFPV_900_NANO_TX: ok('betafpv_900_tx_nano', 'esp32'),
  RPI_PICO: no('platform-not-ota'),
  HELTEC_WIRELESS_TRACKER: ok('heltec-wireless-tracker', 'esp32s3'),
  HELTEC_WIRELESS_PAPER: ok('heltec-wireless-paper', 'esp32s3'),
  T_DECK: ok('t-deck', 'esp32s3'),
  T_WATCH_S3: ok('t-watch-s3', 'esp32s3'),
  PICOMPUTER_S3: ok('picomputer-s3', 'esp32s3'),
  HELTEC_HT62: ok('heltec-ht62-esp32c3-sx1262', 'esp32c3'),
  EBYTE_ESP32_S3: ok('EBYTE_ESP32-S3', 'esp32s3'),
  ESP32_S3_PICO: ok('ESP32-S3-Pico', 'esp32s3'),
  CHATTER_2: ok('chatter2', 'esp32'),
  HELTEC_WIRELESS_PAPER_V1_0: ok('heltec-wireless-paper-v1_0', 'esp32s3'),
  HELTEC_WIRELESS_TRACKER_V1_0: ok('heltec-wireless-tracker-V1-0', 'esp32s3'),
  UNPHONE: ok('unphone', 'esp32s3'),
  TD_LORAC: ok('td-lorac', 'esp32s3'),
  CDEBYTE_EORA_S3: ok('CDEBYTE_EoRa-S3', 'esp32s3'),
  TWC_MESH_V4: no('platform-not-ota'),
  NRF52_PROMICRO_DIY: no('platform-not-ota'),
  RADIOMASTER_900_BANDIT_NANO: shared('esp32'),
  HELTEC_CAPSULE_SENSOR_V3: ok('heltec_capsule_sensor_v3', 'esp32s3'),
  HELTEC_VISION_MASTER_T190: ok('heltec-vision-master-t190', 'esp32s3'),
  HELTEC_VISION_MASTER_E213: ok('heltec-vision-master-e213', 'esp32s3'),
  HELTEC_VISION_MASTER_E290: ok('heltec-vision-master-e290', 'esp32s3'),
  HELTEC_MESH_NODE_T114: no('platform-not-ota'),
  SENSECAP_INDICATOR: ok('seeed-sensecap-indicator', 'esp32s3'),
  TRACKER_T1000_E: no('platform-not-ota'),
  RAK3172: no('platform-not-ota'),
  WIO_E5: no('platform-not-ota'),
  RADIOMASTER_900_BANDIT: ok('radiomaster_900_bandit', 'esp32'),
  ME25LS01_4Y10TD: no('platform-not-ota'),
  RP2040_FEATHER_RFM95: no('platform-not-ota'),
  M5STACK_COREBASIC: ok('m5stack-corebasic', 'esp32s3'),
  M5STACK_CORE2: ok('m5stack-core2', 'esp32s3'),
  RPI_PICO2: no('platform-not-ota'),
  M5STACK_CORES3: ok('m5stack-cores3', 'esp32s3'),
  SEEED_XIAO_S3: ok('seeed-xiao-s3', 'esp32s3'),
  MS24SF1: no('platform-not-ota'),
  TLORA_C6: ok('tlora-c6', 'esp32c6'),
  WISMESH_TAP: no('platform-not-ota'),
  ROUTASTIC: ok('routastic', 'esp32s3'),
  MESH_TAB: ok('mesh-tab', 'esp32s3'),
  MESHLINK: no('platform-not-ota'),
  XIAO_NRF52_KIT: no('platform-not-ota'),
  THINKNODE_M1: no('platform-not-ota'),
  THINKNODE_M2: ok('thinknode_m2', 'esp32s3'),
  T_ETH_ELITE: ok('t-eth-elite', 'esp32s3'),
  HELTEC_SENSOR_HUB: ok('heltec_sensor_hub', 'esp32s3'),
  MUZI_BASE: no('platform-not-ota'),
  HELTEC_MESH_POCKET: no('platform-not-ota'),
  SEEED_SOLAR_NODE: no('platform-not-ota'),
  NOMADSTAR_METEOR_PRO: no('platform-not-ota'),
  CROWPANEL: ok('crowpanel', 'esp32s3'),
  LINK_32: ok('link32-s3-v1', 'esp32s3'),
  SEEED_WIO_TRACKER_L1: no('platform-not-ota'),
  SEEED_WIO_TRACKER_L1_EINK: no('platform-not-ota'),
  MUZI_R1_NEO: no('platform-not-ota'),
  T_DECK_PRO: ok('t-deck-pro', 'esp32s3'),
  T_LORA_PAGER: ok('tlora-pager', 'esp32s3'),
  M5STACK_RESERVED: no('unmapped-board'),
  WISMESH_TAG: no('platform-not-ota'),
  RAK3312: ok('rak3312', 'esp32s3'),
  THINKNODE_M5: ok('thinknode_m5', 'esp32s3'),
  HELTEC_MESH_SOLAR: no('platform-not-ota'),
  T_ECHO_LITE: no('platform-not-ota'),
  HELTEC_V4: ok('heltec-v4', 'esp32s3'),
  M5STACK_C6L: ok('m5stack-unitc6l', 'esp32c6'),
  M5STACK_CARDPUTER_ADV: ok('m5stack-cardputer-adv', 'esp32s3'),
  HELTEC_WIRELESS_TRACKER_V2: ok('heltec-wireless-tracker-v2', 'esp32s3'),
  T_WATCH_ULTRA: ok('t-watch-ultra', 'esp32s3'),
  THINKNODE_M3: no('platform-not-ota'),
  WISMESH_TAP_V2: ok('rak_wismesh_tap_v2', 'esp32s3'),
  RAK3401: no('platform-not-ota'),
  RAK6421: no('platform-not-ota'),
  THINKNODE_M4: no('platform-not-ota'),
  THINKNODE_M6: no('platform-not-ota'),
  MESHSTICK_1262: no('platform-not-ota'),
  TBEAM_1_WATT: ok('t-beam-1w', 'esp32s3'),
  T5_S3_EPAPER_PRO: ok('t5-s3-epaper-pro', 'esp32s3'),
  TBEAM_BPF: ok('t-beam-bpf', 'esp32s3'),
  MINI_EPAPER_S3: ok('mini-epaper-s3', 'esp32s3'),
  TDISPLAY_S3_PRO: no('unmapped-board'),
  HELTEC_MESH_NODE_T096: no('unmapped-board'),
  MESH_TRACKER_X1: no('unmapped-board'),
  THINKNODE_M7: ok('thinknode_m7', 'esp32s3'),
  THINKNODE_M8: no('unmapped-board'),
  THINKNODE_M9: ok('thinknode_m9', 'esp32s3'),
  HELTEC_V4_R8: shared('esp32s3'),
  HELTEC_MESH_NODE_T1: no('unmapped-board'),
  STATION_G3: ok('station-g3', 'esp32s3'),
  T_IMPULSE_PLUS: no('unmapped-board'),
  T_ECHO_CARD: no('unmapped-board'),
  SEEED_WIO_TRACKER_L2: ok('seeed_wio_tracker_L2-tft', 'esp32s3'),
  CROWPANEL_P4: no('unmapped-board'),
  HELTEC_MESH_TOWER_V2: no('unmapped-board'),
  MESHNOLOGY_W10: ok('meshnology_w10', 'esp32s3'),
  HELTEC_RC32: ok('heltec-rc32', 'esp32s3'),
  HELTEC_RC52: no('unmapped-board'),
  HELTEC_RCC6: ok('heltec-rcc6', 'esp32c6'),
  PRIVATE_HW: no('unmapped-board'),
};

const MODELS = Object.entries(HARDWARE_MODELS).map(([num, name]) => [Number(num), name] as const);

describe('firmwareUpdateSupport — every hardware model has a decision (#5677)', () => {
  it('has a decision for every model, and no decision for a model that is gone', () => {
    const names = MODELS.map(([, name]) => name).sort();
    const undecided = names.filter((name) => !(name in DECISIONS));
    const stale = Object.keys(DECISIONS).filter((name) => !names.includes(name));
    expect(
      undecided,
      'New hardware model(s) with no firmware-update decision. Add each to DECISIONS in this file ' +
        '(and to BOARD_PLATFORM_MAP / EXCLUDED_MODELS in firmwareHardwareMap.ts as needed).'
    ).toEqual([]);
    expect(stale).toEqual([]);
  });

  it.each(MODELS)('hwModel %i (%s) matches its decision', (hwModel, name) => {
    const decision = DECISIONS[name];
    const support = firmwareUpdateSupport(hwModel);
    expect(support.modelName).toBe(name);
    if (decision.supported) {
      expect(support).toEqual({ ...decision, modelName: name });
    } else {
      expect(support).toMatchObject({
        supported: false,
        reason: decision.reason,
        code: FIRMWARE_UPDATE_REFUSAL_CODES[decision.reason],
      });
    }
  });

  it.each(MODELS)('hwModel %i (%s): supported exactly when it resolves to an OTA platform', (hwModel) => {
    const support = firmwareUpdateSupport(hwModel);
    if (support.supported) {
      expect(['esp32', 'esp32s3', 'esp32c3', 'esp32c6']).toContain(support.platform);
      expect(getBoardName(hwModel)).not.toBeNull();
    } else {
      expect(support.reason).toBeTruthy();
    }
  });
});

describe('firmwareUpdateSupport — refusal reasons (#5677)', () => {
  it('the exclusion list is exactly UNSET, ANDROID_SIM and PORTDUINO', () => {
    expect(EXCLUDED_MODELS).toEqual({
      UNSET: 'unset',
      ANDROID_SIM: 'simulator',
      PORTDUINO: 'linux-native',
    });
  });

  it('every excluded model has no board name and its own reason', () => {
    for (const [name, reason] of Object.entries(EXCLUDED_MODELS)) {
      const hwModel = MODELS.find(([, n]) => n === name)?.[0];
      expect(hwModel, name).toBeDefined();
      expect(getBoardName(hwModel!)).toBeNull();
      expect(noBoardReason(hwModel!)).toBe(reason);
      expect(firmwareUpdateSupport(hwModel!)).toMatchObject({ supported: false, reason });
    }
  });

  it('PORTDUINO (37, meshtasticd) is linux-native', () => {
    expect(firmwareUpdateSupport(37)).toEqual({
      supported: false,
      reason: 'linux-native',
      code: 'OTA_HARDWARE_LINUX_NATIVE',
      modelName: 'PORTDUINO',
      board: null,
      platform: null,
    });
  });

  it.each([200, 9999, -1, 1.5, Number.NaN])('a model number with no name (%s) is unknown-model', (hwModel) => {
    expect(firmwareUpdateSupport(hwModel)).toEqual({
      supported: false,
      reason: 'unknown-model',
      code: 'OTA_UNKNOWN_HARDWARE',
      modelName: null,
      board: null,
      platform: null,
    });
  });

  it('a named model with no platform mapping is unmapped-board', () => {
    expect(firmwareUpdateSupport(255)).toMatchObject({
      supported: false,
      reason: 'unmapped-board',
      code: 'OTA_BOARD_UNMAPPED',
      modelName: 'PRIVATE_HW',
      board: 'private-hw',
      platform: null,
    });
  });

  it('an nRF52840 board is platform-not-ota', () => {
    expect(firmwareUpdateSupport(9)).toMatchObject({
      supported: false,
      reason: 'platform-not-ota',
      code: 'OTA_PLATFORM_UNSUPPORTED',
      modelName: 'RAK4631',
      board: 'rak4631',
      platform: 'nrf52840',
    });
  });

  it('gives each reason a distinct machine code', () => {
    const codes = Object.values(FIRMWARE_UPDATE_REFUSAL_CODES);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code).toMatch(/^OTA_[A-Z_]+$/);
  });

  it('writes a server message for each reason', () => {
    expect(firmwareUpdateRefusalMessage('linux-native', { hwModel: 37 })).toContain(MESHTASTICD_DOCS_URL);
    expect(firmwareUpdateRefusalMessage('unknown-model', { hwModel: 200 })).toBe(
      'Unknown hardware model 200: cannot determine board name'
    );
    expect(
      firmwareUpdateRefusalMessage('platform-not-ota', { hwModel: 9, board: 'rak4631', platform: 'nrf52840' })
    ).toBe('Board "rak4631" (platform: nrf52840) is not OTA capable');
    expect(firmwareUpdateRefusalMessage('unmapped-board', { hwModel: 255, board: 'private-hw' })).toBe(
      'Board "private-hw" (platform: unknown) is not OTA capable'
    );
    expect(firmwareUpdateRefusalMessage('unset', { hwModel: 0 })).toMatch(/UNSET/);
    expect(firmwareUpdateRefusalMessage('simulator', { hwModel: 38 })).toMatch(/simulator/);
  });
});
