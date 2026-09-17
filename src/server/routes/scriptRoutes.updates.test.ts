/**
 * Script update endpoints (#5255).
 *
 * Checking is `settings:read`; changing code on disk is `settings:write`.
 * The update service itself is stubbed here — it has its own tests — so this
 * covers the routing, the permission split and the filename handling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';

const h = vi.hoisted(() => ({
  checkScriptForUpdate: vi.fn(),
  applyScriptUpdate: vi.fn(),
  rollbackScriptUpdate: vi.fn(),
  setManualScriptSource: vi.fn(),
  existsSync: vi.fn(() => true),
}));

vi.mock('../services/scriptUpdateService.js', () => ({
  checkScriptForUpdate: h.checkScriptForUpdate,
  applyScriptUpdate: h.applyScriptUpdate,
  rollbackScriptUpdate: h.rollbackScriptUpdate,
  setManualScriptSource: h.setManualScriptSource,
}));

import fs from 'fs';
import path from 'path';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import scriptRouter, { getScriptsDirectory } from './scriptRoutes.js';

let harness: RouteTestHarness;

// The routes work on real files, so give them one. Named for this test so a
// developer's own scripts directory is never touched.
const FILENAME = 'mm-test-weather.py';
const CONTENTS = '#!/usr/bin/env python3\n# mm_meta:\n#   name: Test Weather\n#   version: 1.0.0\n#   source: kd2abc/scripts/weather.py\nprint("hi")\n';
let scriptPath: string;

beforeEach(async () => {
  vi.clearAllMocks();
  h.checkScriptForUpdate.mockResolvedValue({
    filename: 'weather.py',
    installedVersion: '1.0.0',
    latestVersion: '2.0.0',
    updateAvailable: true,
    sourceOrigin: 'script',
    source: 'kd2abc/scripts/weather.py',
    sourceUrl: 'https://github.com/kd2abc/scripts/blob/HEAD/weather.py',
    hasBackup: false,
    backupVersion: null,
    error: null,
  });
  h.applyScriptUpdate.mockResolvedValue({ filename: 'weather.py', previousVersion: '1.0.0', newVersion: '2.0.0', source: 'kd2abc/scripts/weather.py' });
  h.rollbackScriptUpdate.mockReturnValue({ filename: 'weather.py', restoredVersion: '1.0.0' });
  h.setManualScriptSource.mockResolvedValue({ owner: 'kd2abc', repo: 'scripts', path: 'weather.py' });

  scriptPath = path.join(getScriptsDirectory(), FILENAME);
  fs.writeFileSync(scriptPath, CONTENTS, { mode: 0o755 });

  harness = await createRouteTestApp({
    mount: (app: express.Express) => app.use('/api', scriptRouter),
  });
});

afterEach(() => {
  harness.cleanup();
  vi.restoreAllMocks();
  fs.rmSync(scriptPath, { force: true });
});

describe('GET /api/scripts/updates (#5255)', () => {
  it('needs settings:read', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/api/scripts/updates');
    expect(res.status).toBe(403);
    expect(h.checkScriptForUpdate).not.toHaveBeenCalled();
  });

  it('returns a status per installed script', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/api/scripts/updates');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.scripts)).toBe(true);
    expect(res.body.checkedAt).toBeTypeOf('number');
  });
});

describe('script update writes (#5255)', () => {
  it('refuses a plain reader', async () => {
    const agent = await harness.loginAs(harness.limited);

    expect((await agent.post('/api/scripts/mm-test-weather.py/update')).status).toBe(403);
    expect((await agent.post('/api/scripts/mm-test-weather.py/rollback')).status).toBe(403);
    expect((await agent.put('/api/scripts/mm-test-weather.py/source').send({ source: 'a/b/c.py' })).status).toBe(403);

    expect(h.applyScriptUpdate).not.toHaveBeenCalled();
    expect(h.rollbackScriptUpdate).not.toHaveBeenCalled();
    expect(h.setManualScriptSource).not.toHaveBeenCalled();
  });

  it('reports a source the service rejected as a 400, not a 500', async () => {
    const agent = await harness.loginAs(harness.admin);
    h.setManualScriptSource.mockRejectedValue(new Error('Not a GitHub file path. Use owner/repo/path/to/script.py'));

    const res = await agent.put('/api/scripts/mm-test-weather.py/source').send({ source: 'http://evil.test/x.py' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/GitHub file path/);
  });

  it('surfaces an update failure as a 400 with the reason', async () => {
    const agent = await harness.loginAs(harness.admin);
    h.applyScriptUpdate.mockRejectedValue(new Error('GitHub rate limit reached, or the repository is private'));

    const res = await agent.post('/api/scripts/mm-test-weather.py/update');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/rate limit/);
  });

  it('rolls back through the service', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/api/scripts/mm-test-weather.py/rollback');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, filename: 'weather.py', restoredVersion: '1.0.0' });
    expect(h.rollbackScriptUpdate).toHaveBeenCalledWith(expect.any(String), FILENAME);
  });

  it('strips a path traversal attempt out of the filename', async () => {
    const agent = await harness.loginAs(harness.admin);
    await agent.post(`/api/scripts/${encodeURIComponent('../../etc/passwd')}/rollback`);
    expect(h.rollbackScriptUpdate).toHaveBeenCalledWith(expect.any(String), 'passwd');
  });
});
