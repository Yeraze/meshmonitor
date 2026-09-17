import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const h = vi.hoisted(() => ({
  safeFetch: vi.fn(),
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

const FakeSsrfBlockedError = h.SsrfBlockedError;

vi.mock('../utils/ssrfGuard.js', () => ({
  safeFetch: h.safeFetch,
  SsrfBlockedError: h.SsrfBlockedError,
}));

vi.mock('../../services/database.js', () => {
  const shared = { settings: { getSetting: h.getSetting, setSetting: h.setSetting } };
  return { default: shared, databaseService: shared };
});

import {
  applyScriptUpdate,
  checkScriptForUpdate,
  resolveScriptSource,
  rollbackScriptUpdate,
  setManualScriptSource,
  versionFromContents,
} from './scriptUpdateService.js';

const WEATHER_V2 = '#!/usr/bin/env python3\n# mm_meta:\n#   name: Weather\n#   version: 2.0.0\nprint("v2")\n';

/** A GitHub Contents API response for a file. */
function contentsResponse(body: string, extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      type: 'file',
      encoding: 'base64',
      size: Buffer.byteLength(body),
      content: Buffer.from(body).toString('base64'),
      ...extra,
    }),
  };
}

let dir: string;

beforeEach(() => {
  vi.clearAllMocks();
  h.getSetting.mockResolvedValue(null);
  h.setSetting.mockResolvedValue(undefined);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-scripts-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeScript(name: string, body: string, mode = 0o755) {
  fs.writeFileSync(path.join(dir, name), body, { mode });
}

describe('resolveScriptSource (#5255)', () => {
  it("prefers the script's own mm_meta source", async () => {
    h.getSetting.mockResolvedValue(JSON.stringify({ 'weather.py': 'someone/else/weather.py' }));
    const resolved = await resolveScriptSource('weather.py', 'kd2abc/scripts/weather.py');
    expect(resolved).toEqual({ source: { owner: 'kd2abc', repo: 'scripts', path: 'weather.py' }, origin: 'script' });
  });

  it('falls back to the admin-entered source, then the gallery', async () => {
    h.getSetting.mockResolvedValue(JSON.stringify({ 'weather.py': 'kd2abc/scripts/weather.py' }));
    expect((await resolveScriptSource('weather.py', null))?.origin).toBe('manual');

    h.getSetting.mockResolvedValue(null);
    const gallery = await resolveScriptSource('hello.js', null);
    expect(gallery?.origin).toBe('gallery');
    // A gallery entry inside the main repo resolves to this repo.
    expect(gallery?.source).toMatchObject({ owner: 'Yeraze', repo: 'meshmonitor' });
  });

  it('returns null for a script nobody can place', async () => {
    expect(await resolveScriptSource('CustomResponder.py', null)).toBeNull();
  });

  it('ignores a stored source that is not a GitHub file path', async () => {
    // A filename the gallery does not list, so nothing else can resolve it.
    h.getSetting.mockResolvedValue(JSON.stringify({ 'CustomResponder.py': 'http://evil.test/x.py' }));
    expect(await resolveScriptSource('CustomResponder.py', null)).toBeNull();
  });
});

describe('setManualScriptSource (#5255)', () => {
  it('stores a valid source and rejects anything else', async () => {
    await setManualScriptSource('weather.py', 'kd2abc/scripts/weather.py');
    expect(h.setSetting).toHaveBeenCalledWith('scriptUpdateSources', JSON.stringify({ 'weather.py': 'kd2abc/scripts/weather.py' }));

    await expect(setManualScriptSource('weather.py', 'http://evil.test/x.py')).rejects.toThrow(/GitHub file path/);
  });

  it('clears the stored source when given an empty value', async () => {
    h.getSetting.mockResolvedValue(JSON.stringify({ 'weather.py': 'kd2abc/scripts/weather.py' }));
    await setManualScriptSource('weather.py', '');
    expect(h.setSetting).toHaveBeenCalledWith('scriptUpdateSources', '{}');
  });
});

describe('versionFromContents (#5255)', () => {
  it('reads the mm_meta version and drops a leading v', () => {
    expect(versionFromContents(WEATHER_V2)).toBe('2.0.0');
    expect(versionFromContents('// mm_meta:\n//   version: v1.4\n')).toBe('1.4');
    expect(versionFromContents('print("no meta")')).toBeNull();
  });
});

describe('checkScriptForUpdate (#5255)', () => {
  it('reports a newer published version', async () => {
    h.safeFetch.mockResolvedValue(contentsResponse(WEATHER_V2));
    const status = await checkScriptForUpdate(dir, {
      filename: 'weather.py',
      version: '1.0.0',
      source: 'kd2abc/scripts/weather.py',
    });

    expect(status).toMatchObject({
      installedVersion: '1.0.0',
      latestVersion: '2.0.0',
      updateAvailable: true,
      sourceOrigin: 'script',
      source: 'kd2abc/scripts/weather.py',
      error: null,
    });
    expect(h.safeFetch.mock.calls[0][0]).toBe('https://api.github.com/repos/kd2abc/scripts/contents/weather.py');
  });

  it('does not offer an update when the published version is the same or older', async () => {
    h.safeFetch.mockResolvedValue(contentsResponse(WEATHER_V2));
    const same = await checkScriptForUpdate(dir, { filename: 'weather.py', version: '2.0.0', source: 'kd2abc/scripts/weather.py' });
    expect(same.updateAvailable).toBe(false);

    const newer = await checkScriptForUpdate(dir, { filename: 'weather.py', version: '3.1.0', source: 'kd2abc/scripts/weather.py' });
    expect(newer.updateAvailable).toBe(false);
  });

  it('explains an uncheckable script instead of failing the list', async () => {
    const noSource = await checkScriptForUpdate(dir, { filename: 'CustomResponder.py', version: '1.0.0' });
    expect(noSource).toMatchObject({ sourceOrigin: null, source: null, updateAvailable: false, error: null });

    h.safeFetch.mockRejectedValue(new Error('GitHub is unreachable'));
    const unreachable = await checkScriptForUpdate(dir, { filename: 'weather.py', version: '1.0.0', source: 'kd2abc/scripts/weather.py' });
    expect(unreachable.error).toBe('GitHub is unreachable');
    expect(unreachable.updateAvailable).toBe(false);

    h.safeFetch.mockRejectedValue(new FakeSsrfBlockedError('blocked'));
    const blocked = await checkScriptForUpdate(dir, { filename: 'weather.py', version: '1.0.0', source: 'kd2abc/scripts/weather.py' });
    expect(blocked.error).toBe('That source was blocked as unsafe');

    h.safeFetch.mockResolvedValue(contentsResponse('print("no meta")'));
    const unversioned = await checkScriptForUpdate(dir, { filename: 'weather.py', version: '1.0.0', source: 'kd2abc/scripts/weather.py' });
    expect(unversioned.error).toMatch(/no mm_meta version/);
    expect(unversioned.updateAvailable).toBe(false);
  });

  it('refuses a web page or a binary in place of a script', async () => {
    h.safeFetch.mockResolvedValue(contentsResponse('<!DOCTYPE html><html><body>nope</body></html>'));
    const html = await checkScriptForUpdate(dir, { filename: 'weather.py', version: '1.0.0', source: 'kd2abc/scripts/weather.py' });
    expect(html.error).toMatch(/web page/);

    h.safeFetch.mockResolvedValue(contentsResponse(`binary${String.fromCharCode(0)}payload`));
    const binary = await checkScriptForUpdate(dir, { filename: 'weather.py', version: '1.0.0', source: 'kd2abc/scripts/weather.py' });
    expect(binary.error).toMatch(/binary/);
  });

  it('refuses a file larger than the cap', async () => {
    h.safeFetch.mockResolvedValue(contentsResponse('x', { size: 900 * 1024 }));
    const status = await checkScriptForUpdate(dir, { filename: 'weather.py', version: '1.0.0', source: 'kd2abc/scripts/weather.py' });
    expect(status.error).toMatch(/larger than/);
  });
});

describe('applyScriptUpdate and rollback (#5255)', () => {
  const installed = '#!/usr/bin/env python3\n# mm_meta:\n#   version: 1.0.0\nprint("v1")\n';

  it('replaces the file, keeps a backup, and can put it back', async () => {
    writeScript('weather.py', installed);
    h.safeFetch.mockResolvedValue(contentsResponse(WEATHER_V2));

    const result = await applyScriptUpdate(dir, { filename: 'weather.py', version: '1.0.0', source: 'kd2abc/scripts/weather.py' });
    expect(result).toMatchObject({ previousVersion: '1.0.0', newVersion: '2.0.0' });
    expect(fs.readFileSync(path.join(dir, 'weather.py'), 'utf8')).toBe(WEATHER_V2);
    expect(fs.readFileSync(path.join(dir, '.backups', 'weather.py'), 'utf8')).toBe(installed);

    // The status now advertises the backup.
    h.safeFetch.mockResolvedValue(contentsResponse(WEATHER_V2));
    const status = await checkScriptForUpdate(dir, { filename: 'weather.py', version: '2.0.0', source: 'kd2abc/scripts/weather.py' });
    expect(status).toMatchObject({ hasBackup: true, backupVersion: '1.0.0', updateAvailable: false });

    const rolled = rollbackScriptUpdate(dir, 'weather.py');
    expect(rolled.restoredVersion).toBe('1.0.0');
    expect(fs.readFileSync(path.join(dir, 'weather.py'), 'utf8')).toBe(installed);
    expect(fs.existsSync(path.join(dir, '.backups', 'weather.py'))).toBe(false);
  });

  it('keeps the file executable', async () => {
    writeScript('weather.py', installed, 0o755);
    h.safeFetch.mockResolvedValue(contentsResponse(WEATHER_V2));

    await applyScriptUpdate(dir, { filename: 'weather.py', version: '1.0.0', source: 'kd2abc/scripts/weather.py' });
    expect(fs.statSync(path.join(dir, 'weather.py')).mode & 0o111).not.toBe(0);
  });

  it('leaves the installed script alone when the download fails', async () => {
    writeScript('weather.py', installed);
    h.safeFetch.mockRejectedValue(new Error('GitHub returned 500'));

    await expect(applyScriptUpdate(dir, { filename: 'weather.py', version: '1.0.0', source: 'kd2abc/scripts/weather.py' }))
      .rejects.toThrow('GitHub returned 500');
    expect(fs.readFileSync(path.join(dir, 'weather.py'), 'utf8')).toBe(installed);
    expect(fs.existsSync(path.join(dir, '.backups', 'weather.py'))).toBe(false);
  });

  it('refuses to update a script with no source, or one that is gone', async () => {
    writeScript('CustomResponder.py', installed);
    await expect(applyScriptUpdate(dir, { filename: 'CustomResponder.py', version: '1.0.0' }))
      .rejects.toThrow(/no update source/);

    await expect(applyScriptUpdate(dir, { filename: 'missing.py', version: '1.0.0', source: 'kd2abc/scripts/missing.py' }))
      .rejects.toThrow('Script not found');
  });

  it('keeps a crafted filename inside the backup directory', async () => {
    writeScript('weather.py', installed);
    h.safeFetch.mockResolvedValue(contentsResponse(WEATHER_V2));

    // A caller that skipped the route's own basename() must not be able to
    // write the backup outside .backups/.
    await applyScriptUpdate(dir, {
      filename: 'weather.py',
      version: '1.0.0',
      source: 'kd2abc/scripts/weather.py',
    });
    expect(fs.existsSync(path.join(dir, '.backups', 'weather.py'))).toBe(true);

    // A traversing name resolves to the same script inside the directory
    // rather than escaping it.
    const rolled = rollbackScriptUpdate(dir, '../../weather.py');
    expect(rolled.filename).toBe('weather.py');
    expect(fs.readFileSync(path.join(dir, 'weather.py'), 'utf8')).toBe(installed);
    expect(fs.existsSync(path.join(dir, '..', 'weather.py'))).toBe(false);
  });

  it('records the version read from the replaced file, even when none was parsed', async () => {
    writeScript('weather.py', installed);
    h.safeFetch.mockResolvedValue(contentsResponse(WEATHER_V2));

    const result = await applyScriptUpdate(dir, { filename: 'weather.py', version: null, source: 'kd2abc/scripts/weather.py' });
    expect(result.previousVersion).toBe('1.0.0');
  });

  it('leaves no temp file behind when the write fails', async () => {
    writeScript('weather.py', installed);
    h.safeFetch.mockResolvedValue(contentsResponse(WEATHER_V2));
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    await expect(applyScriptUpdate(dir, { filename: 'weather.py', version: '1.0.0', source: 'kd2abc/scripts/weather.py' }))
      .rejects.toThrow('disk full');
    writeSpy.mockRestore();

    expect(fs.readdirSync(dir).filter(f => f.includes('.tmp-'))).toEqual([]);
    expect(fs.readFileSync(path.join(dir, 'weather.py'), 'utf8')).toBe(installed);
  });

  it('ignores junk in a backup record rather than passing it on', async () => {
    writeScript('weather.py', installed);
    fs.mkdirSync(path.join(dir, '.backups'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.backups', 'weather.py'), installed);
    fs.writeFileSync(
      path.join(dir, '.backups', 'weather.py.json'),
      JSON.stringify({ previousVersion: 'x'.repeat(500), source: { not: 'a string' }, updatedAt: 'soon' })
    );

    h.safeFetch.mockResolvedValue(contentsResponse(WEATHER_V2));
    const status = await checkScriptForUpdate(dir, { filename: 'weather.py', version: '2.0.0', source: 'kd2abc/scripts/weather.py' });
    expect(status.hasBackup).toBe(true);
    expect(status.backupVersion?.length).toBe(20);
  });

  it('refuses a rollback with no backup', () => {
    expect(() => rollbackScriptUpdate(dir, 'weather.py')).toThrow(/No backup/);
  });
});
