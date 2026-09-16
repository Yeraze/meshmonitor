import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// Use vi.hoisted() so mock functions are available before vi.mock hoisting
const {
  mockGetStatus,
  mockGetChannel,
  mockGetCustomUrl,
  mockGetLastFetchTime,
  mockGetCachedReleases,
  mockFilterByChannel,
  mockGetReleasesForChannel,
  mockFindReleaseByVersion,
  mockFetchReleases,
  mockSetChannel,
  mockSetCustomUrl,
  mockStartPreflight,
  mockCancelUpdate,
  mockListBackups,
  mockRestoreBackup,
  mockDisconnectFromNode,
  mockExecuteBackup,
  mockExecuteDownload,
  mockExecuteExtract,
  mockExecuteFlash,
  mockVerifyUpdate,
  mockGetTempDir,
  mockRetryFlash,
  mockIsStepRunning,
  mockHasFlashIncompleteMarker,
  mockClearFlashIncompleteMarker,
  mockIsLocalNodeBridged,
  mockStageUploadedFirmware,
  mockGetStagedUpload,
  mockClearStagedUpload,
} = vi.hoisted(() => ({
  mockGetStatus: vi.fn(),
  mockGetChannel: vi.fn(),
  mockGetCustomUrl: vi.fn(),
  mockGetLastFetchTime: vi.fn(),
  mockGetCachedReleases: vi.fn(),
  mockFilterByChannel: vi.fn(),
  mockGetReleasesForChannel: vi.fn(),
  mockFindReleaseByVersion: vi.fn(),
  mockFetchReleases: vi.fn(),
  mockSetChannel: vi.fn(),
  mockSetCustomUrl: vi.fn(),
  mockStartPreflight: vi.fn(),
  mockCancelUpdate: vi.fn(),
  mockListBackups: vi.fn(),
  mockRestoreBackup: vi.fn(),
  mockDisconnectFromNode: vi.fn(),
  mockExecuteBackup: vi.fn(),
  mockExecuteDownload: vi.fn(),
  mockExecuteExtract: vi.fn(),
  mockExecuteFlash: vi.fn(),
  mockVerifyUpdate: vi.fn(),
  mockGetTempDir: vi.fn(),
  mockRetryFlash: vi.fn(),
  mockIsStepRunning: vi.fn().mockReturnValue(false),
  mockHasFlashIncompleteMarker: vi.fn().mockReturnValue(false),
  mockClearFlashIncompleteMarker: vi.fn().mockReturnValue(0),
  mockIsLocalNodeBridged: vi.fn().mockReturnValue(false),
  mockStageUploadedFirmware: vi.fn(),
  mockGetStagedUpload: vi.fn().mockReturnValue(null),
  mockClearStagedUpload: vi.fn(),
}));

// Mock auth middleware to inject admin user
vi.mock('../auth/authMiddleware.js', () => ({
  requireAuth: () => (_req: any, _res: any, next: any) => {
    _req.user = { id: 1, username: 'admin', isAdmin: true };
    next();
  },
  requireAdmin: () => (_req: any, _res: any, next: any) => {
    _req.user = { id: 1, username: 'admin', isAdmin: true };
    next();
  },
  optionalAuth: () => (_req: any, _res: any, next: any) => next(),
}));

