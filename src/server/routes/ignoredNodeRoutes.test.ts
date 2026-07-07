import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import ignoredNodeRoutes from './ignoredNodeRoutes.js';

vi.mock('../../services/database.js', () => ({
  default: {
    ignoredNodes: {
      getIgnoredNodesAsync: vi.fn(),
      removeIgnoredNodeAsync: vi.fn(),
    },
    setNodeIgnoredAsync: vi.fn(),
  },
}));

vi.mock('../auth/authMiddleware.js', () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../utils/sourceResolver.js', () => ({
  resolveRequestSourceId: vi.fn().mockResolvedValue('default'),
}));

import databaseService from '../../services/database.js';
import { resolveRequestSourceId } from '../utils/sourceResolver.js';

const app = express();
app.use(express.json());
app.use('/', ignoredNodeRoutes);

describe('GET /', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns ignored nodes for the resolved source', async () => {
    (databaseService.ignoredNodes.getIgnoredNodesAsync as any).mockResolvedValue([
      { nodeNum: 123, sourceId: 'default' },
    ]);

    const res = await request(app).get('/');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('returns 400 when source cannot be resolved', async () => {
    (resolveRequestSourceId as any).mockResolvedValueOnce(null);

    const res = await request(app).get('/');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: 'MISSING_SOURCE_ID', error: 'No permitted source' });
    expect(typeof res.body.details).toBe('string');
  });

  it('returns 500 on database error', async () => {
    (databaseService.ignoredNodes.getIgnoredNodesAsync as any).mockRejectedValue(new Error('db error'));

    const res = await request(app).get('/');

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ success: false, code: 'INTERNAL_ERROR' });
  });
});

describe('DELETE /:nodeId', () => {
  beforeEach(() => vi.clearAllMocks());

  it('removes an ignored node and returns success', async () => {
    (databaseService.ignoredNodes.removeIgnoredNodeAsync as any).mockResolvedValue(undefined);
    (databaseService.setNodeIgnoredAsync as any).mockResolvedValue(undefined);

    const res = await request(app).delete('/!aabbccdd');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.nodeNum).toBe(0xaabbccdd);
  });

  it('returns 400 for invalid nodeId format', async () => {
    const res = await request(app).delete('/!ZZZZ');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: 'INVALID_NODE_ID', error: 'Invalid nodeId format' });
    expect(typeof res.body.details).toBe('string');
  });

  it('returns 400 when source cannot be resolved', async () => {
    (resolveRequestSourceId as any).mockResolvedValueOnce(null);

    const res = await request(app).delete('/!aabbccdd');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: 'MISSING_SOURCE_ID', error: 'No permitted source' });
    expect(typeof res.body.details).toBe('string');
  });

  it('succeeds even if setNodeIgnoredAsync throws (node not in nodes table)', async () => {
    (databaseService.ignoredNodes.removeIgnoredNodeAsync as any).mockResolvedValue(undefined);
    (databaseService.setNodeIgnoredAsync as any).mockRejectedValue(new Error('not found'));

    const res = await request(app).delete('/!aabbccdd');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('returns 500 on removeIgnoredNodeAsync error', async () => {
    (databaseService.ignoredNodes.removeIgnoredNodeAsync as any).mockRejectedValue(new Error('db error'));

    const res = await request(app).delete('/!aabbccdd');

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ success: false, code: 'INTERNAL_ERROR' });
  });
});
