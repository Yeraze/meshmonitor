/**
 * System Routes Tests
 *
 * Tests /system/status, /status, /version/check and /system/restart, plus the
 * gracefulShutdown callback injection.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const mockManager = vi.hoisted(() => ({
  getConnectionStatus: vi.fn(),
  getLocalNodeInfo: vi.fn(),
}));
vi.mock('../meshtasticManager.js', () => ({
  fallbackManager: mockManager,
}));

// No primary meshtastic_tcp source registered — falls through to
// fallbackManager above (#3962 Phase 4.2a WP4).
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {},
}));

vi.mock('../sourceManagerTypes.js', () => ({
  getPrimaryMeshtasticManager: () => undefined,
}));

const mockDb = vi.hoisted(() => ({
  getDatabaseType: vi.fn().mockReturnValue('sqlite'),
  getDatabaseVersion: vi.fn().mockResolvedValue('3.45.0'),
  nodes: { getNodeCount: vi.fn().mockResolvedValue(5) },
  messages: { getMessageCount: vi.fn().mockResolvedValue(10) },
  channels: { getChannelCount: vi.fn().mockResolvedValue(3) },
  settings: { getSetting: vi.fn() },
  auditLogAsync: vi.fn(),
}));
vi.mock('../../services/database.js', () => ({
  default: mockDb,
}));

const mockVersionCheckService = vi.hoisted(() => ({
  getStatus: vi.fn(),
}));
vi.mock('../services/versionCheckService.js', () => ({
  versionCheckService: mockVersionCheckService,
}));

const mockDeployment = vi.hoisted(() => ({
  detectDeploymentMethod: vi.fn().mockReturnValue('docker'),
}));
vi.mock('../utils/deployment.js', () => mockDeployment);

const mockEnv = vi.hoisted(() => ({ nodeEnv: 'test', versionCheckDisabled: false }));
vi.mock('../config/environment.js', () => ({
  getEnvironmentConfig: vi.fn(() => mockEnv),
}));

const mockSystemInfo = vi.hoisted(() => ({
  serverStartTime: Date.now() - 5000,
  isRunningInDocker: vi.fn().mockReturnValue(false),
}));
vi.mock('../utils/systemInfo.js', () => mockSystemInfo);

vi.mock('../auth/authMiddleware.js', () => ({
  optionalAuth: () => (req: any, _res: any, next: any) => { req.session = req.session || {}; next(); },
  requirePermission: () => (req: any, _res: any, next: any) => { req.user = { id: 1, isAdmin: true }; next(); },
}));

import systemRoutes, { setSystemCallbacks } from './systemRoutes.js';

const app = express();
app.use(express.json());
app.use('/', systemRoutes);

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.versionCheckDisabled = false;
  mockSystemInfo.isRunningInDocker.mockReturnValue(false);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /system/status', () => {
  it('returns system info with capitalised db type and docker flag', async () => {
    mockSystemInfo.isRunningInDocker.mockReturnValue(true);
    const res = await request(app).get('/system/status');
    expect(res.status).toBe(200);
    expect(res.body.database).toEqual({ type: 'Sqlite', version: '3.45.0' });
    expect(res.body.isDocker).toBe(true);
    expect(res.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});

describe('GET /status', () => {
  it('reports connection and statistics', async () => {
    mockManager.getConnectionStatus.mockResolvedValue({ connected: true });
    mockManager.getLocalNodeInfo.mockReturnValue({ nodeNum: 1, nodeId: '!1', longName: 'A', shortName: 'A' });
    const res = await request(app).get('/status');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.connection.connected).toBe(true);
    expect(res.body.connection.localNode.nodeNum).toBe(1);
    expect(res.body.statistics).toEqual({ nodes: 5, messages: 10, channels: 3 });
  });

  it('returns null localNode when none present', async () => {
    mockManager.getConnectionStatus.mockResolvedValue({ connected: false });
    mockManager.getLocalNodeInfo.mockReturnValue(null);
    const res = await request(app).get('/status');
    expect(res.status).toBe(200);
    expect(res.body.connection.localNode).toBeNull();
  });
});

describe('GET /version/check', () => {
  it('returns 404 when version check is disabled', async () => {
    mockEnv.versionCheckDisabled = true;
    const res = await request(app).get('/version/check');
    expect(res.status).toBe(404);
  });

  it('handles version-check failure gracefully (bare shape + deploymentMethod)', async () => {
    mockVersionCheckService.getStatus.mockResolvedValue({
      updateAvailable: false,
      currentVersion: '1.0.0',
      latestVersion: null,
      releaseUrl: null,
      releaseName: null,
      publishedAt: null,
      imageReady: false,
      checkedAt: Date.now(),
      error: 'Unable to check for updates',
    });
    const res = await request(app).get('/version/check');
    expect(res.status).toBe(200);
    expect(res.body.updateAvailable).toBe(false);
    expect(res.body.error).toBe('Unable to check for updates');
    expect(res.body.deploymentMethod).toBe('docker');
  });

  it('reports an available update with deploymentMethod and no autoUpgradeTriggered field', async () => {
    mockDeployment.detectDeploymentMethod.mockReturnValue('lxc');
    mockVersionCheckService.getStatus.mockResolvedValue({
      updateAvailable: true,
      currentVersion: '1.0.0',
      latestVersion: '9.9.9',
      releaseUrl: 'https://example/release',
      releaseName: 'Release',
      publishedAt: '2026-01-01T00:00:00Z',
      imageReady: true,
      checkedAt: Date.now(),
    });

    const res = await request(app).get('/version/check');
    expect(res.status).toBe(200);
    expect(res.body.updateAvailable).toBe(true);
    expect(res.body.latestVersion).toBe('9.9.9');
    expect(res.body.imageReady).toBe(true);
    expect(res.body.deploymentMethod).toBe('lxc');
    expect(res.body).not.toHaveProperty('autoUpgradeTriggered');
  });
});

describe('POST /system/restart', () => {
  it('returns restart action and invokes gracefulShutdown in Docker', async () => {
    vi.useFakeTimers();
    const gracefulShutdown = vi.fn();
    setSystemCallbacks({ gracefulShutdown });
    mockSystemInfo.isRunningInDocker.mockReturnValue(true);

    const res = await request(app).post('/system/restart').send({});
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('restart');
    vi.advanceTimersByTime(500);
    expect(gracefulShutdown).toHaveBeenCalledWith('Admin-requested container restart');
  });

  it('returns shutdown action when not in Docker', async () => {
    vi.useFakeTimers();
    const gracefulShutdown = vi.fn();
    setSystemCallbacks({ gracefulShutdown });
    mockSystemInfo.isRunningInDocker.mockReturnValue(false);

    const res = await request(app).post('/system/restart').send({});
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('shutdown');
    vi.advanceTimersByTime(500);
    expect(gracefulShutdown).toHaveBeenCalledWith('Admin-requested shutdown');
  });
});
