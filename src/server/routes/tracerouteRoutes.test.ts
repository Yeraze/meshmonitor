import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import tracerouteRoutes from './tracerouteRoutes.js';

vi.mock('../../services/database.js', () => ({
  default: {
    settings: {
      getSetting: vi.fn(),
      getSettingForSource: vi.fn(),
    },
    traceroutes: {
      getAllTraceroutes: vi.fn(),
      getTraceroutesByNodes: vi.fn(),
    },
  },
}));

vi.mock('../auth/authMiddleware.js', () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
  optionalAuth: () => (_req: any, _res: any, next: any) => next(),
}));

import databaseService from '../../services/database.js';

const app = express();
app.use(express.json());
app.use('/', tracerouteRoutes);

// GET /recent is covered against real permission rows in
// tracerouteRoutes.recentScope.test.ts (route test harness).

describe('GET /history/:fromNodeNum/:toNodeNum', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns traceroutes with hop counts', async () => {
    const traceroute = { id: 1, route: JSON.stringify(['x']) };
    (databaseService.traceroutes.getTraceroutesByNodes as any).mockResolvedValue([traceroute]);

    const res = await request(app).get('/history/12345/67890');

    expect(res.status).toBe(200);
    expect(res.body[0].hopCount).toBe(1);
  });

  it('returns 400 for non-numeric node numbers', async () => {
    const res = await request(app).get('/history/abc/67890');

    expect(res.status).toBe(400);
  });

  it('returns 400 for node number out of range', async () => {
    const res = await request(app).get('/history/99999999999/67890');

    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid limit', async () => {
    const res = await request(app).get('/history/12345/67890?limit=9999');

    expect(res.status).toBe(400);
  });

  it('passes sourceId to database query', async () => {
    (databaseService.traceroutes.getTraceroutesByNodes as any).mockResolvedValue([]);

    await request(app).get('/history/12345/67890?sourceId=src1');

    expect(databaseService.traceroutes.getTraceroutesByNodes).toHaveBeenCalledWith(
      12345, 67890, 50, 'src1'
    );
  });

  it('returns 500 on database error', async () => {
    (databaseService.traceroutes.getTraceroutesByNodes as any).mockRejectedValue(new Error('db error'));

    const res = await request(app).get('/history/12345/67890');

    expect(res.status).toBe(500);
  });
});
