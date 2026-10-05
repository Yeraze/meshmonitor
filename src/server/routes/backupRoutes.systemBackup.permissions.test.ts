/**
 * Who may download a system backup.
 *
 * The archive is the whole database: password hashes, API token hashes, channel
 * decryption keys in the clear, and the encrypted PKI and Observer keys. The
 * download used to be gated on `configuration:read`, which an admin can grant
 * to any user, including the anonymous one. It is admin-only now.
 *
 * Real session, real auth middleware, real permission rows (route harness).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const backup = vi.hoisted(() => {
  class SystemBackupInProgressError extends Error {}
  return { dir: '', createBackup: vi.fn(), SystemBackupInProgressError };
});

vi.mock('../services/systemBackupService.js', () => ({
  systemBackupService: {
    getBackupPath: () => backup.dir,
    listBackups: vi.fn().mockResolvedValue([]),
    createBackup: backup.createBackup,
  },
  SystemBackupInProgressError: backup.SystemBackupInProgressError,
}));

import { systemBackupRouter } from './backupRoutes.js';

const DIRNAME = '2099-01-01_000000';

describe('GET /system/backup/download — admin only', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    backup.dir = await mkdtemp(join(tmpdir(), 'mm-backup-download-perm-'));
    await writeFile(join(backup.dir, 'users.json'), '[]');
    harness = await createRouteTestApp({
      mount: (app) => app.use('/system/backup', systemBackupRouter),
    });
  });

  afterEach(async () => {
    await harness.cleanup();
    await rm(backup.dir, { recursive: true, force: true });
  });

  it('an admin gets the archive', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/system/backup/download/${DIRNAME}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('gzip');
  });

  it('a user holding configuration:read is refused', async () => {
    await harness.grant(harness.limited.id, 'configuration', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);

    const res = await agent.get(`/system/backup/download/${DIRNAME}`);
    expect(res.status).toBe(403);
    expect(res.headers['content-type']).not.toContain('gzip');

    // The grant is real: the same user can still list backups.
    expect((await agent.get('/system/backup/list')).status).toBe(200);
  });

  it('a non-admin API token is refused', async () => {
    await harness.grant(harness.limited.id, 'configuration', 'read', harness.sourceA);
    const token = await harness.tokenFor(harness.limited);
    const agent = await harness.loginAs(null);
    const res = await agent.get(`/system/backup/download/${DIRNAME}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('an anonymous visitor is refused even when anonymous holds configuration:read', async () => {
    await harness.grant(harness.anonymous.id, 'configuration', 'read', harness.sourceA);
    const agent = await harness.loginAs(null);
    const res = await agent.get(`/system/backup/download/${DIRNAME}`);
    expect(res.status).toBe(401);
  });
});

describe('POST /system/backup — one backup at a time', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    backup.createBackup.mockReset();
    harness = await createRouteTestApp({
      mount: (app) => app.use('/system/backup', systemBackupRouter),
    });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('answers 409 BACKUP_IN_PROGRESS while another backup is being written', async () => {
    backup.createBackup.mockRejectedValue(new backup.SystemBackupInProgressError('A system backup is already running'));
    const agent = await harness.loginAs(harness.admin);

    const res = await agent.post('/system/backup');
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, code: 'BACKUP_IN_PROGRESS' });
  });

  it('creates a backup for an admin', async () => {
    backup.createBackup.mockResolvedValue('2099-01-01_000000');
    const agent = await harness.loginAs(harness.admin);

    const res = await agent.post('/system/backup');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, dirname: '2099-01-01_000000' });
  });

  it('a non-admin with configuration:write can create a backup but cannot download it', async () => {
    backup.createBackup.mockResolvedValue('2099-01-01_000000');
    backup.dir = await mkdtemp(join(tmpdir(), 'mm-backup-create-perm-'));
    try {
      await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);

      expect((await agent.post('/system/backup')).status).toBe(200);
      expect((await agent.get('/system/backup/download/2099-01-01_000000')).status).toBe(403);
    } finally {
      await rm(backup.dir, { recursive: true, force: true });
    }
  });

  it('a failed backup answers 500 BACKUP_FAILED with the reason', async () => {
    backup.createBackup.mockRejectedValue(new Error('Failed to create system backup: disk full'));
    const agent = await harness.loginAs(harness.admin);

    const res = await agent.post('/system/backup');
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      success: false,
      code: 'BACKUP_FAILED',
      details: 'Failed to create system backup: disk full',
    });
  });

  it('refuses a user without configuration:write', async () => {
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.post('/system/backup')).status).toBe(403);
    expect(backup.createBackup).not.toHaveBeenCalled();
  });
});
