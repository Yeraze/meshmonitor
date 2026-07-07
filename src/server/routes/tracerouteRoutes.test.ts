import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import tracerouteRoutes from './tracerouteRoutes.js';
import { ALL_SOURCES } from '../../db/repositories/index.js';

vi.mock('../../services/database.js', () => ({
  default: {
    settings: {
      getSetting: vi.fn(),
    },
    traceroutes: {
      getAllTraceroutes: vi.fn(),
      getTraceroutesByNodes: vi.fn(),
    },
  },
}));

vi.mock('../auth/authMiddleware.js', () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));

import databaseService from '../../services/database.js';

const app = express();
app.use(express.json());
app.use('/', tracerouteRoutes);

describe('GET /recent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns traceroutes with hop counts', async () => {
    (databaseService.settings.getSetting as any).mockResolvedValue(null);
    const now = Date.now();
    const traceroute = { id: 1, timestamp: now, route: JSON.stringify(['a', 'b']) };
    (databaseService.traceroutes.getAllTraceroutes as any).mockResolvedValue([traceroute]);

    const res = await request(app).get('/recent');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].hopCount).toBe(2);
  });

  it('sets hopCount=999 for invalid route JSON', async () => {
    (databaseService.settings.getSetting as any).mockResolvedValue(null);
    const now = Date.now();
    const traceroute = { id: 1, timestamp: now, route: 'not-json' };
    (databaseService.traceroutes.getAllTraceroutes as any).mockResolvedValue([traceroute]);

    const res = await request(app).get('/recent');

    expect(res.status).toBe(200);
    expect(res.body[0].hopCount).toBe(999);
  });

  it('uses explicit limit param when provided', async () => {
    (databaseService.settings.getSetting as any).mockResolvedValue(null);
    (databaseService.traceroutes.getAllTraceroutes as any).mockResolvedValue([]);

    await request(app).get('/recent?limit=42');

    expect(databaseService.traceroutes.getAllTraceroutes).toHaveBeenCalledWith(42, ALL_SOURCES);
  });

  it('filters traceroutes older than the hours window', async () => {
    (databaseService.settings.getSetting as any).mockResolvedValue(null);
    const now = Date.now();
    const old = { id: 1, timestamp: now - 48 * 60 * 60 * 1000, route: null };
    const fresh = { id: 2, timestamp: now, route: null };
    (databaseService.traceroutes.getAllTraceroutes as any).mockResolvedValue([old, fresh]);

    const res = await request(app).get('/recent?hours=24');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(2);
  });

  it('returns 500 on database error', async () => {
    (databaseService.settings.getSetting as any).mockRejectedValue(new Error('db error'));

    const res = await request(app).get('/recent');

    expect(res.status).toBe(500);
  });
});

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
