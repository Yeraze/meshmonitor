/**
 * Device-config backup routes: per-source scoping and permissions (#6285,
 * builds on AUTHZ-09 #6073).
 *
 * Real session, real auth middleware, real permission rows, real
 * `backup_history` rows and real files in a temp BACKUP_DIR (route harness).
 * Only the device-facing services are mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';

const mocks = vi.hoisted(() => ({
  generateBackup: vi.fn().mockResolvedValue('# start of Meshtastic configure yaml\nowner: Test\n'),
  restoreBackup: vi.fn().mockResolvedValue({ applied: ['owner'], failed: [], channels: 1, requiresReboot: false }),
}));
vi.mock('../services/deviceBackupService.js', () => ({
  deviceBackupService: { generateBackup: mocks.generateBackup },
}));
vi.mock('../services/deviceRestoreService.js', () => ({
  deviceRestoreService: { restoreBackup: mocks.restoreBackup },
}));

import { backupRouter } from './backupRoutes.js';
import deviceRoutes from './deviceRoutes.js';

const YAML_A = '# start of Meshtastic configure yaml\nowner: Alpha\nconfig:\n  lora:\n    region: US\n';
const YAML_B = '# start of Meshtastic configure yaml\nowner: Bravo\n';
const MC_YAML = 'meshmonitor_backup: meshcore_companion\nformat_version: 1\n';

function fakeManager(sourceId: string, sourceType = 'meshtastic_tcp'): ISourceManager {
  return {
    sourceId,
    sourceType,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockReturnValue({ sourceId, sourceName: sourceId, sourceType, connected: true }),
    startDistanceDeleteScheduler: vi.fn().mockResolvedValue(undefined),
    stopDistanceDeleteScheduler: vi.fn(),
    getLocalNodeInfo: vi.fn().mockReturnValue({ nodeId: '!00000001', nodeNum: 1 }),
    beginEditSettings: vi.fn(),
  } as unknown as ISourceManager;
}

/** One permission row per (user, resource, source): read + write together. */
async function grantConfig(
  harness: RouteTestHarness, userId: number, sourceId: string, flags: { read?: boolean; write?: boolean },
): Promise<void> {
  await harness.db.auth.createPermission({
    userId, resource: 'configuration', canRead: !!flags.read, canWrite: !!flags.write,
    canViewOnMap: false, sourceId, grantedAt: Date.now(), grantedBy: null,
  });
}

