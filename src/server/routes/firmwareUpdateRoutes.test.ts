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
  mockFetchReleases,
  mockSetChannel,
  mockSetCustomUrl,
  mockStartPreflight,
  mockCancelUpdate,
  mockListBackups,
  mockRestoreBackup,
  mockExecuteBackup,
  mockExecuteDownload,
  mockExecuteExtract,
  mockExecuteFlash,
  mockVerifyUpdate,
  mockGetTempDir,
} = vi.hoisted(() => ({
  mockGetStatus: vi.fn(),
  mockGetChannel: vi.fn(),
  mockGetCustomUrl: vi.fn(),
  mockGetLastFetchTime: vi.fn(),
  mockGetCachedReleases: vi.fn(),
  mockFilterByChannel: vi.fn(),
  mockFetchReleases: vi.fn(),
  mockSetChannel: vi.fn(),
  mockSetCustomUrl: vi.fn(),
  mockStartPreflight: vi.fn(),
  mockCancelUpdate: vi.fn(),
  mockListBackups: vi.fn(),
  mockRestoreBackup: vi.fn(),
  mockExecuteBackup: vi.fn(),
  mockExecuteDownload: vi.fn(),
  mockExecuteExtract: vi.fn(),
  mockExecuteFlash: vi.fn(),
  mockVerifyUpdate: vi.fn(),
  mockGetTempDir: vi.fn(),
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
    getSettingAsync: vi.fn().mockResolvedValue(null),
    setSettingAsync: vi.fn().mockResolvedValue(undefined),
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
    fetchReleases: mockFetchReleases,
    setChannel: mockSetChannel,
    setCustomUrl: mockSetCustomUrl,
    startPreflight: mockStartPreflight,
    cancelUpdate: mockCancelUpdate,
    listBackups: mockListBackups,
    restoreBackup: mockRestoreBackup,
    executeBackup: mockExecuteBackup,
    executeDownload: mockExecuteDownload,
    executeExtract: mockExecuteExtract,
    executeFlash: mockExecuteFlash,
    verifyUpdate: mockVerifyUpdate,
    getTempDir: mockGetTempDir,
  },
  FirmwareChannel: {},
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
      mockGetCachedReleases.mockReturnValue(releases);
      mockFilterByChannel.mockReturnValue(filtered);

      const res = await request(app).get('/api/firmware/releases');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.releases).toEqual(filtered);
      expect(res.body.channel).toBe('stable');
      expect(mockFilterByChannel).toHaveBeenCalledWith(releases, 'stable');
    });
  });

  describe('POST /api/firmware/check', () => {
    it('should trigger a fetch and return updated releases', async () => {
      const releases = [
        { tagName: 'v2.5.0', version: '2.5.0', prerelease: false, publishedAt: '2024-01-01', htmlUrl: '', assets: [] },
      ];
      mockFetchReleases.mockResolvedValue(releases);
      mockGetChannel.mockResolvedValue('stable');
      mockFilterByChannel.mockReturnValue(releases);

      const res = await request(app).post('/api/firmware/check');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.releases).toEqual(releases);
      expect(mockFetchReleases).toHaveBeenCalled();
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
      mockGetCachedReleases.mockReturnValue(releases);
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

    it('should return 400 when target release not found', async () => {
      mockGetCachedReleases.mockReturnValue([]);

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
      mockExecuteBackup.mockResolvedValue('/backups/config-test.yaml');

      const res = await request(app)
        .post('/api/firmware/update/confirm')
        .send({ gatewayIp: '192.168.1.100', nodeId: 'node123' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockExecuteBackup).toHaveBeenCalledWith('192.168.1.100', 'node123');
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
});