// Mock database (needed by authMiddleware even though we mock it)
vi.mock('../../services/database.js', () => ({
  default: {
    findUserByIdAsync: vi.fn().mockResolvedValue({ id: 1, username: 'admin', isAdmin: true }),
    findUserByUsernameAsync: vi.fn().mockResolvedValue(null),
    checkPermissionAsync: vi.fn().mockResolvedValue(true),
    getUserPermissionSetAsync: vi.fn().mockResolvedValue({ resources: {}, isAdmin: true }),
    auditLog: vi.fn(),
    settings: {
      getSetting: vi.fn().mockResolvedValue(null),
      setSetting: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

// Mock the firmware update service
vi.mock('../services/firmwareUpdateService.js', () => ({
  firmwareUpdateService: {
    getStatus: mockGetStatus,
    getChannel: mockGetChannel,
    getCustomUrl: mockGetCustomUrl,
    getLastFetchTime: mockGetLastFetchTime,
    getCachedReleases: mockGetCachedReleases,
    filterByChannel: mockFilterByChannel,
    getReleasesForChannel: mockGetReleasesForChannel,
    findReleaseByVersion: mockFindReleaseByVersion,
    fetchReleases: mockFetchReleases,
    setChannel: mockSetChannel,
    setCustomUrl: mockSetCustomUrl,
    startPreflight: mockStartPreflight,
    cancelUpdate: mockCancelUpdate,
    listBackups: mockListBackups,
    restoreBackup: mockRestoreBackup,
    disconnectFromNode: mockDisconnectFromNode,
    executeBackup: mockExecuteBackup,
    executeDownload: mockExecuteDownload,
    executeExtract: mockExecuteExtract,
    executeFlash: mockExecuteFlash,
    verifyUpdate: mockVerifyUpdate,
    getTempDir: mockGetTempDir,
    retryFlash: (...args: unknown[]) => mockRetryFlash(...args),
    isStepRunning: mockIsStepRunning,
    hasFlashIncompleteMarker: mockHasFlashIncompleteMarker,
    clearFlashIncompleteMarker: mockClearFlashIncompleteMarker,
    stageUploadedFirmware: mockStageUploadedFirmware,
    getStagedUpload: mockGetStagedUpload,
    clearStagedUpload: mockClearStagedUpload,
  },
  FirmwareChannel: {},
}));

// Mock meshtasticManager (routes use fallbackManager for post-flash
// actual-version read + the bridged-node OTA guard, #3962 Phase 4.2a WP4).
vi.mock('../meshtasticManager.js', () => ({
  fallbackManager: {
    getLocalNodeInfo: vi.fn().mockReturnValue(null),
    isLocalNodeBridged: mockIsLocalNodeBridged,
  },
}));

// No primary meshtastic_tcp source registered in these route-only unit
// tests — resolveManager falls through to fallbackManager above, same as
// the retired Proxy alias always did in this unmocked-registry environment.
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {},
}));

vi.mock('../sourceManagerTypes.js', () => ({
  getPrimaryMeshtasticManager: () => undefined,
}));

// Mock environment config — issue #2981 guard reads meshtasticNodeIpProvided
// to decide whether the gatewayIp argument was explicitly configured by the
// operator. Tests pass an explicit IP, so flag it as provided.
vi.mock('../config/environment.js', () => ({
  getEnvironmentConfig: () => ({
    meshtasticNodeIp: '192.168.1.100',
    meshtasticNodeIpProvided: true,
    meshtasticTcpPort: 4403,
  }),
}));

// Mock logger
vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import firmwareUpdateRoutes from './firmwareUpdateRoutes.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/firmware', firmwareUpdateRoutes);
  return app;
}

