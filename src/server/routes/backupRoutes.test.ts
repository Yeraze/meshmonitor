import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockSystemBackupService = vi.hoisted(() => ({
  createBackup: vi.fn(),
  listBackups: vi.fn(),
  getBackupPath: vi.fn(),
  deleteBackup: vi.fn(),
}));

// The device-config backup routes (settings, list, download, delete, restore)
// are covered with the real auth middleware in
// backupRoutes.deviceBackup.permissions.test.ts.

vi.mock('../services/systemBackupService.js', () => ({
  systemBackupService: mockSystemBackupService,
  SystemBackupInProgressError: class SystemBackupInProgressError extends Error {},
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

vi.mock('../auth/authMiddleware.js', () => {
  const asAdmin = () => (req: any, _res: any, next: any) => {
    req.user = { id: 1, isAdmin: true };
    next();
  };
  // The system-backup download is admin-only; who gets through the real
  // middleware is covered in backupRoutes.systemBackup.permissions.test.ts.
  return { requirePermission: asAdmin, requireAdmin: asAdmin };
});

import databaseService from '../../services/database.js';
import { backupRouter, systemBackupRouter } from './backupRoutes.js';

const app = express();
app.use(express.json());
app.use('/backup', backupRouter);
app.use('/system/backup', systemBackupRouter);

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
