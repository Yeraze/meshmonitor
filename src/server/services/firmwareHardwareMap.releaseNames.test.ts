/**
 * OTA board map vs. real Meshtastic release file names (#5423 follow-up).
 *
 * The fixtures below are the ESP32-family `board` entries of the release
 * manifests (`firmware-<ver>.json`) for v2.8.0.47db0e3 and v2.7.26.54e0d8d.
 * They were cross-checked against the central directories of the
 * `firmware-<platform>-<ver>.zip` assets: every manifest board ships exactly
 * one `firmware-<board>-<ver>.bin` in its platform zip (2.8.0 nests them under
 * `<platform>/`, 2.7.26 does not). No board was renamed between 2.7.18 and
 * 2.8.0 — later releases only add boards — so one slug per hw model serves
 * every OTA-capable version.
 *
 * Static fixtures on purpose: no network in tests.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../services/database.js', () => ({
  default: { settings: { getSetting: vi.fn(), setSetting: vi.fn() } },
}));
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./dataEventEmitter.js', () => ({ dataEventEmitter: { emit: vi.fn() } }));
vi.mock('../meshtasticManager.js', () => ({ fallbackManager: {} }));
vi.mock('../sourceManagerRegistry.js', () => ({ sourceManagerRegistry: {} }));
vi.mock('../sourceManagerTypes.js', () => ({ getPrimaryMeshtasticManager: vi.fn() }));

import {
  AMBIGUOUS_OTA_MODELS,
  getAmbiguousOtaModel,
  getBoardName,
  getPlatformForBoard,
  isOtaCapable,
} from './firmwareHardwareMap.js';
import { FirmwareUpdateService, OtaPreflightError } from './firmwareUpdateService.js';
import { HARDWARE_MODELS } from '../../utils/hardwareModel.js';

type EspPlatform = 'esp32' | 'esp32c3' | 'esp32c6' | 'esp32s3';

const RELEASE_ESP_BOARDS: Record<string, Record<EspPlatform, string[]>> = {
  '2.8.0.47db0e3': {
    esp32: [
      'chatter2', 'hydra', 'm5stack-core', 'm5stack-coreink', 'meshtastic-diy-v1', 'nano-g1',
      'nano-g1-explorer', 'radiomaster_900_bandit', 'radiomaster_900_bandit_micro',
      'radiomaster_900_bandit_nano', 'rak11200', 'station-g1', 'tbeam', 'tlora-v2-1-1_6',
      'tlora-v3-3-0-tcxo',
    ],
    esp32c3: ['heltec-hru-3601', 'heltec-ht62-esp32c3-sx1262'],
    esp32c6: ['heltec-rcc6', 'm5stack-unitc6l', 'tlora-c6'],
    esp32s3: [
      'CDEBYTE_EoRa-S3', 'elecrow-adv-24-28-tft', 'elecrow-adv-35-tft', 'elecrow-adv1-43-50-70-tft',
      'hackaday-communicator', 'heltec-rc32', 'heltec-v3', 'heltec-v4', 'heltec-v4-r8-oled',
      'heltec-v4-r8-tft', 'heltec-v4-tft', 'heltec-vision-master-e213',
      'heltec-vision-master-e213-inkhud', 'heltec-vision-master-e290',
      'heltec-vision-master-e290-inkhud', 'heltec-vision-master-t190', 'heltec-wireless-paper',
      'heltec-wireless-paper-inkhud', 'heltec-wireless-tracker', 'heltec-wireless-tracker-v2',
      'heltec-wsl-v3', 'heltec_capsule_sensor_v3', 'heltec_sensor_hub', 'm5stack-cardputer-adv',
      'm5stack-cores3', 'meshnology_w10', 'meshnology_w12', 'mini-epaper-s3',
      'mini-epaper-s3-inkhud', 'picomputer-s3', 'picomputer-s3-tft', 'rak3312',
      'rak_wismesh_tap_v2', 'rak_wismesh_tap_v2-tft', 'seeed-sensecap-indicator',
      'seeed-sensecap-indicator-tft', 'seeed-xiao-s3', 'seeed_wio_tracker_L2-tft', 'station-g2',
      'station-g3', 't-beam-1w', 't-beam-bpf', 't-deck', 't-deck-pro', 't-deck-pro-v1_1',
      't-deck-tft', 't-eth-elite', 't-watch-s3', 't-watch-ultra', 't5s3-epaper-v1',
      't5s3-epaper-v2', 'tbeam-s3-core', 'thinknode_g3', 'thinknode_m2', 'thinknode_m5',
      'thinknode_m7', 'thinknode_m9', 'thinknode_m9-tft', 'tlora-pager', 'tlora-t3s3-epaper',
      'tlora-t3s3-epaper-inkhud', 'tlora-t3s3-v1', 'tracksenger', 'tracksenger-lcd',
      'tracksenger-oled', 'unphone',
    ],
  },
  '2.7.26.54e0d8d': {
    esp32: [
      'chatter2', 'hydra', 'm5stack-core', 'm5stack-coreink', 'meshtastic-diy-v1', 'nano-g1',
      'nano-g1-explorer', 'radiomaster_900_bandit', 'radiomaster_900_bandit_micro',
      'radiomaster_900_bandit_nano', 'rak11200', 'station-g1', 'tbeam', 'tlora-v2-1-1_6',
      'tlora-v3-3-0-tcxo',
    ],
    esp32c3: ['heltec-hru-3601', 'heltec-ht62-esp32c3-sx1262'],
    esp32c6: ['m5stack-unitc6l', 'tlora-c6'],
    esp32s3: [
      'CDEBYTE_EoRa-S3', 'elecrow-adv-24-28-tft', 'elecrow-adv-35-tft', 'elecrow-adv1-43-50-70-tft',
      'hackaday-communicator', 'heltec-v3', 'heltec-v4', 'heltec-v4-r8-oled', 'heltec-v4-r8-tft',
      'heltec-v4-tft', 'heltec-vision-master-e213', 'heltec-vision-master-e213-inkhud',
      'heltec-vision-master-e290', 'heltec-vision-master-e290-inkhud', 'heltec-vision-master-t190',
      'heltec-wireless-paper', 'heltec-wireless-paper-inkhud', 'heltec-wireless-tracker',
      'heltec-wireless-tracker-v2', 'heltec-wsl-v3', 'heltec_capsule_sensor_v3',
      'heltec_sensor_hub', 'm5stack-cardputer-adv', 'm5stack-cores3', 'mini-epaper-s3',
      'mini-epaper-s3-inkhud', 'picomputer-s3', 'picomputer-s3-tft', 'rak3312',
      'rak_wismesh_tap_v2', 'rak_wismesh_tap_v2-tft', 'seeed-sensecap-indicator',
      'seeed-sensecap-indicator-tft', 'seeed-xiao-s3', 'station-g2', 'station-g3', 't-beam-1w',
      't-deck', 't-deck-pro', 't-deck-pro-v1_1', 't-deck-tft', 't-eth-elite', 't-watch-s3',
      't5s3-epaper-v1', 't5s3-epaper-v2', 'tbeam-s3-core', 'thinknode_g3', 'thinknode_m2',
      'thinknode_m5', 'thinknode_m7', 'tlora-pager', 'tlora-t3s3-epaper',
      'tlora-t3s3-epaper-inkhud', 'tlora-t3s3-v1', 'tracksenger', 'tracksenger-lcd',
      'tracksenger-oled', 'unphone',
    ],
  },
};

const V280 = '2.8.0.47db0e3';
const V2726 = '2.7.26.54e0d8d';

/**
 * [hwModel, enum name, release board, platform, releases that ship it].
 * Rows marked (#5423 audit) changed in this PR; the rest pin existing mappings.
 */
