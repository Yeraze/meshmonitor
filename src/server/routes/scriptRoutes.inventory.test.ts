import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';

// A real temp scripts directory so collectScripts() reads genuine files.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-scripts-inv-'));
const scriptsDir = path.join(tmpRoot, 'scripts');
fs.mkdirSync(scriptsDir, { recursive: true });
process.env.DATA_DIR = tmpRoot;

vi.mock('../config/environment.js', () => ({
  getEnvironmentConfig: vi.fn().mockReturnValue({ isDevelopment: false }),
}));

vi.mock('../utils/scriptRunner.js', () => ({
  scriptDependencyEnv: vi.fn().mockReturnValue({}),
}));

vi.mock('../../utils/autoResponderUtils.js', () => ({
  normalizeTriggerPatterns: vi.fn((t: any) => (Array.isArray(t) ? t : [t])),
}));

vi.mock('../utils/ssrfGuard.js', () => ({
  safeFetch: vi.fn(),
  SsrfBlockedError: class extends Error {},
}));

vi.mock('../services/scriptDependencyService.js', () => ({
  getDependencyStatus: vi.fn(),
  installDependencies: vi.fn(),
}));

vi.mock('../auth/authMiddleware.js', () => ({
  requirePermission: () => (req: any, _res: any, next: any) => { req.user = { id: 1, isAdmin: true }; next(); },
}));

const mockDb = vi.hoisted(() => ({
  sources: { getAllSources: vi.fn() },
  settings: { getSettingForSources: vi.fn() },
}));
vi.mock('../../services/database.js', () => ({ default: mockDb }));

import scriptRoutes from './scriptRoutes.js';

const app = express();
app.use(express.json());
app.use('/', scriptRoutes);

beforeAll(() => {
  // weather.py used by a Meshtastic auto-responder; orphan.sh used by nothing.
  fs.writeFileSync(
    path.join(scriptsDir, 'weather.py'),
    '# mm_meta:\n#   name: Weather\n#   version: 2.1\n#   author: Alice\nprint("hi")\n'
  );
  fs.writeFileSync(path.join(scriptsDir, 'orphan.sh'), 'echo hi\n');
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /scripts/inventory', () => {
  it('reports usedBy for referenced scripts and empty for orphans', async () => {
    mockDb.sources.getAllSources.mockResolvedValue([{ id: 'src1', name: 'Node A', type: 'meshtastic_tcp' }]);
    mockDb.settings.getSettingForSources.mockImplementation(async (_ids: string[], key: string) => {
      if (key === 'autoResponderTriggers') {
        return new Map([[
          'src1',
          JSON.stringify([
            { id: 't1', trigger: 'weather', responseType: 'script', response: '/data/scripts/weather.py' },
          ]),
        ]]);
      }
      return new Map();
    });

    const res = await request(app).get('/scripts/inventory');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const scripts: any[] = res.body.data.scripts;
    const weather = scripts.find(s => s.filename === 'weather.py');
    const orphan = scripts.find(s => s.filename === 'orphan.sh');

    expect(weather).toBeDefined();
    expect(weather.name).toBe('Weather');
    expect(weather.version).toBe('2.1');
    expect(weather.author).toBe('Alice');
    expect(typeof weather.sizeBytes).toBe('number');
    expect(typeof weather.lastModified).toBe('number');
    expect(weather.usedBy).toHaveLength(1);
    expect(weather.usedBy[0]).toMatchObject({
      type: 'auto-responder',
      protocol: 'meshtastic',
      sourceId: 'src1',
      sourceName: 'Node A',
      triggerName: 'weather',
    });

    expect(orphan).toBeDefined();
    expect(orphan.usedBy).toEqual([]);
  });

  it('works with no sources configured and skips the per-key query', async () => {
    mockDb.sources.getAllSources.mockResolvedValue([]);
    mockDb.settings.getSettingForSources.mockResolvedValue(new Map());

    const res = await request(app).get('/scripts/inventory');
    expect(res.status).toBe(200);
    expect(res.body.data.scripts.every((s: any) => s.usedBy.length === 0)).toBe(true);
    // The sourceIds.length guard must short-circuit the settings query.
    expect(mockDb.settings.getSettingForSources).not.toHaveBeenCalled();
  });

  it('returns a fail envelope when the DB throws', async () => {
    mockDb.sources.getAllSources.mockRejectedValue(new Error('boom'));

    const res = await request(app).get('/scripts/inventory');
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ success: false, code: 'SCRIPT_INVENTORY_ERROR' });
  });
});
