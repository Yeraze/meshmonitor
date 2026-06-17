import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const mockManager = vi.hoisted(() => ({
  getAirtimeCutoffStatus: vi.fn(),
}));

const mockRegistry = vi.hoisted(() => ({
  getAllManagers: vi.fn(),
}));

vi.mock('../utils/resolveSourceManager.js', () => ({
  resolveSourceManager: vi.fn().mockReturnValue(mockManager),
}));

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: mockRegistry,
}));

vi.mock('../auth/authMiddleware.js', () => ({
  requireAuth: () => (req: any, _res: any, next: any) => { req.user = { id: 1, isAdmin: true }; next(); },
  requirePermission: () => (req: any, _res: any, next: any) => { req.user = { id: 1, isAdmin: true }; next(); },
}));

import statusRoutes from './statusRoutes.js';

const app = express();
app.use(express.json());
app.use('/', statusRoutes);

beforeEach(() => vi.clearAllMocks());

describe('GET /virtual-node/status', () => {
  it('reports disabled sources with no virtualNodeServer', async () => {
    mockRegistry.getAllManagers.mockReturnValue([
      { sourceId: 's1', getStatus: () => ({ sourceId: 's1', sourceName: 'One' }), virtualNodeServer: null },
    ]);
    const res = await request(app).get('/virtual-node/status');
    expect(res.status).toBe(200);
    expect(res.body.sources).toHaveLength(1);
    expect(res.body.sources[0].enabled).toBe(false);
  });

  it('reports running virtual node details', async () => {
    mockRegistry.getAllManagers.mockReturnValue([
      {
        sourceId: 's1',
        getStatus: () => ({ sourceId: 's1', sourceName: 'One' }),
        virtualNodeServer: {
          isRunning: () => true,
          isAdminCommandsAllowed: () => true,
          getClientCount: () => 2,
          getClientDetails: () => [{ id: 'c1' }],
        },
      },
    ]);
    const res = await request(app).get('/virtual-node/status');
    expect(res.body.sources[0].enabled).toBe(true);
    expect(res.body.sources[0].isRunning).toBe(true);
    expect(res.body.sources[0].clientCount).toBe(2);
  });
});

describe('GET /automation/airtime-status', () => {
  it('returns the airtime cutoff status', async () => {
    mockManager.getAirtimeCutoffStatus.mockResolvedValue({ paused: false, utilization: 12.5 });
    const res = await request(app).get('/automation/airtime-status');
    expect(res.status).toBe(200);
    expect(res.body.utilization).toBe(12.5);
  });
});