const OTA_BOARDS: Array<[number, string, string, EspPlatform, string[]]> = [
  [4, 'TBEAM', 'tbeam', 'esp32', [V280, V2726]],
  [12, 'LILYGO_TBEAM_S3_CORE', 'tbeam-s3-core', 'esp32s3', [V280, V2726]],
  [13, 'RAK11200', 'rak11200', 'esp32', [V280, V2726]],
  [14, 'NANO_G1', 'nano-g1', 'esp32', [V280, V2726]],
  [17, 'NANO_G1_EXPLORER', 'nano-g1-explorer', 'esp32', [V280, V2726]],
  [23, 'HELTEC_HRU_3601', 'heltec-hru-3601', 'esp32c3', [V280, V2726]],
  [25, 'STATION_G1', 'station-g1', 'esp32', [V280, V2726]],
  [31, 'STATION_G2', 'station-g2', 'esp32s3', [V280, V2726]],
  [43, 'HELTEC_V3', 'heltec-v3', 'esp32s3', [V280, V2726]],
  [44, 'HELTEC_WSL_V3', 'heltec-wsl-v3', 'esp32s3', [V280, V2726]],
  [48, 'HELTEC_WIRELESS_TRACKER', 'heltec-wireless-tracker', 'esp32s3', [V280, V2726]],
  [49, 'HELTEC_WIRELESS_PAPER', 'heltec-wireless-paper', 'esp32s3', [V280, V2726]],
  [50, 'T_DECK', 't-deck', 'esp32s3', [V280, V2726]],
  [51, 'T_WATCH_S3', 't-watch-s3', 'esp32s3', [V280, V2726]],
  [52, 'PICOMPUTER_S3', 'picomputer-s3', 'esp32s3', [V280, V2726]],
  [53, 'HELTEC_HT62', 'heltec-ht62-esp32c3-sx1262', 'esp32c3', [V280, V2726]],
  [56, 'CHATTER_2', 'chatter2', 'esp32', [V280, V2726]], // #5423 audit
  [59, 'UNPHONE', 'unphone', 'esp32s3', [V280, V2726]],
  [61, 'CDEBYTE_EORA_S3', 'CDEBYTE_EoRa-S3', 'esp32s3', [V280, V2726]], // #5423 audit
  [65, 'HELTEC_CAPSULE_SENSOR_V3', 'heltec_capsule_sensor_v3', 'esp32s3', [V280, V2726]], // #5423 audit
  [66, 'HELTEC_VISION_MASTER_T190', 'heltec-vision-master-t190', 'esp32s3', [V280, V2726]],
  [67, 'HELTEC_VISION_MASTER_E213', 'heltec-vision-master-e213', 'esp32s3', [V280, V2726]],
  [68, 'HELTEC_VISION_MASTER_E290', 'heltec-vision-master-e290', 'esp32s3', [V280, V2726]],
  [70, 'SENSECAP_INDICATOR', 'seeed-sensecap-indicator', 'esp32s3', [V280, V2726]],
  [74, 'RADIOMASTER_900_BANDIT', 'radiomaster_900_bandit', 'esp32', [V280, V2726]], // #5423 audit
  [80, 'M5STACK_CORES3', 'm5stack-cores3', 'esp32s3', [V280, V2726]],
  [81, 'SEEED_XIAO_S3', 'seeed-xiao-s3', 'esp32s3', [V280, V2726]],
  [83, 'TLORA_C6', 'tlora-c6', 'esp32c6', [V280, V2726]],
  [90, 'THINKNODE_M2', 'thinknode_m2', 'esp32s3', [V280, V2726]], // #5423 audit
  [91, 'T_ETH_ELITE', 't-eth-elite', 'esp32s3', [V280, V2726]],
  [92, 'HELTEC_SENSOR_HUB', 'heltec_sensor_hub', 'esp32s3', [V280, V2726]], // #5423 audit
  [102, 'T_DECK_PRO', 't-deck-pro', 'esp32s3', [V280, V2726]],
  [103, 'T_LORA_PAGER', 'tlora-pager', 'esp32s3', [V280, V2726]], // #5423 audit
  [106, 'RAK3312', 'rak3312', 'esp32s3', [V280, V2726]], // #5423 audit
  [107, 'THINKNODE_M5', 'thinknode_m5', 'esp32s3', [V280, V2726]], // #5423 audit
  // HELTEC_V4 is also shared (heltec-v4-tft carries hw model 110 too) but
  // keeps its pre-existing heltec-v4 mapping on purpose (#5402).
  [110, 'HELTEC_V4', 'heltec-v4', 'esp32s3', [V280, V2726]],
  [111, 'M5STACK_C6L', 'm5stack-unitc6l', 'esp32c6', [V280, V2726]], // #5423 audit
  [112, 'M5STACK_CARDPUTER_ADV', 'm5stack-cardputer-adv', 'esp32s3', [V280, V2726]],
  [113, 'HELTEC_WIRELESS_TRACKER_V2', 'heltec-wireless-tracker-v2', 'esp32s3', [V280, V2726]],
  [114, 'T_WATCH_ULTRA', 't-watch-ultra', 'esp32s3', [V280]],
  [116, 'WISMESH_TAP_V2', 'rak_wismesh_tap_v2', 'esp32s3', [V280, V2726]], // #5423 audit
  [122, 'TBEAM_1_WATT', 't-beam-1w', 'esp32s3', [V280, V2726]], // #5423 audit
  [124, 'TBEAM_BPF', 't-beam-bpf', 'esp32s3', [V280]], // #5423 audit
  [125, 'MINI_EPAPER_S3', 'mini-epaper-s3', 'esp32s3', [V280, V2726]], // #5423 audit
  [129, 'THINKNODE_M7', 'thinknode_m7', 'esp32s3', [V280, V2726]], // #5423 audit
  [131, 'THINKNODE_M9', 'thinknode_m9', 'esp32s3', [V280]], // #5423 audit
  [134, 'STATION_G3', 'station-g3', 'esp32s3', [V280, V2726]],
  [137, 'SEEED_WIO_TRACKER_L2', 'seeed_wio_tracker_L2-tft', 'esp32s3', [V280]], // #5423 audit
  [140, 'MESHNOLOGY_W10', 'meshnology_w10', 'esp32s3', [V280]], // #5423 audit
  [141, 'HELTEC_RC32', 'heltec-rc32', 'esp32s3', [V280]], // #5423 audit
  [143, 'HELTEC_RCC6', 'heltec-rcc6', 'esp32c6', [V280]], // #5423 audit
];

