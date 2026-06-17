import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../config/environment.js', () => ({
  getEnvironmentConfig: vi.fn().mockReturnValue({ isDevelopment: false }),
}));

vi.mock('../utils/scriptRunner.js', () => ({
  scriptDependencyEnv: vi.fn().mockReturnValue({}),
}));

vi.mock('../../utils/autoResponderUtils.js', () => ({
  normalizeTriggerPatterns: vi.fn((t: any) => (Array.isArray(t) ? t : [t])),
}));

const mockSafeFetch = vi.hoisted(() => vi.fn());
const MockSsrfBlockedError = vi.hoisted(() => class SsrfBlockedError extends Error {
  reason: string;
  constructor(reason: string) {
    super('blocked');
    this.reason = reason;
  }
});
vi.mock('../utils/ssrfGuard.js', () => ({
  safeFetch: mockSafeFetch,
  SsrfBlockedError: MockSsrfBlockedError,
}));

const mockDeps = vi.hoisted(() => ({
  getDependencyStatus: vi.fn(),
  installDependencies: vi.fn(),
}));
vi.mock('../services/scriptDependencyService.js', () => mockDeps);

vi.mock('../auth/authMiddleware.js', () => ({
  requirePermission: () => (req: any, _res: any, next: any) => { req.user = { id: 1, isAdmin: true }; next(); },
}));

// fs is exercised only by paths we don't reach in these validation-focused tests.
import scriptRoutes, { scriptsEndpoint } from './scriptRoutes.js';

const app = express();
app.use(express.json());
app.use('/', scriptRoutes);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /scripts/test validation', () => {
  it('rejects an invalid triggerType', async () => {
    const res = await request(app).post('/scripts/test').send({ triggerType: 'bogus', script: '/data/scripts/x.py' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid triggerType');
  });

  it('rejects missing auto-responder fields', async () => {
    const res = await request(app).post('/scripts/test').send({ triggerType: 'auto-responder', script: '/data/scripts/x.py' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Missing required fields');
  });

  it('rejects a script path outside /data/scripts', async () => {
    const res = await request(app)
      .post('/scripts/test')
      .send({ triggerType: 'timer', script: '/etc/passwd' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid script path');
  });

  it('rejects path traversal in the script path', async () => {
    const res = await request(app)
      .post('/scripts/test')
      .send({ triggerType: 'timer', script: '/data/scripts/../../etc/passwd' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid script path');
  });
});

describe('POST /http/test', () => {
  it('rejects a missing url', async () => {
    const res = await request(app).post('/http/test').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('url');
  });

  it('rejects an invalid url format', async () => {
    const res = await request(app).post('/http/test').send({ url: 'not a url' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid URL format');
  });

  it('rejects non-http(s) protocols', async () => {
    const res = await request(app).post('/http/test').send({ url: 'ftp://example.com/file' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('HTTP and HTTPS');
  });

  it('proxies a successful fetch and truncates output', async () => {
    mockSafeFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => 'hello world',
    });
    const res = await request(app).post('/http/test').send({ url: 'https://example.com/data' });
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('hello world');
    expect(res.body.status).toBe(200);
  });

  it('maps an SSRF-blocked fetch to 400', async () => {
    mockSafeFetch.mockRejectedValue(new MockSsrfBlockedError('private-ip'));
    const res = await request(app).post('/http/test').send({ url: 'https://169.254.169.254/' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('URL target not allowed');
  });
});

describe('POST /scripts/import validation', () => {
  it('rejects a missing x-filename header', async () => {
    const res = await request(app)
      .post('/scripts/import')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('print(1)'));
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Filename header');
  });

  it('rejects an invalid extension', async () => {
    const res = await request(app)
      .post('/scripts/import')
      .set('Content-Type', 'application/octet-stream')
      .set('x-filename', 'evil.exe')
      .send(Buffer.from('x'));
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid file extension');
  });

  it('refuses to overwrite the system upgrade script', async () => {
    const res = await request(app)
      .post('/scripts/import')
      .set('Content-Type', 'application/octet-stream')
      .set('x-filename', 'upgrade-watchdog.sh')
      .send(Buffer.from('x'));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Cannot overwrite system script');
  });
});

describe('POST /scripts/export validation', () => {
  it('rejects a non-array scripts payload', async () => {
    const res = await request(app).post('/scripts/export').send({ scripts: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Scripts array is required');
  });

  it('rejects an empty scripts array', async () => {
    const res = await request(app).post('/scripts/export').send({ scripts: [] });
    expect(res.status).toBe(400);
  });
});

describe('script dependency endpoints', () => {
  it('returns dependency status', async () => {
    mockDeps.getDependencyStatus.mockResolvedValue({ python: { declared: false } });
    const res = await request(app).get('/scripts/dependencies');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ python: { declared: false } });
  });

  it('installs dependencies and maps failure to 400', async () => {
    mockDeps.installDependencies.mockResolvedValue({ success: false, log: 'err' });
    const res = await request(app).post('/scripts/dependencies/install').send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('installs dependencies and returns 200 on success', async () => {
    mockDeps.installDependencies.mockResolvedValue({ success: true, log: 'ok' });
    const res = await request(app).post('/scripts/dependencies/install').send({});
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('DELETE /scripts/:filename', () => {
  it('refuses to delete the system upgrade script', async () => {
    const res = await request(app).delete('/scripts/upgrade-watchdog.sh');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Cannot delete system script');
  });
});

describe('scriptsEndpoint export', () => {
  it('is exported as a function', () => {
    expect(typeof scriptsEndpoint).toBe('function');
  });
});
