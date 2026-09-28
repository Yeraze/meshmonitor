/**
 * OTA lifecycle is per-source (#5424 follow-up).
 *
 * A Meshtastic node accepts one TCP client. The wizard frees that slot before
 * the meshtastic CLI runs and takes it back afterwards. Every one of those
 * disconnects and reconnects used to resolve the PRIMARY manager, so an update
 * started from a non-primary source freed the wrong node's slot and the CLI
 * hung on the real target. These pin that each step, including failure,
 * cancel and retry, acts on the source the update was started for.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- hoisted block runs before ESM imports are bound
  const nodeFs = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
  const nodeOs = require('os') as typeof import('os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
  const nodePath = require('path') as typeof import('path');
  process.env.DATA_DIR = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'mm-firmware-src-'));
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

vi.mock('./dataEventEmitter.js', () => ({ dataEventEmitter: { emit: vi.fn() } }));

vi.mock('./firmwareHardwareMap.js', () => ({
  getBoardName: vi.fn().mockReturnValue('station-g2'),
  getPlatformForBoard: vi.fn().mockReturnValue('esp32s3'),
  isOtaCapable: vi.fn().mockReturnValue(true),
  getHardwareDisplayName: vi.fn().mockReturnValue('Station G2'),
}));

function fakeManager() {
  return {
    sourceType: 'meshtastic_tcp',
    userReconnect: vi.fn().mockResolvedValue(undefined),
    userDisconnect: vi.fn().mockResolvedValue(undefined),
    resetModuleConfigCache: vi.fn(),
    getLocalNodeInfo: vi.fn().mockReturnValue(null),
  };
}

const { managers, primary, fallback } = vi.hoisted(() => ({
  managers: new Map<string, any>(),
  primary: { current: undefined as any },
  fallback: {
    sourceType: 'meshtastic_tcp',
    userReconnect: vi.fn(),
    userDisconnect: vi.fn(),
    resetModuleConfigCache: vi.fn(),
    getLocalNodeInfo: vi.fn(),
  },
}));

vi.mock('../meshtasticManager.js', () => ({ fallbackManager: fallback }));
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: { getManager: (id: string) => managers.get(id) },
}));
vi.mock('../sourceManagerTypes.js', () => ({
  getPrimaryMeshtasticManager: () => primary.current,
  isMeshtasticManager: (m: { sourceType?: string }) => m?.sourceType === 'meshtastic_tcp',
}));

import { FirmwareUpdateService } from './firmwareUpdateService.js';

const SRC_A = 'src-a';
const SRC_B = 'src-b';

describe('FirmwareUpdateService — per-source OTA (#5424 follow-up)', () => {
  let service: FirmwareUpdateService;
  let svc: any;
  let mgrA: ReturnType<typeof fakeManager>;
  let mgrB: ReturnType<typeof fakeManager>;

  const preflightOnB = () =>
    service.startPreflight({
      currentVersion: '2.7.20',
      targetVersion: 'https://example.com/fw.bin',
      targetRelease: null,
      gatewayIp: '10.0.0.2',
      hwModel: 43,
      customUrl: 'https://example.com/fw.bin',
      sourceId: SRC_B,
    });

  const expectOnlyB = (method: 'userDisconnect' | 'userReconnect') => {
    expect(mgrB[method]).toHaveBeenCalled();
    expect(mgrA[method]).not.toHaveBeenCalled();
    expect(fallback[method]).not.toHaveBeenCalled();
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mgrA = fakeManager();
    mgrB = fakeManager();
    managers.clear();
    managers.set(SRC_A, mgrA);
    managers.set(SRC_B, mgrB);
    // A is the primary: before the fix every call below landed on it.
    primary.current = mgrA;
    service = new FirmwareUpdateService();
    svc = service as any;
  });

  it('records the sourceId on the status at preflight', () => {
    preflightOnB();
    expect(service.getStatus().sourceId).toBe(SRC_B);
  });

  it("disconnectFromNode frees source B's slot, not the primary's", async () => {
    preflightOnB();
    await service.disconnectFromNode();
    expectOnlyB('userDisconnect');
  });

  it('a backup failure reconnects source B', async () => {
    preflightOnB();
    vi.spyOn(svc, 'waitForNodeTcpReady').mockRejectedValue(new Error('no route to host'));
    await expect(service.executeBackup('10.0.0.2', '!0000000b')).rejects.toThrow('no route to host');
    expectOnlyB('userReconnect');
    expect(service.getStatus().sourceId).toBe(SRC_B);
  });

  it('cancel after disconnect reconnects source B and clears the sourceId', async () => {
    preflightOnB();
    svc.updateStatus({ state: 'in-progress', step: 'download' });
    await service.cancelUpdate();
    expectOnlyB('userReconnect');
    expect(service.getStatus().state).toBe('idle');
    expect(service.getStatus().sourceId).toBeUndefined();
  });

  it('retry after a failed flash reconnects source B again', async () => {
    preflightOnB();
    svc.tempDir = '/tmp/does-not-matter';
    svc.updateStatus({ state: 'error', step: 'flash', matchedFile: 'firmware.bin' });

    service.retryFlash();
    expect(service.getStatus().sourceId).toBe(SRC_B);

    // Readiness fails before any CLI runs; the failure path must reconnect B.
    vi.spyOn(svc, 'waitForNodeReady').mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(service.executeFlash('10.0.0.2', '/tmp/does-not-matter/firmware.bin')).rejects.toThrow();
    expectOnlyB('userReconnect');
  });

  it('completeUpdate cycles source B and clears the sourceId', async () => {
    preflightOnB();
    svc.updateStatus({ state: 'success', step: 'verify' });
    await service.completeUpdate();
    expectOnlyB('userDisconnect');
    expectOnlyB('userReconnect');
    expect(mgrB.resetModuleConfigCache).toHaveBeenCalled();
    expect(mgrA.resetModuleConfigCache).not.toHaveBeenCalled();
    expect(service.getStatus().sourceId).toBeUndefined();
  });

  it("verify reads source B's firmware version, not the primary's", async () => {
    preflightOnB();
    mgrA.getLocalNodeInfo.mockReturnValue({ firmwareVersion: '9.9.9' });
    mgrB.getLocalNodeInfo.mockReturnValue({ firmwareVersion: '2.7.21' });
    await expect(service.waitForFirmwareVersion({ staleVersion: '2.7.20', timeoutMs: 50 })).resolves.toBe('2.7.21');
  });

  it('when source B disappears mid-update, no other radio is touched', async () => {
    preflightOnB();
    managers.delete(SRC_B);
    await expect(service.disconnectFromNode()).rejects.toThrow(/no longer available/);
    expect(service.getStatus().state).toBe('error');
    expect(mgrA.userDisconnect).not.toHaveBeenCalled();
    expect(fallback.userDisconnect).not.toHaveBeenCalled();

    svc.updateStatus({ state: 'in-progress', step: 'flash' });
    await service.cancelUpdate();
    expect(mgrA.userReconnect).not.toHaveBeenCalled();
    expect(fallback.userReconnect).not.toHaveBeenCalled();
  });

  it('without a sourceId (legacy single-source) it still uses the primary', async () => {
    service.startPreflight({
      currentVersion: '2.7.20',
      targetVersion: 'https://example.com/fw.bin',
      targetRelease: null,
      gatewayIp: '10.0.0.1',
      hwModel: 43,
      customUrl: 'https://example.com/fw.bin',
    });
    await service.disconnectFromNode();
    expect(mgrA.userDisconnect).toHaveBeenCalled();
    expect(mgrB.userDisconnect).not.toHaveBeenCalled();
  });
});