/**
 * nRF52840 boards the old map wrongly placed on esp32s3 (or whose slug was
 * wrong). Evidence: `variants/nrf52840/<dir>/platformio.ini` at v2.8.0.
 */
const NRF_BOARDS: Array<[number, string, string]> = [
  [18, 'NANO_G2_ULTRA', 'nano-g2-ultra'],
  [62, 'TWC_MESH_V4', 'TWC_mesh_v4'],
  [69, 'HELTEC_MESH_NODE_T114', 'heltec-mesh-node-t114'],
  [87, 'MESHLINK', 'meshlink'],
  [89, 'THINKNODE_M1', 'thinknode_m1'],
  [93, 'MUZI_BASE', 'muzi-base'],
  [94, 'HELTEC_MESH_POCKET', 'heltec-mesh-pocket'],
  [96, 'NOMADSTAR_METEOR_PRO', 'rak4631_nomadstar_meteor_pro'],
  [101, 'MUZI_R1_NEO', 'r1-neo'],
  [108, 'HELTEC_MESH_SOLAR', 'heltec-mesh-solar'],
  [115, 'THINKNODE_M3', 'thinknode_m3'],
  [119, 'THINKNODE_M4', 'thinknode_m4'],
  [120, 'THINKNODE_M6', 'thinknode_m6'],
];

