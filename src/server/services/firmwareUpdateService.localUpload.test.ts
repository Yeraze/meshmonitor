/**
 * Local firmware upload (#5249).
 *
 * These exercise the real filesystem rather than a mocked `fs`, because the
 * whole point of the feature is that a file lands on disk and is still there
 * when the wizard reaches its download step. `DATA_DIR` is pointed at a temp
 * directory BEFORE the service module is imported — it is read once at module
 * load, so setting it later would have no effect.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// vi.hoisted so this runs BEFORE the service module is imported. The service
// captures `DATA_DIR` in a module-level const, and ESM hoists imports above
// ordinary top-level statements — assigning the env var below the import list
// would be too late and every write would hit the real `/data`.
const TEST_DATA_DIR = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- hoisted block runs before ESM imports are bound
  const nodeFs = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
  const nodeOs = require('os') as typeof import('os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'mm-firmware-upload-'));
  process.env.DATA_DIR = dir;
  return dir;
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
  getBoardName: vi.fn().mockReturnValue('heltec-v3'),
  getPlatformForBoard: vi.fn().mockReturnValue('esp32s3'),
  isOtaCapable: vi.fn().mockReturnValue(true),
  getHardwareDisplayName: vi.fn().mockReturnValue('Heltec V3'),
}));

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

import { FirmwareUpdateService } from './firmwareUpdateService.js';

const BIN = Buffer.from('not really firmware, but bytes are bytes');

describe('FirmwareUpdateService — staging an uploaded .bin (#5249)', () => {
  let service: FirmwareUpdateService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new FirmwareUpdateService();
  });

  afterEach(() => {
    service.clearStagedUpload();
  });

  it('reports nothing staged before an upload', () => {
    expect(service.getStagedUpload()).toBeNull();
  });

  it('writes the bytes to disk and reports the name and size', () => {
    const staged = service.stageUploadedFirmware(BIN, 'firmware.bin');

    expect(staged).toEqual({ originalName: 'firmware.bin', size: BIN.length });
    expect(service.getStagedUpload()).toEqual({ originalName: 'firmware.bin', size: BIN.length });
  });

  it('rejects an empty upload', () => {
    expect(() => service.stageUploadedFirmware(Buffer.alloc(0), 'firmware.bin')).toThrow(/empty/i);
    expect(service.getStagedUpload()).toBeNull();
  });

  it('rejects an upload over the size cap', () => {
    // 32 MB cap — an ESP32 app image is a few MB, so anything near this is not
    // a firmware binary.
    const tooBig = Buffer.alloc(33 * 1024 * 1024);
    expect(() => service.stageUploadedFirmware(tooBig, 'firmware.bin')).toThrow(/limit/i);
    expect(service.getStagedUpload()).toBeNull();
  });

  it('strips path separators out of the filename', () => {
    // A crafted name must not be able to place the file outside the staging
    // directory or put a path into the message shown in the UI.
    const staged = service.stageUploadedFirmware(BIN, '../../../etc/evil.bin');
    expect(staged.originalName).toBe('evil.bin');
    expect(staged.originalName).not.toContain('/');
    expect(staged.originalName).not.toContain('..');
  });

  it('never puts the uploaded name on disk (CodeQL js/http-to-file-access)', () => {
    // The display name and the on-disk name are deliberately decoupled: no
    // part of what the browser sent reaches a filesystem path.
    service.stageUploadedFirmware(BIN, 'whatever-the-user-called-it.bin');

    const stageDirs = fs
      .readdirSync(TEST_DATA_DIR)
      .filter((d) => d.startsWith('firmware-upload-'));
    expect(stageDirs).toHaveLength(1);

    const onDisk = fs.readdirSync(path.join(TEST_DATA_DIR, stageDirs[0]));
    expect(onDisk).toEqual(['uploaded-firmware.bin']);
    // …while the UI still sees the name the user recognises.
    expect(service.getStagedUpload()?.originalName).toBe('whatever-the-user-called-it.bin');
  });

  it('sanitises unusual characters rather than rejecting the upload', () => {
    const staged = service.stageUploadedFirmware(BIN, 'my firmware (v2);rm -rf.bin');
    expect(staged.originalName).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it('replaces a previously staged file instead of accumulating', () => {
    service.stageUploadedFirmware(BIN, 'first.bin');
    const second = service.stageUploadedFirmware(BIN, 'second.bin');

    expect(second.originalName).toBe('second.bin');
    expect(service.getStagedUpload()?.originalName).toBe('second.bin');

    // The first staging directory is gone, not merely forgotten.
    const leftovers = fs
      .readdirSync(TEST_DATA_DIR)
      .filter((d) => d.startsWith('firmware-upload-'));
    expect(leftovers).toHaveLength(1);
  });

  it('removes the staged file and its directory on clear', () => {
    service.stageUploadedFirmware(BIN, 'firmware.bin');
    service.clearStagedUpload();

    expect(service.getStagedUpload()).toBeNull();
    const leftovers = fs
      .readdirSync(TEST_DATA_DIR)
      .filter((d) => d.startsWith('firmware-upload-'));
    expect(leftovers).toHaveLength(0);
  });

  it('is a no-op to clear when nothing is staged', () => {
    expect(() => service.clearStagedUpload()).not.toThrow();
  });

  it('rejects a non-Buffer body', () => {
    // express.raw() gives req.body as `any`; an array with a `length` would
    // otherwise pass the size checks and reach writeFileSync.
    expect(() =>
      service.stageUploadedFirmware([1, 2, 3] as unknown as Buffer, 'firmware.bin'),
    ).toThrow(/binary body/i);
    expect(service.getStagedUpload()).toBeNull();
  });

  it('rejects a non-string filename', () => {
    // The route narrows the header, but this method is public and the name
    // feeds string operations. Raised by CodeQL as parameter tampering.
    expect(() =>
      service.stageUploadedFirmware(BIN, ['a.bin', 'b.bin'] as unknown as string),
    ).toThrow(/must be a string/i);
    expect(service.getStagedUpload()).toBeNull();
  });

  it('sweeps stale upload directories left by a previous process', () => {
    // A restart between upload and install orphans the directory: the staged
    // path lives only in memory, so nothing else would ever remove it.
    const orphan = path.join(TEST_DATA_DIR, 'firmware-upload-orphaned');
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, 'uploaded-firmware.bin'), BIN);
    expect(fs.existsSync(orphan)).toBe(true);

    // Construction is the sweep point.
    const fresh = new FirmwareUpdateService();
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fresh.getStagedUpload()).toBeNull();
  });

  it('refuses to stage while an update is already running', () => {
    // Stage, start the wizard, then try to swap the file underneath it.
    service.stageUploadedFirmware(BIN, 'firmware.bin');
    service.startPreflight({
      currentVersion: '2.7.20',
      targetVersion: 'firmware.bin',
      targetRelease: null,
      gatewayIp: '192.168.1.50',
      hwModel: 43,
      useStagedUpload: true,
    });
    expect(() => service.stageUploadedFirmware(BIN, 'other.bin')).toThrow(/in progress/i);
    // The in-flight file is untouched.
    expect(service.getStagedUpload()?.originalName).toBe('firmware.bin');
  });
});

describe('FirmwareUpdateService — preflight against a staged upload (#5249)', () => {
  let service: FirmwareUpdateService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new FirmwareUpdateService();
  });

  afterEach(() => {
    service.clearStagedUpload();
  });

  const preflight = () =>
    service.startPreflight({
      currentVersion: '2.7.20',
      targetVersion: 'firmware.bin',
      targetRelease: null,
      gatewayIp: '192.168.1.50',
      hwModel: 43,
      useStagedUpload: true,
    });

  it('refuses when no file is staged', () => {
    expect(preflight).toThrow(/No uploaded firmware is staged/);
  });

  it('reaches awaiting-confirm with the filename as the target', () => {
    service.stageUploadedFirmware(BIN, 'firmware.bin');
    preflight();

    const status = service.getStatus();
    expect(status.state).toBe('awaiting-confirm');
    expect(status.step).toBe('preflight');
    expect(status.targetVersion).toBe('firmware.bin');
  });

  it('still enforces the board and OTA-capability checks', async () => {
    // A staged upload is not a bypass for "this board cannot be flashed OTA".
    const hw = await import('./firmwareHardwareMap.js');
    vi.mocked(hw.isOtaCapable).mockReturnValueOnce(false);

    service.stageUploadedFirmware(BIN, 'firmware.bin');
    expect(preflight).toThrow(/not OTA capable/);
  });

  it('still enforces the >= 2.7.18 running-firmware gate', () => {
    service.stageUploadedFirmware(BIN, 'firmware.bin');
    expect(() =>
      service.startPreflight({
        currentVersion: '2.6.0',
        targetVersion: 'firmware.bin',
        targetRelease: null,
        gatewayIp: '192.168.1.50',
        hwModel: 43,
        useStagedUpload: true,
      }),
    ).toThrow(/2\.7\.18/);
  });

  it('copies the staged file into the run temp dir on the download step', async () => {
    service.stageUploadedFirmware(BIN, 'firmware.bin');
    preflight();

    const writtenPath = await service.executeDownload('file://firmware.bin');

    expect(fs.existsSync(writtenPath)).toBe(true);
    expect(fs.readFileSync(writtenPath)).toEqual(BIN);
    // Lands in `extracted/` so the extract step has nothing to unzip.
    expect(path.basename(path.dirname(writtenPath))).toBe('extracted');
    // Copied, not moved — a cancelled run can be retried without re-uploading.
    expect(service.getStagedUpload()).not.toBeNull();

    const status = service.getStatus();
    expect(status.step).toBe('download');
    expect(status.downloadSize).toBe(BIN.length);
  });

  it('hands the uploaded file back from extract without name matching', async () => {
    // `firmware.bin` does not match findFirmwareBinary's strict
    // `firmware-<board>-<x.y.z>.<sha>.bin` pattern. That matcher exists to pick
    // one board's binary out of a release zip; a single uploaded file has no
    // such ambiguity, so running it would reject exactly the local-build name
    // this feature exists to support.
    service.stageUploadedFirmware(BIN, 'firmware.bin');
    preflight();
    const writtenPath = await service.executeDownload('file://firmware.bin');

    const zipPath = path.join(path.dirname(path.dirname(writtenPath)), 'firmware.zip');
    const firmwarePath = await service.executeExtract(zipPath, 'heltec-v3', 'firmware.bin');

    expect(firmwarePath).toBe(writtenPath);
    // On disk it is the fixed name; the status still reports what the user
    // uploaded, because that is the only name they recognise.
    expect(path.basename(firmwarePath)).toBe('uploaded-firmware.bin');
    const status = service.getStatus();
    expect(status.matchedFile).toBe('firmware.bin');
    expect(status.message).toMatch(/not verified/i);
  });
});

describe('FirmwareUpdateService — verifying an uploaded flash (#5249)', () => {
  let service: FirmwareUpdateService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new FirmwareUpdateService();
    service.stageUploadedFirmware(BIN, 'firmware.bin');
    service.startPreflight({
      currentVersion: '2.7.20',
      targetVersion: 'firmware.bin',
      targetRelease: null,
      gatewayIp: '192.168.1.50',
      hwModel: 43,
      useStagedUpload: true,
    });
  });

  afterEach(() => {
    service.clearStagedUpload();
  });

  it('reports success with the running version instead of comparing to a filename', () => {
    // The release path compares the reported version against targetVersion.
    // Here targetVersion is "firmware.bin", so that comparison would fail on
    // every successful flash.
    service.verifyUpdate('2.7.21.deadbee', 'firmware.bin');

    const status = service.getStatus();
    expect(status.state).toBe('success');
    expect(status.message).toContain('2.7.21.deadbee');
    expect(status.message).toMatch(/not verified/i);
  });

  it('still errors when the node reports no version at all', () => {
    service.verifyUpdate('', 'firmware.bin');

    const status = service.getStatus();
    expect(status.state).toBe('error');
  });
});
