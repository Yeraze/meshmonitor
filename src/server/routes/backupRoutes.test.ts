import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockBackupFileService = vi.hoisted(() => ({
  listBackups: vi.fn(),
  getBackup: vi.fn(),
  deleteBackup: vi.fn(),
  saveBackup: vi.fn(),
}));

const mockSystemBackupService = vi.hoisted(() => ({
  createBackup: vi.fn(),
  listBackups: vi.fn(),
  getBackupPath: vi.fn(),
  deleteBackup: vi.fn(),
}));

vi.mock('../services/backupFileService.js', () => ({
  backupFileService: mockBackupFileService,
}));

vi.mock('../services/systemBackupService.js', () => ({
  systemBackupService: mockSystemBackupService,
}));

vi.mock('../../services/database.js', () => ({
  default: {
    settings: {
      getSetting: vi.fn(),
      setSetting: vi.fn(),
    },
    auditLogAsync: vi.fn(),
  },
}));

vi.mock('../auth/authMiddleware.js', () => ({
  requirePermission: () => (req: any, _res: any, next: any) => {
    req.user = { id: 1, isAdmin: true };
    next();
  },
}));

import databaseService from '../../services/database.js';
import { backupRouter, systemBackupRouter } from './backupRoutes.js';

const app = express();
app.use(express.json());
app.use('/backup', backupRouter);
app.use('/system/backup', systemBackupRouter);

describe('backupRoutes - config backups', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET /backup/settings returns parsed settings', async () => {
    (databaseService.settings.getSetting as any)
      .mockResolvedValueOnce('true') // backup_enabled
      .mockResolvedValueOnce('14') // backup_maxBackups
      .mockResolvedValueOnce('05:30'); // backup_time

    const res = await request(app).get('/backup/settings');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true, maxBackups: 14, backupTime: '05:30' });
  });

  it('GET /backup/settings returns defaults when unset', async () => {
    (databaseService.settings.getSetting as any).mockResolvedValue(null);

    const res = await request(app).get('/backup/settings');

    expect(res.body).toEqual({ enabled: false, maxBackups: 7, backupTime: '02:00' });
  });

  it('POST /backup/settings validates maxBackups range', async () => {
    const res = await request(app)
      .post('/backup/settings')
      .send({ enabled: true, maxBackups: 0, backupTime: '02:00' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/maxBackups/);
  });

  it('POST /backup/settings validates backupTime format', async () => {
    const res = await request(app)
      .post('/backup/settings')
      .send({ enabled: true, maxBackups: 7, backupTime: 'bad' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/backupTime/);
  });

  it('POST /backup/settings saves valid settings', async () => {
    (databaseService.settings.setSetting as any).mockResolvedValue(undefined);

    const res = await request(app)
      .post('/backup/settings')
      .send({ enabled: true, maxBackups: 7, backupTime: '02:00' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(databaseService.settings.setSetting).toHaveBeenCalledWith('backup_enabled', 'true');
  });

  it('GET /backup/list returns backups', async () => {
    mockBackupFileService.listBackups.mockResolvedValue([{ filename: 'a.yaml' }]);

    const res = await request(app).get('/backup/list');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ filename: 'a.yaml' }]);
  });

  it('GET /backup/download rejects path traversal', async () => {
    const res = await request(app).get('/backup/download/..%2Fetc.yaml');
    expect(res.status).toBe(400);
  });

  it('GET /backup/download returns content for valid filename', async () => {
    mockBackupFileService.getBackup.mockResolvedValue('yaml-content');

    const res = await request(app).get('/backup/download/my_backup.yaml');

    expect(res.status).toBe(200);
    expect(res.text).toBe('yaml-content');
    expect(res.headers['content-disposition']).toContain('my_backup.yaml');
  });

  it('DELETE /backup/delete rejects invalid filename', async () => {
    const res = await request(app).delete('/backup/delete/bad.txt');
    expect(res.status).toBe(400);
  });

  it('DELETE /backup/delete removes valid backup', async () => {
    mockBackupFileService.deleteBackup.mockResolvedValue(undefined);

    const res = await request(app).delete('/backup/delete/my_backup.yaml');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockBackupFileService.deleteBackup).toHaveBeenCalledWith('my_backup.yaml');
  });
});