/** hw models shared by several release builds: OTA preflight must refuse them. */
const AMBIGUOUS: Array<[number, string, EspPlatform, string[]]> = [
  [3, 'TLORA_V2_1_1P6', 'esp32', ['tlora-v2-1-1_6', 'tlora-v3-3-0-tcxo']],
  [16, 'TLORA_T3_S3', 'esp32s3', ['tlora-t3s3-v1', 'tlora-t3s3-epaper']],
  [39, 'DIY_V1', 'esp32', ['meshtastic-diy-v1', 'hydra']],
  [42, 'M5STACK', 'esp32', ['m5stack-core', 'm5stack-coreink']],
  [64, 'RADIOMASTER_900_BANDIT_NANO', 'esp32', ['radiomaster_900_bandit_nano', 'radiomaster_900_bandit_micro']],
  [132, 'HELTEC_V4_R8', 'esp32s3', ['heltec-v4-r8-oled', 'heltec-v4-r8-tft']],
];

function preflightParams(hwModel: number, extra: Record<string, unknown> = {}) {
  return {
    currentVersion: '2.7.26',
    targetVersion: '2.8.0',
    targetRelease: {
      tagName: `v${V280}`,
      version: V280,
      prerelease: true,
      publishedAt: '2026-09-01',
      htmlUrl: '',
      assets: (['esp32', 'esp32s3'] as const).map((p) => ({
        name: `firmware-${p}-${V280}.zip`,
        size: 1,
        downloadUrl: `https://example.invalid/firmware-${p}-${V280}.zip`,
      })),
    },
    gatewayIp: '192.168.1.50',
    hwModel,
    ...extra,
  } as unknown as Parameters<FirmwareUpdateService['startPreflight']>[0];
}

