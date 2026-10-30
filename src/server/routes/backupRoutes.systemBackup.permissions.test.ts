/**
 * Who may manage system backups.
 *
 * A system backup archive is the whole database: password hashes, API token
 * hashes, channel decryption keys in the clear, and the encrypted PKI and
 * Observer keys. Every lifecycle endpoint (create, list, download, delete) used
 * to be gated on `configuration:read`/`configuration:write`, which an admin can
 * grant to a single source (or to the anonymous user). For a per-source
 * resource, omitting `sourceIdFrom` makes the check pass on a grant for ANY
 * source — so a single-source grant could create / enumerate / delete
 * full cross-source archives (AUTHZ-02 #6053, AUTHZ-03 #6067). They are all
 * admin-only now.
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
  return {
    dir: '',
    createBackup: vi.fn(),
    listBackups: vi.fn().mockResolvedValue([]),
    deleteBackup: vi.fn().mockResolvedValue(undefined),
    SystemBackupInProgressError,
  };
});

vi.mock('../services/systemBackupService.js', () => ({
  systemBackupService: {
    getBackupPath: () => backup.dir,
    listBackups: backup.listBackups,
    createBackup: backup.createBackup,
    deleteBackup: backup.deleteBackup,
  },
  SystemBackupInProgressError: backup.SystemBackupInProgressError,
}));

import { systemBackupRouter } from './backupRoutes.js';

const DIRNAME = '2099-01-01_000000';

/** A single configuration permission row carrying both read and write (one row
 *  per user/resource/source — two `grant()` calls would collide). */
async function grantConfigRW(
  harness: RouteTestHarness,
  userId: number,
  sourceId: string,
): Promise<void> {
  await harness.db.auth.createPermission({
    userId,
    resource: 'configuration',
    canRead: true,
    canWrite: true,
    canViewOnMap: false,
    sourceId,
    grantedAt: Date.now(),
    grantedBy: null,
  });
}

describe('system backup lifecycle — admin only', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    backup.createBackup.mockReset().mockResolvedValue(DIRNAME);
    backup.listBackups.mockReset().mockResolvedValue([{ dirname: DIRNAME }]);
    backup.deleteBackup.mockReset().mockResolvedValue(undefined);
    backup.dir = await mkdtemp(join(tmpdir(), 'mm-sysbackup-perm-'));
    await writeFile(join(backup.dir, 'users.json'), '[]');
    harness = await createRouteTestApp({
      mount: (app) => app.use('/system/backup', systemBackupRouter),
    });
  });

  afterEach(async () => {
    await harness.cleanup();
    await rm(backup.dir, { recursive: true, force: true });
  });

  describe('an admin may run the whole lifecycle', () => {
    it('creates, lists, downloads, and deletes', async () => {
      const agent = await harness.loginAs(harness.admin);

      expect((await agent.post('/system/backup')).status).toBe(200);
      expect((await agent.get('/system/backup/list')).status).toBe(200);
      const dl = await agent.get(`/system/backup/download/${DIRNAME}`);
      expect(dl.status).toBe(200);
      expect(dl.headers['content-type']).toContain('gzip');
      expect((await agent.delete(`/system/backup/delete/${DIRNAME}`)).status).toBe(200);
    });
  });

  describe('a non-admin with a real single-source configuration grant is refused', () => {
    it('cannot create a backup (AUTHZ-02)', async () => {
      await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);

      const res = await agent.post('/system/backup');
      expect(res.status).toBe(403);
      expect(backup.createBackup).not.toHaveBeenCalled();
    });

    it('cannot list backups (AUTHZ-03)', async () => {
      await grantConfigRW(harness, harness.limited.id, harness.sourceA);
      const agent = await harness.loginAs(harness.limited);

      const res = await agent.get('/system/backup/list');
      expect(res.status).toBe(403);
      expect(backup.listBackups).not.toHaveBeenCalled();
    });

    it('cannot delete a backup (AUTHZ-03)', async () => {
      await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);

      const res = await agent.delete(`/system/backup/delete/${DIRNAME}`);
      expect(res.status).toBe(403);
      expect(backup.deleteBackup).not.toHaveBeenCalled();
    });

    it('cannot download a backup', async () => {
      await harness.grant(harness.limited.id, 'configuration', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);

      const res = await agent.get(`/system/backup/download/${DIRNAME}`);
      expect(res.status).toBe(403);
      expect(res.headers['content-type']).not.toContain('gzip');
    });
  });

  it('a non-admin API token is refused', async () => {
    await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceA);
    const token = await harness.tokenFor(harness.limited);
    const agent = await harness.loginAs(null);

    expect((await agent.post('/system/backup').set('Authorization', `Bearer ${token}`)).status).toBe(403);
    expect((await agent.get('/system/backup/list').set('Authorization', `Bearer ${token}`)).status).toBe(403);
  });

  it('an anonymous visitor is refused even when anonymous holds configuration grants', async () => {
    await grantConfigRW(harness, harness.anonymous.id, harness.sourceA);
    const agent = await harness.loginAs(null);

    expect((await agent.post('/system/backup')).status).toBe(401);
    expect((await agent.get('/system/backup/list')).status).toBe(401);

    // The harness cleanup only revokes the admin/limited users; drop the
    // anonymous grant so it cannot leak into another test.
    await harness.revokeAll(harness.anonymous.id);
  });

  describe('still rejects the operational edge cases for admins', () => {
    it('answers 409 BACKUP_IN_PROGRESS while another backup is being written', async () => {
      backup.createBackup.mockRejectedValue(new backup.SystemBackupInProgressError('A system backup is already running'));
      const agent = await harness.loginAs(harness.admin);

      const res = await agent.post('/system/backup');
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ success: false, code: 'BACKUP_IN_PROGRESS' });
    });

    it('answers 500 BACKUP_FAILED with the reason', async () => {
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
  });
});
