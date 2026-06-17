import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const mockManager = vi.hoisted(() => ({
  getConnectionStatus: vi.fn(),
  userDisconnect: vi.fn(),
  userReconnect: vi.fn(),
  setNodeIpOverride: vi.fn(),
}));

const mockRegistry = vi.hoisted(() => ({
  getManager: vi.fn().mockReturnValue(mockManager),
}));

vi.mock('../utils/resolveSourceManager.js', () => ({
  resolveSourceManager: vi.fn().mockReturnValue(mockManager),
}));

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: mockRegistry,
}));

vi.mock('../config/environment.js', () => ({
  getEnvironmentConfig: vi.fn().mockReturnValue({ meshtasticNodeIp: '1.2.3.4', meshtasticTcpPort: 4403 }),
}));

vi.mock('../../services/database.js', () => ({
  default: {
    settings: {
      getSetting: vi.fn(),
    },
    auditLogAsync: vi.fn(),
  },
}));

vi.mock('../auth/authMiddleware.js', () => ({
  optionalAuth: () => (req: any, _res: any, next: any) => { req.session = req.session || {}; next(); },
  requireAuth: () => (req: any, _res: any, next: any) => { req.user = { id: 1, isAdmin: true }; next(); },
  requirePermission: () => (req: any, _res: any, next: any) => { req.user = { id: 1, isAdmin: true }; next(); },
  requireAdmin: () => (req: any, _res: any, next: any) => { req.user = { id: 1, isAdmin: true }; next(); },
}));

import databaseService from '../../services/database.js';
import connectionRoutes from './connectionRoutes.js';

const app = express();
app.use(express.json());
// minimal session shim so the anonymous-vs-authed branch in GET / works
app.use((req: any, _res, next) => { req.session = req.session || {}; next(); });
app.use('/connection', connectionRoutes);

beforeEach(() => {
  vi.clearAllMocks();
  mockRegistry.getManager.mockReturnValue(mockManager);
});

describe('GET /connection', () => {
  it('returns not-connected stub for an unregistered explicit source', async () => {
    mockRegistry.getManager.mockReturnValue(undefined);
    const res = await request(app).get('/connection?sourceId=missing');
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(false);
  });

  it('hides nodeIp from anonymous users', async () => {
    mockManager.getConnectionStatus.mockResolvedValue({ connected: true, nodeIp: '10.0.0.1' });
    const res = await request(app).get('/connection');
    expect(res.status).toBe(200);
    expect(res.body.nodeIp).toBeUndefined();
    expect(res.body.connected).toBe(true);
  });
});

describe('POST /connection/disconnect', () => {
  it('disconnects and audit logs', async () => {
    mockManager.userDisconnect.mockResolvedValue(undefined);
    const res = await request(app).post('/connection/disconnect').send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('user-disconnected');
    expect(databaseService.auditLogAsync).toHaveBeenCalled();
  });
});

describe('POST /connection/reconnect', () => {
  it('reports connecting on success', async () => {
    mockManager.userReconnect.mockResolvedValue(true);
    const res = await request(app).post('/connection/reconnect').send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('connecting');
  });
});

describe('GET /connection/info', () => {
  it('returns status plus defaults', async () => {
    mockManager.getConnectionStatus.mockResolvedValue({ connected: true });
    (databaseService.settings.getSetting as any).mockResolvedValue(null);
    const res = await request(app).get('/connection/info');
    expect(res.status).toBe(200);
    expect(res.body.defaultIp).toBe('1.2.3.4');
    expect(res.body.isOverridden).toBe(false);
  });
});

describe('POST /connection/configure', () => {
  it('rejects an invalid address', async () => {
    const res = await request(app).post('/connection/configure').send({ nodeIp: 'not a host!!' });
    expect(res.status).toBe(400);
  });

  it('rejects out-of-range port', async () => {
    const res = await request(app).post('/connection/configure').send({ nodeIp: '10.0.0.1:99999' });
    expect(res.status).toBe(400);
  });

  it('accepts a valid address', async () => {
    mockManager.setNodeIpOverride.mockResolvedValue(undefined);
    const res = await request(app).post('/connection/configure').send({ nodeIp: '10.0.0.1:4403' });
    expect(res.status).toBe(200);
    expect(mockManager.setNodeIpOverride).toHaveBeenCalledWith('10.0.0.1:4403');
  });
});
