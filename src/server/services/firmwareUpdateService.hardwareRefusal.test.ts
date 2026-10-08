/**
 * #5677: OTA preflight refuses hardware MeshMonitor cannot update, with a
 * machine code, and never moves the update state off idle.
 *
 * The other firmwareUpdateService suites mock `./firmwareHardwareMap.js`.
 * This one runs the REAL map, for every hardware model, and holds preflight
 * to the same verdict the Firmware Updates pane gets from
 * `firmwareUpdateSupport` — so the card and the server cannot drift.
 */
import { describe, it, expect, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- hoisted block runs before ESM imports are bound
  const nodeFs = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
  const nodeOs = require('os') as typeof import('os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
  const nodePath = require('path') as typeof import('path');
  process.env.DATA_DIR = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'mm-firmware-hw-'));
});

vi.mock('../../services/database.js', () => ({
  default: {
    settings: {
      getSetting: vi.fn().mockResolvedValue(null),
      setSetting: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const emit = vi.hoisted(() => vi.fn());
vi.mock('./dataEventEmitter.js', () => ({ dataEventEmitter: { emit } }));

const mockManager = vi.hoisted(() => ({
  userReconnect: vi.fn().mockResolvedValue(undefined),
  userDisconnect: vi.fn().mockResolvedValue(undefined),
  resetModuleConfigCache: vi.fn(),
  getLocalNodeInfo: vi.fn().mockReturnValue(null),
}));
vi.mock('../meshtasticManager.js', () => ({ fallbackManager: mockManager }));
vi.mock('../sourceManagerRegistry.js', () => ({ sourceManagerRegistry: {} }));
vi.mock('../sourceManagerTypes.js', () => ({
  getPrimaryMeshtasticManager: vi.fn(() => undefined as unknown),
}));

import { FirmwareUpdateService, OtaPreflightError } from './firmwareUpdateService.js';
import { HARDWARE_MODELS } from '../../utils/hardwareModel.js';
import {
  FIRMWARE_UPDATE_REFUSAL_CODES,
  firmwareUpdateSupport,
  type FirmwareUpdateUnsupportedReason,
} from '../../utils/firmwareHardwareMap.js';

const CUSTOM_URL = 'https://builds.example.com/firmware.bin';

/**
 * Preflight on the most permissive path: a custom URL skips the ambiguous
 * board refusal (#5423) and needs no release, so only the hardware decides.
 */
function preflight(service: FirmwareUpdateService, hwModel: number): void {
  service.startPreflight({
    currentVersion: '2.7.26.abcdef0',
    targetVersion: CUSTOM_URL,
    targetRelease: null,
    gatewayIp: '10.0.0.5',
    hwModel,
    customUrl: CUSTOM_URL,
  });
}

function refusal(service: FirmwareUpdateService, hwModel: number): OtaPreflightError | null {
  try {
    preflight(service, hwModel);
    return null;
  } catch (err) {
    if (err instanceof OtaPreflightError) return err;
    throw err;
  }
}

const MODELS = Object.entries(HARDWARE_MODELS).map(([num, name]) => [Number(num), name] as const);

describe('firmwareUpdateService — hardware refusals agree with the pane (#5677)', () => {
  it.each(MODELS)('hwModel %i (%s)', (hwModel) => {
    const service = new FirmwareUpdateService();
    const support = firmwareUpdateSupport(hwModel);
    const refused = refusal(service, hwModel);

    if (support.supported) {
      expect(refused).toBeNull();
      expect(service.getStatus().state).toBe('awaiting-confirm');
    } else {
      expect(refused?.code).toBe(support.code);
      // Refused before anything starts: no state change, nothing staged.
      expect(service.getStatus()).toMatchObject({ state: 'idle', step: null });
    }
  });

  const CASES: Array<[string, number, FirmwareUpdateUnsupportedReason, RegExp]> = [
    ['UNSET', 0, 'unset', /has not reported its hardware model/],
    ['ANDROID_SIM', 38, 'simulator', /simulator/],
    ['PORTDUINO (meshtasticd)', 37, 'linux-native', /meshtasticd/],
    ['a model number with no name', 200, 'unknown-model', /Unknown hardware model 200/],
    ['PRIVATE_HW (no build mapped)', 255, 'unmapped-board', /private-hw.*platform: unknown.*not OTA capable/],
    ['RAK4631 (nRF52840)', 9, 'platform-not-ota', /rak4631.*platform: nrf52840.*not OTA capable/],
  ];

  it.each(CASES)('refuses %s with its machine code', (_label, hwModel, reason, message) => {
    const service = new FirmwareUpdateService();
    emit.mockClear();
    const refused = refusal(service, hwModel);

    expect(refused).toBeInstanceOf(OtaPreflightError);
    expect(refused?.code).toBe(FIRMWARE_UPDATE_REFUSAL_CODES[reason]);
    expect(refused?.message).toMatch(message);
    expect(service.getStatus().state).toBe('idle');
    // No status broadcast either: the wizard never opens.
    expect(emit).not.toHaveBeenCalled();
  });

  it('refuses an excluded model on every channel, uploads included', () => {
    const service = new FirmwareUpdateService();
    expect(() =>
      service.startPreflight({
        currentVersion: '2.7.26.abcdef0',
        targetVersion: 'firmware.bin',
        targetRelease: null,
        gatewayIp: '10.0.0.5',
        hwModel: 37,
        useStagedUpload: true,
      })
    ).toThrow(OtaPreflightError);
    expect(service.getStatus().state).toBe('idle');
  });
});