describe('device backup routes — per-source scoping', () => {
  let harness: RouteTestHarness;
  let dir: string;
  const MQTT = 'rt-source-mqtt-backup';

  const seed = async (sourceId: string | null, filename: string, content: string, protocol = 'meshtastic') => {
    const filePath = join(dir, filename);
    await writeFile(filePath, content, { mode: 0o600 });
    await databaseService.backupHistory.insertBackupHistory({
      sourceId, protocol, filename, filePath, fileSize: content.length,
      backupType: 'manual', timestamp: Date.now(), createdAt: Date.now(),
    });
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    dir = await mkdtemp(join(tmpdir(), 'mm-bkroutes-'));
    process.env.BACKUP_DIR = dir;
    harness = await createRouteTestApp({
      mount: (app) => {
        app.use('/backup', backupRouter);
        app.use('/', deviceRoutes);
      },
    });
    await sourceManagerRegistry.addManager(fakeManager(harness.sourceA));
    await sourceManagerRegistry.addManager(fakeManager(harness.sourceB));
    await seed(harness.sourceA, 'mt-a-1.yaml', YAML_A);
    await seed(harness.sourceB, 'mt-b-1.yaml', YAML_B);
  });

  afterEach(async () => {
    for (const id of [harness.sourceA, harness.sourceB, MQTT]) await sourceManagerRegistry.removeManager(id);
    await databaseService.sources.deleteSource(MQTT).catch(() => {});
    // The singleton DB outlives each test: drop every history row seeded here.
    const repo = databaseService.backupHistory;
    const rows = [
      ...(await repo.getBackupHistoryList(harness.sourceA)),
      ...(await repo.getBackupHistoryList(harness.sourceB)),
      ...(await repo.getBackupHistoryList('gone-source')),
      ...(await repo.listUnowned()),
    ];
    for (const r of rows) await repo.deleteBackupHistoryById(r.id!);
    delete process.env.BACKUP_DIR;
    await rm(dir, { recursive: true, force: true });
    await harness.cleanup();
  });

  it('list returns only the target source files (named and primary)', async () => {
    const agent = await harness.loginAs(harness.admin);
    const named = await agent.get('/backup/list').query({ sourceId: harness.sourceB });
    expect(named.status).toBe(200);
    expect(named.body.map((b: { filename: string }) => b.filename)).toEqual(['mt-b-1.yaml']);
    const primary = await agent.get('/backup/list');
    expect(primary.body.map((b: { filename: string }) => b.filename)).toEqual(['mt-a-1.yaml']);
  });

  it('another source\'s file is 404 for download, delete, summary and restore, and survives', async () => {
    await grantConfig(harness, harness.limited.id, harness.sourceA, { read: true, write: true });
    const agent = await harness.loginAs(harness.limited);
    const q = { sourceId: harness.sourceA };

    expect((await agent.get('/backup/download/mt-b-1.yaml').query(q)).status).toBe(404);
    expect((await agent.get('/backup/summary/mt-b-1.yaml').query(q)).status).toBe(404);
    expect((await agent.delete('/backup/delete/mt-b-1.yaml').query(q)).status).toBe(404);
    const restore = await agent.post('/backup/restore/mt-b-1.yaml').send(q);
    expect(restore.status).toBe(404);
    expect(restore.body.code).toBe('BACKUP_NOT_FOUND');

    expect(existsSync(join(dir, 'mt-b-1.yaml'))).toBe(true);
    expect(mocks.restoreBackup).not.toHaveBeenCalled();
  });

  it('own file: list, summary, download, restore, delete work with write on the source', async () => {
    await grantConfig(harness, harness.limited.id, harness.sourceA, { read: true, write: true });
    const agent = await harness.loginAs(harness.limited);
    const q = { sourceId: harness.sourceA };

    expect((await agent.get('/backup/list').query(q)).status).toBe(200);
    const summary = await agent.get('/backup/summary/mt-a-1.yaml').query(q);
    expect(summary.status).toBe(200);
    expect(summary.body.data).toMatchObject({ protocol: 'meshtastic', name: 'Alpha', legacy: false });
    expect(JSON.stringify(summary.body)).not.toMatch(/psk|private/i);
    const dl = await agent.get('/backup/download/mt-a-1.yaml').query(q);
    expect(dl.status).toBe(200);
    expect(dl.text).toBe(YAML_A);
    const rs = await agent.post('/backup/restore/mt-a-1.yaml').send(q);
    expect(rs.status).toBe(200);
    expect(rs.body.data.applied).toEqual(['owner']);
    expect(mocks.restoreBackup).toHaveBeenCalledTimes(1);
    expect((await agent.delete('/backup/delete/mt-a-1.yaml').query(q)).status).toBe(200);
    expect(existsSync(join(dir, 'mt-a-1.yaml'))).toBe(false);
  });

  it('download needs configuration:write: read-only is 403 (Q2), list stays readable', async () => {
    await harness.grant(harness.limited.id, 'configuration', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const q = { sourceId: harness.sourceA };
    expect((await agent.get('/backup/list').query(q)).status).toBe(200);
    expect((await agent.get('/backup/summary/mt-a-1.yaml').query(q)).status).toBe(200);
    expect((await agent.get('/backup/download/mt-a-1.yaml').query(q)).status).toBe(403);
    expect((await agent.delete('/backup/delete/mt-a-1.yaml').query(q)).status).toBe(403);
  });

  it('GET /device/backup needs configuration:write and saves a scoped 0600 file', async () => {
    await harness.grant(harness.limited.id, 'configuration', 'read', harness.sourceA);
    let agent = await harness.loginAs(harness.limited);
    expect((await agent.get('/device/backup').query({ sourceId: harness.sourceA, save: 'true' })).status).toBe(403);
    expect(mocks.generateBackup).not.toHaveBeenCalled();

    await grantConfig(harness, harness.limited.id, harness.sourceB, { read: true, write: true });
    agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/device/backup').query({ sourceId: harness.sourceB, save: 'true' });
    expect(res.status).toBe(200);
    const name = /filename="([^"]+)"/.exec(res.headers['content-disposition'] ?? '')?.[1] ?? '';
    expect(name).toMatch(/^mt-00000001-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}(-\d+)?\.yaml$/);
    expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
    const row = await databaseService.backupHistory.getBackupByFilename(harness.sourceB, name);
    expect(row).toMatchObject({ sourceId: harness.sourceB, protocol: 'meshtastic' });
    expect(await databaseService.backupHistory.getBackupByFilename(harness.sourceA, name)).toBeNull();
  });

  it('a grant on a DIFFERENT source does not satisfy the check (AUTHZ-09)', async () => {
    await grantConfig(harness, harness.limited.id, harness.sourceB, { read: true, write: true });
    const agent = await harness.loginAs(harness.limited);
    const q = { sourceId: harness.sourceA };
    expect((await agent.get('/backup/list').query(q)).status).toBe(403);
    expect((await agent.get('/backup/download/mt-a-1.yaml').query(q)).status).toBe(403);
    expect((await agent.delete('/backup/delete/mt-a-1.yaml').query(q)).status).toBe(403);
    expect((await agent.get('/backup/settings').query(q)).status).toBe(403);
    expect((await agent.post('/backup/settings').send({ ...q, enabled: true, maxBackups: 3, backupTime: '03:00' })).status).toBe(403);
    expect(existsSync(join(dir, 'mt-a-1.yaml'))).toBe(true);
  });

  it('no grant at all is refused', async () => {
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.get('/backup/list')).status).toBe(403);
    expect((await agent.get('/backup/download/mt-a-1.yaml')).status).toBe(403);
  });

  describe('legacy (unowned) rows', () => {
    beforeEach(async () => {
      await seed(null, 'legacy-1.yaml', YAML_A);
      await seed('gone-source', 'orphan-1.yaml', YAML_A);
      await seed(null, 'legacy-mc.yaml', MC_YAML, 'meshcore');
    });

    it('are listed for admins only, flagged legacy, same protocol only', async () => {
      const admin = await harness.loginAs(harness.admin);
      const list = await admin.get('/backup/list').query({ sourceId: harness.sourceA });
      const legacy = list.body.filter((b: { legacy: boolean }) => b.legacy).map((b: { filename: string }) => b.filename).sort();
      expect(legacy).toEqual(['legacy-1.yaml', 'orphan-1.yaml']);

      await grantConfig(harness, harness.limited.id, harness.sourceA, { read: true, write: true });
      const user = await harness.loginAs(harness.limited);
      const ul = await user.get('/backup/list').query({ sourceId: harness.sourceA });
      expect(ul.body.map((b: { filename: string }) => b.filename)).toEqual(['mt-a-1.yaml']);
      expect((await user.get('/backup/download/legacy-1.yaml').query({ sourceId: harness.sourceA })).status).toBe(404);
      expect((await user.delete('/backup/delete/legacy-1.yaml').query({ sourceId: harness.sourceA })).status).toBe(404);
      expect((await user.post('/backup/restore/legacy-1.yaml').send({ sourceId: harness.sourceA, confirmLegacy: true })).status).toBe(404);
    });

    it('an admin restore needs the extra confirmation; a cross-protocol restore is 409', async () => {
      const admin = await harness.loginAs(harness.admin);
      const noConfirm = await admin.post('/backup/restore/legacy-1.yaml').send({ sourceId: harness.sourceA });
      expect(noConfirm.status).toBe(409);
      expect(noConfirm.body.code).toBe('LEGACY_CONFIRM_REQUIRED');
      expect(mocks.restoreBackup).not.toHaveBeenCalled();

      const confirmed = await admin.post('/backup/restore/legacy-1.yaml').send({ sourceId: harness.sourceA, confirmLegacy: true });
      expect(confirmed.status).toBe(200);
      expect(mocks.restoreBackup).toHaveBeenCalledTimes(1);

      const mismatch = await admin.post('/backup/restore/legacy-mc.yaml').send({ sourceId: harness.sourceA, confirmLegacy: true });
      expect(mismatch.status).toBe(409);
      expect(mismatch.body.code).toBe('BACKUP_PROTOCOL_MISMATCH');
    });

    it('an admin may download and delete an orphan', async () => {
      const admin = await harness.loginAs(harness.admin);
      const q = { sourceId: harness.sourceA };
      expect((await admin.get('/backup/download/orphan-1.yaml').query(q)).status).toBe(200);
      expect((await admin.delete('/backup/delete/orphan-1.yaml').query(q)).status).toBe(200);
    });
  });

  it('a MeshMonitor MeshCore file under a Meshtastic row is a protocol mismatch (409)', async () => {
    await seed(harness.sourceA, 'mt-a-bad.yaml', MC_YAML); // row says meshtastic, content says meshcore
    const admin = await harness.loginAs(harness.admin);
    const res = await admin.post('/backup/restore/mt-a-bad.yaml').send({ sourceId: harness.sourceA });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('BACKUP_PROTOCOL_MISMATCH');
    expect(mocks.restoreBackup).not.toHaveBeenCalled();
  });

  it('settings are per source: no cross-grant, values stored under source keys', async () => {
    await grantConfig(harness, harness.limited.id, harness.sourceA, { read: true, write: true });
    const agent = await harness.loginAs(harness.limited);
    const save = await agent.post('/backup/settings').send({ sourceId: harness.sourceA, enabled: true, maxBackups: 5, backupTime: '04:15' });
    expect(save.status).toBe(200);
    expect(await databaseService.settings.getSetting(`source:${harness.sourceA}:backup_time`)).toBe('04:15');
    expect(await databaseService.settings.getSetting(`source:${harness.sourceB}:backup_time`)).toBeNull();

    const a = await agent.get('/backup/settings').query({ sourceId: harness.sourceA });
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ enabled: true, maxBackups: 5, backupTime: '04:15' });
    expect((await agent.get('/backup/settings').query({ sourceId: harness.sourceB })).status).toBe(403);

    const bad = await agent.post('/backup/settings').send({ sourceId: harness.sourceA, enabled: true, maxBackups: 0, backupTime: '04:15' });
    expect(bad.status).toBe(400);
    const badTime = await agent.post('/backup/settings').send({ sourceId: harness.sourceA, enabled: true, maxBackups: 3, backupTime: '25:99' });
    expect(badTime.status).toBe(400);
  });

  it('a source that is neither Meshtastic TCP nor MeshCore gets 400 SOURCE_NOT_BACKUP_CAPABLE', async () => {
    await databaseService.sources.createSource({ id: MQTT, name: 'mqtt', type: 'mqtt_broker', config: {}, enabled: true });
    const admin = await harness.loginAs(harness.admin);
    const res = await admin.get('/backup/list').query({ sourceId: MQTT });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SOURCE_NOT_BACKUP_CAPABLE');
  });

  it('list, download and delete work for a stored source with no connected manager', async () => {
    await sourceManagerRegistry.removeManager(harness.sourceA);
    const admin = await harness.loginAs(harness.admin);
    const q = { sourceId: harness.sourceA };
    expect((await admin.get('/backup/list').query(q)).status).toBe(200);
    expect((await admin.get('/backup/download/mt-a-1.yaml').query(q)).status).toBe(200);
    expect(await readFile(join(dir, 'mt-a-1.yaml'), 'utf8')).toBe(YAML_A);
  });

  it('restore and create on a disconnected source are refused and reach no device', async () => {
    await sourceManagerRegistry.removeManager(harness.sourceA);
    const admin = await harness.loginAs(harness.admin);
    const restore = await admin.post('/backup/restore/mt-a-1.yaml').send({ sourceId: harness.sourceA });
    expect(restore.status).toBeGreaterThanOrEqual(400);
    expect(mocks.restoreBackup).not.toHaveBeenCalled();
    const create = await admin.get('/device/backup').query({ sourceId: harness.sourceA, save: 'true' });
    expect(create.status).toBeGreaterThanOrEqual(400);
    expect(mocks.generateBackup).not.toHaveBeenCalled();
  });
});
