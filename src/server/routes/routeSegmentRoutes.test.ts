import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import routeSegmentRoutes from './routeSegmentRoutes.js';

vi.mock('../../services/database.js', () => ({
  default: {
    traceroutes: {
      getLongestActiveRouteSegment: vi.fn(),
      getRecordHolderRouteSegment: vi.fn(),
    },
    nodes: {
      getNode: vi.fn(),
    },
    clearRecordHolderSegmentAsync: vi.fn(),
  },
}));

vi.mock('../auth/authMiddleware.js', () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));

import databaseService from '../../services/database.js';

const app = express();
app.use(express.json());
app.use('/', routeSegmentRoutes);

const segment = {
  fromNodeNum: 111,
  toNodeNum: 222,
  fromNodeId: '!0000006f',
  toNodeId: '!000000de',
  distance: 42.0,
};

describe('GET /longest-active', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when no segment exists', async () => {
    (databaseService.traceroutes.getLongestActiveRouteSegment as any).mockResolvedValue(null);

    const res = await request(app).get('/longest-active');

    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });

  it('enriches segment with node names', async () => {
    (databaseService.traceroutes.getLongestActiveRouteSegment as any).mockResolvedValue(segment);
    (databaseService.nodes.getNode as any)
      .mockResolvedValueOnce({ longName: 'Alpha' })
      .mockResolvedValueOnce({ longName: 'Beta' });

    const res = await request(app).get('/longest-active');

    expect(res.status).toBe(200);
    expect(res.body.fromNodeName).toBe('Alpha');
    expect(res.body.toNodeName).toBe('Beta');
  });

  it('falls back to nodeId when node not found', async () => {
    (databaseService.traceroutes.getLongestActiveRouteSegment as any).mockResolvedValue(segment);
    (databaseService.nodes.getNode as any).mockResolvedValue(null);

    const res = await request(app).get('/longest-active');

    expect(res.body.fromNodeName).toBe('!0000006f');
    expect(res.body.toNodeName).toBe('!000000de');
  });

  it('returns 500 on database error', async () => {
    (databaseService.traceroutes.getLongestActiveRouteSegment as any).mockRejectedValue(new Error('db error'));

    const res = await request(app).get('/longest-active');

    expect(res.status).toBe(500);
  });
});

describe('GET /record-holder', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when no segment exists', async () => {
    (databaseService.traceroutes.getRecordHolderRouteSegment as any).mockResolvedValue(null);

    const res = await request(app).get('/record-holder');

    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });

  it('enriches segment with node names', async () => {
    (databaseService.traceroutes.getRecordHolderRouteSegment as any).mockResolvedValue(segment);
    (databaseService.nodes.getNode as any)
      .mockResolvedValueOnce({ longName: 'Gamma' })
      .mockResolvedValueOnce({ longName: 'Delta' });

    const res = await request(app).get('/record-holder');

    expect(res.body.fromNodeName).toBe('Gamma');
    expect(res.body.toNodeName).toBe('Delta');
  });

  it('returns 500 on database error', async () => {
    (databaseService.traceroutes.getRecordHolderRouteSegment as any).mockRejectedValue(new Error('db error'));

    const res = await request(app).get('/record-holder');

    expect(res.status).toBe(500);
  });
});

describe('DELETE /record-holder', () => {
  beforeEach(() => vi.clearAllMocks());

  it('clears the record holder and returns success', async () => {
    (databaseService.clearRecordHolderSegmentAsync as any).mockResolvedValue(undefined);

    const res = await request(app).delete('/record-holder');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('passes sourceId to database call', async () => {
    (databaseService.clearRecordHolderSegmentAsync as any).mockResolvedValue(undefined);

    await request(app).delete('/record-holder?sourceId=src1');

    expect(databaseService.clearRecordHolderSegmentAsync).toHaveBeenCalledWith('src1');
  });

  it('returns 500 on database error', async () => {
    (databaseService.clearRecordHolderSegmentAsync as any).mockRejectedValue(new Error('db error'));

    const res = await request(app).delete('/record-holder');

    expect(res.status).toBe(500);
  });
});
