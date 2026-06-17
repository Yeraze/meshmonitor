import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const mockManager = vi.hoisted(() => ({
  getDeviceConfig: vi.fn(),
  getLocalNodeInfo: vi.fn(),
  rebootDevice: vi.fn(),
  purgeNodeDb: vi.fn(),
}));

vi.mock('../utils/resolveSourceManager.js', () => ({
  resolveSourceManager: vi.fn().mockReturnValue(mockManager),
}));

const mockDeviceBackupService = vi.hoisted(() => ({
  generateBackup: vi.fn(),
}));
vi.mock('../services/deviceBackupService.js', () => ({
  deviceBackupService: mockDeviceBackupService,
}));

const mockBackupFileService = vi.hoisted(() => ({
  saveBackup: vi.fn(),
}));
vi.mock('../services/backupFileService.js', () => ({
  backupFileService: mockBackupFileService,
}));

const mockDb = vi.hoisted(() => ({
  purgeAllNodesAsync: vi.fn(),
}));
vi.mock('../../services/database.js', () => ({
  default: mockDb,
}));

vi.mock('../auth/authMiddleware.js', () => ({
  requirePermission: () => (req: any, _res: any, next: any) => { req.user = { id: 1, isAdmin: true }; next(); },
}));

import deviceRoutes from './deviceRoutes.js';

const app = express();
app.use(express.json());
app.use('/', deviceRoutes);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /device-config', () => {
  it('returns the device config when available', async () => {
    mockManager.getDeviceConfig.mockResolvedValue({ region: 'US' });
    const res = await request(app).get('/device-config?sourceId=src-1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ region: 'US' });
  });

  it('returns 503 when no config is available', async () => {
    mockManager.getDeviceConfig.mockResolvedValue(null);
    const res = await request(app).get('/device-config');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Unable to retrieve device configuration');
  });

  it('returns 500 on error', async () => {
    mockManager.getDeviceConfig.mockRejectedValue(new Error('boom'));
    const res = await request(app).get('/device-config');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch device configuration');
  });
});

describe('GET /device/backup', () => {
  it('downloads YAML without saving by default', async () => {
    mockDeviceBackupService.generateBackup.mockResolvedValue('yaml-content');
    mockManager.getLocalNodeInfo.mockReturnValue({ nodeId: '!abcd1234' });
    const res = await request(app).get('/device/backup');
    expect(res.status).toBe(200);
    expect(res.text).toBe('yaml-content');
    expect(res.headers['content-disposition']).toContain('abcd1234');
    expect(mockBackupFileService.saveBackup).not.toHaveBeenCalled();
  });

  it('saves to disk when save=true', async () => {
    mockDeviceBackupService.generateBackup.mockResolvedValue('yaml-content');
    mockManager.getLocalNodeInfo.mockReturnValue({ nodeId: '!abcd1234' });
    mockBackupFileService.saveBackup.mockResolvedValue('saved.yaml');
    const res = await request(app).get('/device/backup?save=true');
    expect(res.status).toBe(200);
    expect(mockBackupFileService.saveBackup).toHaveBeenCalledWith('yaml-content', 'manual', '!abcd1234');
    expect(res.headers['content-disposition']).toContain('saved.yaml');
  });

  it('returns 500 on backup failure', async () => {
    mockDeviceBackupService.generateBackup.mockRejectedValue(new Error('fail'));
    const res = await request(app).get('/device/backup');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to generate device backup');
  });
});

describe('POST /device/reboot', () => {
  it('reboots with provided seconds', async () => {
    mockManager.rebootDevice.mockResolvedValue(undefined);
    const res = await request(app).post('/device/reboot').send({ seconds: 30 });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockManager.rebootDevice).toHaveBeenCalledWith(30);
  });

  it('defaults to 10 seconds', async () => {
    mockManager.rebootDevice.mockResolvedValue(undefined);
    const res = await request(app).post('/device/reboot').send({});
    expect(res.status).toBe(200);
    expect(mockManager.rebootDevice).toHaveBeenCalledWith(10);
  });

  it('returns 500 on failure', async () => {
    mockManager.rebootDevice.mockRejectedValue(new Error('fail'));
    const res = await request(app).post('/device/reboot').send({});
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to reboot device');
  });
});

describe('POST /device/purge-nodedb', () => {
  it('purges device and local db scoped to source', async () => {
    mockManager.purgeNodeDb.mockResolvedValue(undefined);
    mockDb.purgeAllNodesAsync.mockResolvedValue(undefined);
    const res = await request(app).post('/device/purge-nodedb').send({ sourceId: 'src-1' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockManager.purgeNodeDb).toHaveBeenCalledWith(0);
    expect(mockDb.purgeAllNodesAsync).toHaveBeenCalledWith('src-1');
  });

  it('returns 500 on failure', async () => {
    mockManager.purgeNodeDb.mockRejectedValue(new Error('fail'));
    const res = await request(app).post('/device/purge-nodedb').send({});
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to purge node database');
  });
});