describe('backupRoutes - system backups', () => {
  beforeEach(() => vi.clearAllMocks());

  it('POST /system/backup creates a backup and audits', async () => {
    mockSystemBackupService.createBackup.mockResolvedValue('2026-01-01_120000');

    const res = await request(app).post('/system/backup').send({});

    expect(res.status).toBe(200);
    expect(res.body.dirname).toBe('2026-01-01_120000');
    expect(databaseService.auditLogAsync).toHaveBeenCalledWith(
      1, 'system_backup_created', 'system_backup', expect.any(String), expect.anything()
    );
  });

  it('GET /system/backup/list returns backups', async () => {
    mockSystemBackupService.listBackups.mockResolvedValue([{ dirname: 'd1' }]);

    const res = await request(app).get('/system/backup/list');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ dirname: 'd1' }]);
  });

  it('GET /system/backup/download rejects invalid dirname', async () => {
    const res = await request(app).get('/system/backup/download/not-a-date');
    expect(res.status).toBe(400);
  });

  it('GET /system/backup/download returns 404 when the backup is missing (async fs check, #3524)', async () => {
    // Points at a path that doesn't exist → the new async fsp.access rejects → 404.
    mockSystemBackupService.getBackupPath.mockReturnValue(
      join(tmpdir(), 'mm-3524-absent', '2099-01-01_000000')
    );
    const res = await request(app).get('/system/backup/download/2099-01-01_000000');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Backup not found');
  });

  it('GET /system/backup/download streams a tar.gz for an existing backup (#3524 happy path)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mm-3524-backup-'));
    await writeFile(join(dir, 'meshmonitor.db'), 'fake-sqlite-bytes');
    mockSystemBackupService.getBackupPath.mockReturnValue(dir);
    try {
      const res = await request(app).get('/system/backup/download/2099-01-01_000000');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('gzip');
      expect(res.headers['content-disposition']).toContain('2099-01-01_000000.tar.gz');
      expect(databaseService.auditLogAsync).toHaveBeenCalledWith(
        1, 'system_backup_downloaded', 'system_backup', expect.any(String), expect.anything()
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('DELETE /system/backup/delete rejects invalid dirname', async () => {
    const res = await request(app).delete('/system/backup/delete/not-a-date');
    expect(res.status).toBe(400);
  });

  it('DELETE /system/backup/delete removes valid backup and audits', async () => {
    mockSystemBackupService.deleteBackup.mockResolvedValue(undefined);

    const res = await request(app).delete('/system/backup/delete/2026-01-01_120000');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockSystemBackupService.deleteBackup).toHaveBeenCalledWith('2026-01-01_120000');
    expect(databaseService.auditLogAsync).toHaveBeenCalledWith(
      1, 'system_backup_deleted', 'system_backup', expect.any(String), expect.anything()
    );
  });

  it('GET /system/backup/settings returns defaults', async () => {
    (databaseService.settings.getSetting as any).mockResolvedValue(null);

    const res = await request(app).get('/system/backup/settings');

    expect(res.body).toEqual({ enabled: false, maxBackups: 7, backupTime: '03:00' });
  });

  it('POST /system/backup/settings saves valid settings', async () => {
    (databaseService.settings.setSetting as any).mockResolvedValue(undefined);

    const res = await request(app)
      .post('/system/backup/settings')
      .send({ enabled: true, maxBackups: 5, backupTime: '03:15' });

    expect(res.status).toBe(200);
    expect(databaseService.settings.setSetting).toHaveBeenCalledWith('system_backup_enabled', 'true');
  });
});
