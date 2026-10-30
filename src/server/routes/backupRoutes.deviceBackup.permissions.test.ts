/**
 * Who may enumerate / download / delete device config backups.
 *
 * `configuration` is a per-source resource. The device-backup list, download,
 * and delete endpoints used to call `requirePermission('configuration', …)`
 * with no `sourceIdFrom`, so the check passed on a grant for ANY source: a user
 * with `configuration:read` on one source could enumerate and download every
 * device backup, and `configuration:write` on one source could delete them
 * (AUTHZ-09 #6073).
 *
 * They now run through `requireDeviceSourcePermission`, which scopes the check
 * to the target source (the primary when none is named). A grant on a different
 * source no longer satisfies it.
 *
 * Real session, real auth middleware, real permission rows (route harness).
 * `resolveSourceManager` is mocked so the resolved primary source is a fixed id
 * we can grant against.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const mockBackupFileService = vi.hoisted(() => ({
  listBackups: vi.fn().mockResolvedValue([{ filename: 'a.yaml' }]),
  getBackup: vi.fn().mockResolvedValue('yaml-content'),
  deleteBackup: vi.fn().mockResolvedValue(undefined),
}));

// The resolved primary source id. Set to harness.sourceA in beforeEach.
const mockManager = vi.hoisted(() => ({ sourceId: 'rt-source-a' }));

vi.mock('../services/backupFileService.js', () => ({
  backupFileService: mockBackupFileService,
}));

vi.mock('../utils/resolveSourceManager.js', () => ({
  resolveSourceManager: vi.fn((_sourceId?: string | null) => mockManager),
}));

import { backupRouter } from './backupRoutes.js';

/**
 * One permission row holds read + write + viewOnMap per (user, resource,
 * sourceId), so `configuration:read` and `configuration:write` on the same
 * source must be a single row — two `harness.grant()` calls would collide on
 * the unique key.
 */
async function grantConfig(
  harness: RouteTestHarness,
  userId: number,
  sourceId: string,
  flags: { read?: boolean; write?: boolean },
): Promise<void> {
  await harness.db.auth.createPermission({
    userId,
    resource: 'configuration',
    canRead: !!flags.read,
    canWrite: !!flags.write,
    canViewOnMap: false,
    sourceId,
    grantedAt: Date.now(),
    grantedBy: null,
  });
}

describe('device backup list/download/delete — scoped to the target source', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    mockBackupFileService.listBackups.mockClear();
    mockBackupFileService.getBackup.mockClear();
    mockBackupFileService.deleteBackup.mockClear();
    harness = await createRouteTestApp({
      mount: (app) => app.use('/backup', backupRouter),
    });
    // The primary source the unnamed routes resolve to.
    mockManager.sourceId = harness.sourceA;
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('an admin may list, download, and delete', async () => {
    const agent = await harness.loginAs(harness.admin);
    expect((await agent.get('/backup/list')).status).toBe(200);
    expect((await agent.get('/backup/download/a.yaml')).status).toBe(200);
    expect((await agent.delete('/backup/delete/a.yaml')).status).toBe(200);
  });

  it('a user with configuration on the target source is allowed', async () => {
    await grantConfig(harness, harness.limited.id, harness.sourceA, { read: true, write: true });
    const agent = await harness.loginAs(harness.limited);

    expect((await agent.get('/backup/list')).status).toBe(200);
    expect((await agent.get('/backup/download/a.yaml')).status).toBe(200);
    expect((await agent.delete('/backup/delete/a.yaml')).status).toBe(200);
  });

  it('a grant on a DIFFERENT source does not satisfy the check (AUTHZ-09)', async () => {
    // configuration on sourceB only; the routes resolve to sourceA.
    await grantConfig(harness, harness.limited.id, harness.sourceB, { read: true, write: true });
    const agent = await harness.loginAs(harness.limited);

    expect((await agent.get('/backup/list')).status).toBe(403);
    expect((await agent.get('/backup/download/a.yaml')).status).toBe(403);
    expect((await agent.delete('/backup/delete/a.yaml')).status).toBe(403);

    // The service was never reached — the gate stopped the request.
    expect(mockBackupFileService.listBackups).not.toHaveBeenCalled();
    expect(mockBackupFileService.getBackup).not.toHaveBeenCalled();
    expect(mockBackupFileService.deleteBackup).not.toHaveBeenCalled();
  });

  it('a user with no configuration grant is refused', async () => {
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.get('/backup/list')).status).toBe(403);
    expect((await agent.get('/backup/download/a.yaml')).status).toBe(403);
    expect((await agent.delete('/backup/delete/a.yaml')).status).toBe(403);
  });

  it('read does not imply delete: configuration:read alone cannot delete', async () => {
    await harness.grant(harness.limited.id, 'configuration', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);

    expect((await agent.get('/backup/list')).status).toBe(200);
    expect((await agent.delete('/backup/delete/a.yaml')).status).toBe(403);
    expect(mockBackupFileService.deleteBackup).not.toHaveBeenCalled();
  });
});