describe('firmwareUpdateRoutes', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks resets call history but not implementations, so restore the
    // default (not bridged) — the bridged-node test overrides it to true.
    mockIsLocalNodeBridged.mockReturnValue(false);
    app = createApp();
  });

  describe('GET /api/firmware/status', () => {
    it('should return 200 with status, channel, customUrl, and lastChecked', async () => {
      const mockStatus = {
        state: 'idle',
        step: null,
        message: '',
        logs: [],
      };
      mockGetStatus.mockReturnValue(mockStatus);
      mockGetChannel.mockResolvedValue('stable');
      mockGetCustomUrl.mockResolvedValue(null);
      mockGetLastFetchTime.mockReturnValue(1700000000000);

      const res = await request(app).get('/api/firmware/status');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.status).toEqual(mockStatus);
      expect(res.body.channel).toBe('stable');
      expect(res.body.customUrl).toBeNull();
      expect(res.body.lastChecked).toBe(1700000000000);
    });
  });

  describe('GET /api/firmware/releases', () => {
    it('should return filtered releases for current channel', async () => {
      const releases = [
        { tagName: 'v2.5.0', version: '2.5.0', prerelease: false, publishedAt: '2024-01-01', htmlUrl: '', assets: [] },
        { tagName: 'v2.6.0-alpha', version: '2.6.0-alpha', prerelease: true, publishedAt: '2024-02-01', htmlUrl: '', assets: [] },
      ];
      const filtered = [releases[0]];
      mockGetChannel.mockResolvedValue('stable');
      mockGetReleasesForChannel.mockResolvedValue(filtered);

      const res = await request(app).get('/api/firmware/releases');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.releases).toEqual(filtered);
      expect(res.body.channel).toBe('stable');
      expect(mockGetReleasesForChannel).toHaveBeenCalledWith('stable');
    });
  });

  describe('POST /api/firmware/check', () => {
    it('should trigger a fetch and return updated releases', async () => {
      const releases = [
        { tagName: 'v2.5.0', version: '2.5.0', prerelease: false, publishedAt: '2024-01-01', htmlUrl: '', assets: [] },
      ];
      mockFetchReleases.mockResolvedValue(releases);
      mockGetChannel.mockResolvedValue('stable');
      mockGetReleasesForChannel.mockResolvedValue(releases);

      const res = await request(app).post('/api/firmware/check');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.releases).toEqual(releases);
      expect(mockFetchReleases).toHaveBeenCalled();
      expect(mockGetReleasesForChannel).toHaveBeenCalledWith('stable');
    });
  });

  describe('POST /api/firmware/channel', () => {
    it('should set channel to stable', async () => {
      mockSetChannel.mockResolvedValue(undefined);

      const res = await request(app)
        .post('/api/firmware/channel')
        .send({ channel: 'stable' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockSetChannel).toHaveBeenCalledWith('stable');
    });

    it('should set channel to alpha', async () => {
      mockSetChannel.mockResolvedValue(undefined);

      const res = await request(app)
        .post('/api/firmware/channel')
        .send({ channel: 'alpha' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockSetChannel).toHaveBeenCalledWith('alpha');
    });

    it('should set channel to custom with customUrl', async () => {
      mockSetChannel.mockResolvedValue(undefined);
      mockSetCustomUrl.mockResolvedValue(undefined);

      const res = await request(app)
        .post('/api/firmware/channel')
        .send({ channel: 'custom', customUrl: 'https://example.com/releases' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockSetChannel).toHaveBeenCalledWith('custom');
      expect(mockSetCustomUrl).toHaveBeenCalledWith('https://example.com/releases');
    });

    it('should return 400 for invalid channel', async () => {
      const res = await request(app)
        .post('/api/firmware/channel')
        .send({ channel: 'invalid' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/invalid/i);
    });

    it('should return 400 when custom channel has no customUrl', async () => {
      const res = await request(app)
        .post('/api/firmware/channel')
        .send({ channel: 'custom' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/customUrl/i);
    });
  });

  describe('POST /api/firmware/update', () => {
    it('should start preflight with valid parameters', async () => {
      const releases = [
        {
          tagName: 'v2.5.0',
          version: '2.5.0',
          prerelease: false,
          publishedAt: '2024-01-01',
          htmlUrl: '',
          assets: [],
        },
      ];
      mockFindReleaseByVersion.mockReturnValue(releases[0]);
      mockStartPreflight.mockReturnValue(undefined);
      mockGetStatus.mockReturnValue({
        state: 'awaiting-confirm',
        step: 'preflight',
        message: 'Preflight complete',
        logs: [],
      });

      const res = await request(app)
        .post('/api/firmware/update')
        .send({
          targetVersion: '2.5.0',
          gatewayIp: '192.168.1.100',
          hwModel: 44,
          currentVersion: '2.4.0',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockStartPreflight).toHaveBeenCalled();
    });

    it('should return 400 when missing required fields', async () => {
      const res = await request(app)
        .post('/api/firmware/update')
        .send({ targetVersion: '2.5.0' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('should return 400 (without starting preflight) when the node is bridged', async () => {
      mockIsLocalNodeBridged.mockReturnValue(true);
      const releases = [
        {
          tagName: 'v2.5.0',
          version: '2.5.0',
          prerelease: false,
          publishedAt: '2024-01-01',
          htmlUrl: '',
          assets: [],
        },
      ];
      mockGetCachedReleases.mockReturnValue(releases);

      const res = await request(app)
        .post('/api/firmware/update')
        .send({
          targetVersion: '2.5.0',
          gatewayIp: '192.168.1.100',
          hwModel: 44,
          currentVersion: '2.4.0',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/bridged/i);
      expect(mockStartPreflight).not.toHaveBeenCalled();
    });

    it('should return 400 when target release not found', async () => {
      mockFindReleaseByVersion.mockReturnValue(null);

      const res = await request(app)
        .post('/api/firmware/update')
        .send({
          targetVersion: '2.5.0',
          gatewayIp: '192.168.1.100',
          hwModel: 44,
          currentVersion: '2.4.0',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/not found/i);
    });
  });

  // Issue #5249 — flashing a .bin the user uploaded from disk.
  describe('POST /api/firmware/upload', () => {
    it('stages the uploaded bytes and echoes the filename and size', async () => {
      mockStageUploadedFirmware.mockReturnValue({ originalName: 'firmware.bin', size: 4 });

      const res = await request(app)
        .post('/api/firmware/upload')
        .set('Content-Type', 'application/octet-stream')
        .set('X-Firmware-Filename', 'firmware.bin')
        .send(Buffer.from([1, 2, 3, 4]));

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.stagedUpload).toEqual({ originalName: 'firmware.bin', size: 4 });
      const [buf, name] = mockStageUploadedFirmware.mock.calls[0];
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(name).toBe('firmware.bin');
    });

    it('defaults the filename when the header is absent', async () => {
      mockStageUploadedFirmware.mockReturnValue({ originalName: 'firmware.bin', size: 2 });

      const res = await request(app)
        .post('/api/firmware/upload')
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from([1, 2]));

      expect(res.status).toBe(200);
      expect(mockStageUploadedFirmware.mock.calls[0][1]).toBe('firmware.bin');
    });

    it('rejects a non-.bin filename', async () => {
      const res = await request(app)
        .post('/api/firmware/upload')
        .set('Content-Type', 'application/octet-stream')
        .set('X-Firmware-Filename', 'notfirmware.zip')
        .send(Buffer.from([1, 2]));

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/\.bin/);
      expect(mockStageUploadedFirmware).not.toHaveBeenCalled();
    });

    it('rejects an empty body', async () => {
      const res = await request(app)
        .post('/api/firmware/upload')
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.alloc(0));

      expect(res.status).toBe(400);
      expect(mockStageUploadedFirmware).not.toHaveBeenCalled();
    });

    it('surfaces a staging failure as 400 rather than 500', async () => {
      mockStageUploadedFirmware.mockImplementation(() => {
        throw new Error('Cannot stage firmware while an update is in progress');
      });

      const res = await request(app)
        .post('/api/firmware/upload')
        .set('Content-Type', 'application/octet-stream')
        .set('X-Firmware-Filename', 'firmware.bin')
        .send(Buffer.from([1]));

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/update is in progress/);
    });
  });

  describe('DELETE /api/firmware/upload', () => {
    it('clears the staged upload', async () => {
      const res = await request(app).delete('/api/firmware/upload');
      expect(res.status).toBe(200);
      expect(mockClearStagedUpload).toHaveBeenCalled();
    });
  });

  describe('POST /api/firmware/update with useStagedUpload (#5249)', () => {
    it('starts preflight against the staged upload without a targetVersion', async () => {
      mockGetStagedUpload.mockReturnValue({ originalName: 'firmware.bin', size: 4096 });
      mockGetStatus.mockReturnValue({ state: 'awaiting-confirm', step: 'preflight', message: '', logs: [] });

      const res = await request(app)
        .post('/api/firmware/update')
        .send({
          useStagedUpload: true,
          gatewayIp: '192.168.1.100',
          hwModel: 44,
          currentVersion: '2.7.20',
        });

      expect(res.status).toBe(200);
      // No release lookup happens — an upload has no release to find.
      expect(mockFindReleaseByVersion).not.toHaveBeenCalled();
      expect(mockStartPreflight).toHaveBeenCalledWith(
        expect.objectContaining({
          useStagedUpload: true,
          targetRelease: null,
          // The filename stands in for a version so the wizard has something
          // to display.
          targetVersion: 'firmware.bin',
        }),
      );
    });

    it('refuses when nothing is staged', async () => {
      mockGetStagedUpload.mockReturnValue(null);

      const res = await request(app)
        .post('/api/firmware/update')
        .send({
          useStagedUpload: true,
          gatewayIp: '192.168.1.100',
          hwModel: 44,
          currentVersion: '2.7.20',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/No uploaded firmware is staged/);
      expect(mockStartPreflight).not.toHaveBeenCalled();
    });

    it('still requires targetVersion on the normal release path', async () => {
      const res = await request(app)
        .post('/api/firmware/update')
        .send({ gatewayIp: '192.168.1.100', hwModel: 44, currentVersion: '2.7.20' });

      expect(res.status).toBe(400);
      expect(mockStartPreflight).not.toHaveBeenCalled();
    });
  });

  // Issue #5011 — the custom URL is a real install target now.
  describe('POST /api/firmware/channel — custom URL validation (#5011)', () => {
    it('rewrites a GitHub blob URL and reports that it did', async () => {
      const res = await request(app)
        .post('/api/firmware/channel')
        .send({
          channel: 'custom',
          customUrl: 'https://github.com/o/r/blob/main/firmware.bin',
        });

      expect(res.status).toBe(200);
      expect(res.body.rewritten).toBe(true);
      expect(res.body.customUrl).toBe('https://raw.githubusercontent.com/o/r/main/firmware.bin');
      // The rewritten URL is what gets stored, not what was typed.
      expect(mockSetCustomUrl).toHaveBeenCalledWith('https://raw.githubusercontent.com/o/r/main/firmware.bin');
    });

    it('stores a raw URL unchanged and says it did not rewrite', async () => {
      const url = 'https://raw.githubusercontent.com/o/r/main/firmware.bin';
      const res = await request(app).post('/api/firmware/channel').send({ channel: 'custom', customUrl: url });

      expect(res.status).toBe(200);
      expect(res.body.rewritten).toBe(false);
      expect(mockSetCustomUrl).toHaveBeenCalledWith(url);
    });

    it('rejects a malformed URL instead of storing it silently', async () => {
      const res = await request(app)
        .post('/api/firmware/channel')
        .send({ channel: 'custom', customUrl: 'not a url' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/not a valid URL/i);
      expect(mockSetCustomUrl).not.toHaveBeenCalled();
    });

    it('rejects a non-http scheme', async () => {
      const res = await request(app)
        .post('/api/firmware/channel')
        .send({ channel: 'custom', customUrl: 'file:///etc/passwd' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/scheme/i);
      expect(mockSetCustomUrl).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/firmware/update with useCustomUrl (#5011)', () => {
    it('starts preflight against the saved URL without a targetVersion', async () => {
      mockGetCustomUrl.mockResolvedValue('https://raw.githubusercontent.com/o/r/main/firmware.bin');
      mockGetStatus.mockReturnValue({ state: 'awaiting-confirm', step: 'preflight', message: '', logs: [] });

      const res = await request(app)
        .post('/api/firmware/update')
        .send({
          useCustomUrl: true,
          gatewayIp: '192.168.1.100',
          hwModel: 44,
          currentVersion: '2.7.20',
        });

      expect(res.status).toBe(200);
      // No release lookup — a URL has no release behind it.
      expect(mockFindReleaseByVersion).not.toHaveBeenCalled();
      expect(mockStartPreflight).toHaveBeenCalledWith(
        expect.objectContaining({
          targetRelease: null,
          customUrl: 'https://raw.githubusercontent.com/o/r/main/firmware.bin',
        }),
      );
    });

    it('resolves a stored blob URL to raw before preflight', async () => {
      // Belt and braces with the save-time rewrite: a URL stored by an older
      // build never reaches fetch in its page form.
      mockGetCustomUrl.mockResolvedValue('https://github.com/o/r/blob/main/firmware.bin');
      mockGetStatus.mockReturnValue({ state: 'awaiting-confirm', step: 'preflight', message: '', logs: [] });

      await request(app)
        .post('/api/firmware/update')
        .send({ useCustomUrl: true, gatewayIp: '192.168.1.100', hwModel: 44, currentVersion: '2.7.20' });

      expect(mockStartPreflight).toHaveBeenCalledWith(
        expect.objectContaining({
          customUrl: 'https://raw.githubusercontent.com/o/r/main/firmware.bin',
        }),
      );
    });

    it('refuses when no URL has been saved', async () => {
      mockGetCustomUrl.mockResolvedValue(null);

      const res = await request(app)
        .post('/api/firmware/update')
        .send({ useCustomUrl: true, gatewayIp: '192.168.1.100', hwModel: 44, currentVersion: '2.7.20' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/No custom firmware URL is saved/i);
      expect(mockStartPreflight).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/firmware/update/confirm', () => {
    it('should advance from preflight to backup step', async () => {
      mockGetStatus.mockReturnValue({
        state: 'awaiting-confirm',
        step: 'preflight',
        message: 'Preflight complete',
        logs: [],
        preflightInfo: {
          currentVersion: '2.4.0',
          targetVersion: '2.5.0',
          gatewayIp: '192.168.1.100',
          hwModel: 'T-Beam',
          boardName: 'tbeam',
          platform: 'esp32',
        },
      });
      mockDisconnectFromNode.mockResolvedValue(undefined);
      mockExecuteBackup.mockResolvedValue('/backups/config-test.yaml');

      const res = await request(app)
        .post('/api/firmware/update/confirm')
        .send({ gatewayIp: '192.168.1.100', nodeId: 'node123' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      // The confirm route fires the step async (F1) — wait for the IIFE to advance.
      await new Promise((r) => setTimeout(r, 10));
      expect(mockDisconnectFromNode).toHaveBeenCalled();
      expect(mockExecuteBackup).toHaveBeenCalledWith('192.168.1.100', 'node123');
    });

    it('should return 409 when nodeId has a half-flash recovery marker', async () => {
      mockGetStatus.mockReturnValue({
        state: 'awaiting-confirm',
        step: 'preflight',
        message: 'Preflight complete',
        logs: [],
      });
      mockHasFlashIncompleteMarker.mockReturnValueOnce(true);

      const res = await request(app)
        .post('/api/firmware/update/confirm')
        .send({ gatewayIp: '192.168.1.100', nodeId: 'node123' });

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/half-flashed/i);
      expect(mockDisconnectFromNode).not.toHaveBeenCalled();
    });

    it('should return 409 when a step is already running', async () => {
      mockGetStatus.mockReturnValue({
        state: 'awaiting-confirm',
        step: 'preflight',
        message: 'Preflight complete',
        logs: [],
      });
      mockIsStepRunning.mockReturnValueOnce(true);

      const res = await request(app)
        .post('/api/firmware/update/confirm')
        .send({ gatewayIp: '192.168.1.100', nodeId: 'node123' });

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/already running/i);
      expect(mockDisconnectFromNode).not.toHaveBeenCalled();
      expect(mockExecuteBackup).not.toHaveBeenCalled();
    });

    it('should return 400 when no update is in progress', async () => {
      mockGetStatus.mockReturnValue({
        state: 'idle',
        step: null,
        message: '',
        logs: [],
      });

      const res = await request(app)
        .post('/api/firmware/update/confirm')
        .send({ gatewayIp: '192.168.1.100', nodeId: 'node123' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  describe('POST /api/firmware/update/cancel', () => {
    it('should call cancelUpdate and return 200', async () => {
      mockCancelUpdate.mockReturnValue(undefined);

      const res = await request(app).post('/api/firmware/update/cancel');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockCancelUpdate).toHaveBeenCalled();
    });
  });

  describe('GET /api/firmware/backups', () => {
    it('should return backup list', async () => {
      const backups = [
        { filename: 'config-node1-2024.yaml', path: '/backups/config-node1-2024.yaml', timestamp: 1700000000000, size: 1024 },
      ];
      mockListBackups.mockReturnValue(backups);

      const res = await request(app).get('/api/firmware/backups');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.backups).toEqual(backups);
    });
  });

  describe('POST /api/firmware/update/retry', () => {
    it('should call retryFlash and execute flash directly', async () => {
      mockRetryFlash.mockReturnValue(undefined);
      mockGetStatus.mockReturnValue({
        state: 'awaiting-confirm',
        step: 'flash',
        message: 'Ready to retry flash.',
        matchedFile: 'firmware-tbeam-2.5.0.bin',
        preflightInfo: {
          currentVersion: '2.4.0',
          targetVersion: '2.5.0',
          gatewayIp: '192.168.1.100',
          hwModel: 'T-Beam',
          boardName: 'tbeam',
          platform: 'esp32',
        },
      });
      mockGetTempDir.mockReturnValue('/tmp/firmware-test');
      mockExecuteFlash.mockResolvedValue(undefined);

      const res = await request(app).post('/api/firmware/update/retry');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockRetryFlash).toHaveBeenCalled();
      // executeFlash is fire-and-forget, wait a tick for it to be called
      await new Promise((r) => setTimeout(r, 10));
      expect(mockExecuteFlash).toHaveBeenCalledWith(
        '192.168.1.100',
        '/tmp/firmware-test/extracted/firmware-tbeam-2.5.0.bin'
      );
    });

    it('should return error if retryFlash throws', async () => {
      mockRetryFlash.mockImplementation(() => {
        throw new Error('Cannot retry');
      });

      const res = await request(app).post('/api/firmware/update/retry');
      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Cannot retry');
    });
  });

  describe('POST /api/firmware/restore', () => {
    it('should restore config and return 200', async () => {
      mockRestoreBackup.mockResolvedValue(undefined);

      const res = await request(app)
        .post('/api/firmware/restore')
        .send({ gatewayIp: '192.168.1.100', backupPath: '/backups/config-test.yaml' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockRestoreBackup).toHaveBeenCalledWith('192.168.1.100', '/backups/config-test.yaml');
    });

    it('should return 400 when missing required fields', async () => {
      const res = await request(app)
        .post('/api/firmware/restore')
        .send({ gatewayIp: '192.168.1.100' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('should return 500 when restore fails', async () => {
      mockRestoreBackup.mockRejectedValue(new Error('Backup file not found'));

      const res = await request(app)
        .post('/api/firmware/restore')
        .send({ gatewayIp: '192.168.1.100', backupPath: '/backups/missing.yaml' });

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/Backup file not found/);
    });
  });

  describe('DELETE /api/firmware/recovery-marker/:nodeId', () => {
    it('should clear markers and return count removed', async () => {
      mockClearFlashIncompleteMarker.mockReturnValueOnce(2);

      const res = await request(app).delete('/api/firmware/recovery-marker/!abcdef12');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.removed).toBe(2);
      expect(mockClearFlashIncompleteMarker).toHaveBeenCalledWith('!abcdef12');
    });
  });
});
