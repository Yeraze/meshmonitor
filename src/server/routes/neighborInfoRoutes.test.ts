import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import neighborInfoRoutes from './neighborInfoRoutes.js';

vi.mock('../../services/database.js', () => ({
  default: {
    settings: {
      getSetting: vi.fn(),
    },
    nodes: {
      getNode: vi.fn(),
    },
    getLatestNeighborInfoPerNodeScoped: vi.fn(),
    getLatestNeighborInfoPerNodeScopedAsync: vi.fn(),
    getNeighborsForNodeAsync: vi.fn(),
  },
}));

vi.mock('../auth/authMiddleware.js', () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../utils/nodeEnhancer.js', () => ({
  getEffectiveDbNodePosition: vi.fn().mockReturnValue({ latitude: 1.0, longitude: 2.0 }),
}));

import databaseService from '../../services/database.js';

const app = express();
app.use(express.json());
app.use('/', neighborInfoRoutes);

const now = Math.floor(Date.now() / 1000);

describe('GET /', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns enriched neighbor info', async () => {
    (databaseService.settings.getSetting as any).mockResolvedValue('24');
    const ni = {
      nodeNum: 111,
      neighborNodeNum: 222,
      timestamp: now * 1000,
      lastRxTime: now,
    };
    (databaseService.getLatestNeighborInfoPerNodeScopedAsync as any).mockResolvedValue([ni]);
    (databaseService.nodes.getNode as any)
      .mockResolvedValueOnce({ nodeId: '!0000006f', longName: 'Alpha', lastHeard: now })
      .mockResolvedValueOnce({ nodeId: '!000000de', longName: 'Beta', lastHeard: now });

    const res = await request(app).get('/');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].nodeName).toBe('Alpha');
    expect(res.body[0].neighborName).toBe('Beta');
  });

  it('filters out nodes older than maxNodeAge', async () => {
    (databaseService.settings.getSetting as any).mockResolvedValue('24');
    const oldTime = now - 25 * 3600;
    const ni = {
      nodeNum: 111,
      neighborNodeNum: 222,
      timestamp: oldTime * 1000,
      lastRxTime: oldTime,
    };
    (databaseService.getLatestNeighborInfoPerNodeScopedAsync as any).mockResolvedValue([ni]);
    (databaseService.nodes.getNode as any)
      .mockResolvedValueOnce({ nodeId: '!0000006f', longName: 'Old', lastHeard: oldTime })
      .mockResolvedValueOnce({ nodeId: '!000000de', longName: 'Beta', lastHeard: now });

    const res = await request(app).get('/');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });

  it('marks links as bidirectional when reverse link exists', async () => {
    (databaseService.settings.getSetting as any).mockResolvedValue('24');
    const ni1 = { nodeNum: 111, neighborNodeNum: 222, timestamp: now * 1000, lastRxTime: now };
    const ni2 = { nodeNum: 222, neighborNodeNum: 111, timestamp: now * 1000, lastRxTime: now };
    (databaseService.getLatestNeighborInfoPerNodeScopedAsync as any).mockResolvedValue([ni1, ni2]);
    (databaseService.nodes.getNode as any).mockResolvedValue({
      nodeId: '!0000006f', longName: 'Node', lastHeard: now,
    });

    const res = await request(app).get('/');

    expect(res.status).toBe(200);
    expect(res.body[0].bidirectional).toBe(true);
  });

  it('returns 500 on database error', async () => {
    (databaseService.settings.getSetting as any).mockRejectedValue(new Error('db error'));
    (databaseService.getLatestNeighborInfoPerNodeScopedAsync as any).mockResolvedValue([]);

    const res = await request(app).get('/');

    expect(res.status).toBe(500);
  });
});

describe('GET /:nodeNum', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns enriched neighbor list for a node', async () => {
    const ni = { neighborNodeNum: 222 };
    (databaseService.getNeighborsForNodeAsync as any).mockResolvedValue([ni]);
    (databaseService.nodes.getNode as any).mockResolvedValue({
      nodeId: '!000000de', longName: 'Beta',
    });

    const res = await request(app).get('/111?sourceId=src-A');

    expect(res.status).toBe(200);
    expect(res.body[0].neighborName).toBe('Beta');
    expect(res.body[0].neighborLatitude).toBe(1.0);
  });

  it('falls back to hex id when node not found', async () => {
    (databaseService.getNeighborsForNodeAsync as any).mockResolvedValue([{ neighborNodeNum: 0xdeadbeef }]);
    (databaseService.nodes.getNode as any).mockResolvedValue(null);

    const res = await request(app).get('/111?sourceId=src-A');

    expect(res.body[0].neighborNodeId).toBe('!deadbeef');
  });

  it('returns 500 on database error', async () => {
    (databaseService.getNeighborsForNodeAsync as any).mockRejectedValue(new Error('db error'));

    const res = await request(app).get('/111?sourceId=src-A');

    expect(res.status).toBe(500);
  });

  it('400s when sourceId is omitted', async () => {
    const res = await request(app).get('/111');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_SOURCE_ID');
  });
});