function releaseFiles(version: string, platform: EspPlatform): string[] {
  // 2.8.0 nests binaries under `<platform>/` (#5402); 2.7.26 does not.
  const prefix = version === V280 ? `${platform}/` : '';
  const files: string[] = [];
  for (const board of RELEASE_ESP_BOARDS[version][platform]) {
    files.push(`${prefix}firmware-${board}-${version}.bin`);
    files.push(`${prefix}firmware-${board}-${version}.factory.bin`);
    files.push(`${prefix}firmware-${board}-${version}.elf`);
  }
  return files;
}

function boardPlatformIn(version: string, board: string): EspPlatform | null {
  const byPlatform = RELEASE_ESP_BOARDS[version];
  for (const platform of Object.keys(byPlatform) as EspPlatform[]) {
    if (byPlatform[platform].includes(board)) return platform;
  }
  return null;
}

describe('firmwareHardwareMap vs. Meshtastic release file names', () => {
  const service = new FirmwareUpdateService();

  describe.each(OTA_BOARDS)('hwModel %i (%s)', (hwModel, enumName, board, platform, versions) => {
    it('maps to the release board name and platform, and is OTA capable', () => {
      expect(getAmbiguousOtaModel(hwModel)).toBeNull();
      expect(HARDWARE_MODELS[hwModel]).toBe(enumName);
      expect(getBoardName(hwModel)).toBe(board);
      expect(getPlatformForBoard(board)).toBe(platform);
      expect(isOtaCapable(platform)).toBe(true);
    });

    it.each(versions)('is in the %s manifest and findFirmwareBinary picks its .bin', (version) => {
      expect(boardPlatformIn(version, board)).toBe(platform);
      expect(
        service.checkBoardInManifest(
          { version, targets: RELEASE_ESP_BOARDS[version][platform].map((b) => ({ board: b, platform })) },
          board,
        ),
      ).toBe(true);

      const { matched } = service.findFirmwareBinary(releaseFiles(version, platform), board, version);
      const prefix = version === V280 ? `${platform}/` : '';
      expect(matched).toBe(`${prefix}firmware-${board}-${version}.bin`);
    });
  });

  it('lists exactly the audited ambiguous hw models', () => {
    expect(Object.keys(AMBIGUOUS_OTA_MODELS).sort()).toEqual(AMBIGUOUS.map(([, e]) => e).sort());
  });

  describe.each(AMBIGUOUS)('ambiguous hwModel %i (%s)', (hwModel, enumName, platform, builds) => {
    it('lists release builds that all ship in 2.8.0 on one platform', () => {
      expect(HARDWARE_MODELS[hwModel]).toBe(enumName);
      expect(getAmbiguousOtaModel(hwModel)).toEqual({ enumName, platform, builds });
      for (const b of builds) expect(boardPlatformIn(V280, b)).toBe(platform);
    });

    it('is not mapped to any single release board', () => {
      const board = getBoardName(hwModel);
      expect(builds).not.toContain(board);
      expect(board && getPlatformForBoard(board)).toBeFalsy();
    });

    it('is refused by OTA preflight for a release update with a specific message', () => {
      const svc = new FirmwareUpdateService();
      let caught: unknown;
      try {
        svc.startPreflight(preflightParams(hwModel));
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(OtaPreflightError);
      const err = caught as OtaPreflightError;
      expect(err.code).toBe('OTA_AMBIGUOUS_BOARD');
      expect(err.message).toContain(`is shared by several firmware builds (${builds.join(', ')})`);
      expect(err.message).toContain("MeshMonitor can't tell which one this node runs");
      expect(err.message).toMatch(/Flash it manually/);
      expect(svc.getStatus().state).toBe('idle');
    });

    it('still allows a custom URL, where the operator picks the build', () => {
      const svc = new FirmwareUpdateService();
      svc.startPreflight(
        preflightParams(hwModel, { targetRelease: null, customUrl: 'https://example.invalid/fw.bin' }),
      );
      expect(svc.getStatus().state).toBe('awaiting-confirm');
      expect(svc.getStatus().preflightInfo?.platform).toBe(platform);
    });
  });

  it.each(NRF_BOARDS)('hwModel %i (%s) is nRF52840 (%s) and not OTA capable', (hwModel, enumName, board) => {
    expect(HARDWARE_MODELS[hwModel]).toBe(enumName);
    expect(getBoardName(hwModel)).toBe(board);
    expect(getPlatformForBoard(board)).toBe('nrf52840');
    expect(isOtaCapable('nrf52840')).toBe(false);
  });

  it('never assigns a release board to a different platform than the release does', () => {
    for (const hwModel of Object.keys(HARDWARE_MODELS).map(Number)) {
      const board = getBoardName(hwModel);
      if (!board) continue;
      for (const version of [V280, V2726]) {
        const releasePlatform = boardPlatformIn(version, board);
        if (releasePlatform) {
          expect(getPlatformForBoard(board), `${board} in ${version}`).toBe(releasePlatform);
        }
      }
    }
  });

  it('maps every OTA-capable hw model to a board that the 2.8.0 release ships, or to a known exception', () => {
    // Legacy / board_level=extra builds that release zips do not carry, plus
    // hw models with several equally-valid builds (CROWPANEL: three panel
    // sizes; MESH_TAB: seven panels) — these fail safe at the binary match.
    const NOT_IN_RELEASE = new Set([
      'tlora-v2', 'tlora-v1', 'heltec-v2_0', 'tbeam0_7', 'tlora-v1-1p3', 'heltec-v2_1', 'heltec-v1',
      'tlora-v2-1-1_8', 'lora-type', 'wiphone', 'heltec-wireless-bridge', 'senselora-s3',
      'lora-relay-v1', 'meshtastic-dr-dev', 'betafpv_2400_tx_micro', 'betafpv_900_tx_nano',
      'EBYTE_ESP32-S3', 'ESP32-S3-Pico', 'heltec-wireless-paper-v1_0',
      'heltec-wireless-tracker-V1-0', 'td-lorac', 'm5stack-corebasic', 'm5stack-core2',
      'routastic', 'mesh-tab', 'crowpanel', 'link32-s3-v1', 't5-s3-epaper-pro',
    ]);
    const unexpected: string[] = [];
    for (const hwModel of Object.keys(HARDWARE_MODELS).map(Number)) {
      const board = getBoardName(hwModel);
      const platform = board ? getPlatformForBoard(board) : null;
      if (!board || !platform || !isOtaCapable(platform)) continue;
      if (!boardPlatformIn(V280, board) && !NOT_IN_RELEASE.has(board)) {
        unexpected.push(`${hwModel}:${board}`);
      }
    }
    expect(unexpected).toEqual([]);
  });
});
