import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const mockDb = vi.hoisted(() => ({
  messages: { getMessageCount: vi.fn() },
  nodes: { getNodeCount: vi.fn() },
  channels: { getChannelCount: vi.fn() },
  getMessagesByDayAsync: vi.fn(),
  exportDataAsync: vi.fn(),
  importDataAsync: vi.fn(),
}));

vi.mock('../../services/database.js', () => ({
  default: mockDb,
}));

vi.mock('../auth/authMiddleware.js', () => ({
  requirePermission: () => (req: any, _res: any, next: any) => { req.user = { id: 1, isAdmin: true }; next(); },
  requireAdmin: () => (req: any, _res: any, next: any) => { req.user = { id: 1, isAdmin: true }; next(); },
}));

import dataExchangeRoutes from './dataExchangeRoutes.js';

const app = express();
app.use(express.json());
app.use('/', dataExchangeRoutes);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /stats', () => {
  it('aggregates counts scoped by sourceId', async () => {
    mockDb.messages.getMessageCount.mockResolvedValue(10);
    mockDb.nodes.getNodeCount.mockResolvedValue(5);
    mockDb.channels.getChannelCount.mockResolvedValue(3);
    mockDb.getMessagesByDayAsync.mockResolvedValue([{ date: '2026-01-01', count: 2 }]);

    const res = await request(app).get('/stats?sourceId=src-1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      messageCount: 10,
      nodeCount: 5,
      channelCount: 3,
      messagesByDay: [{ date: '2026-01-01', count: 2 }],
    });
    expect(mockDb.messages.getMessageCount).toHaveBeenCalledWith('src-1');
    expect(mockDb.getMessagesByDayAsync).toHaveBeenCalledWith(7, 'src-1');
  });

  it('returns 500 when a count throws', async () => {
    mockDb.messages.getMessageCount.mockRejectedValue(new Error('boom'));
    const res = await request(app).get('/stats');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch stats');
  });
});

describe('POST /export', () => {
  it('returns the exported payload', async () => {
    mockDb.exportDataAsync.mockResolvedValue({ nodes: [], messages: [] });
    const res = await request(app).post('/export').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ nodes: [], messages: [] });
  });

  it('returns 500 on export failure', async () => {
    mockDb.exportDataAsync.mockRejectedValue(new Error('fail'));
    const res = await request(app).post('/export').send({});
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to export data');
  });
});

describe('POST /import', () => {
  it('imports the request body and returns success', async () => {
    mockDb.importDataAsync.mockResolvedValue(undefined);
    const payload = { nodes: [{ nodeNum: 1 }], messages: [] };
    const res = await request(app).post('/import').send(payload);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(mockDb.importDataAsync).toHaveBeenCalledWith(payload);
  });

  it('returns 500 on import failure', async () => {
    mockDb.importDataAsync.mockRejectedValue(new Error('fail'));
    const res = await request(app).post('/import').send({});
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to import data');
  });
});
