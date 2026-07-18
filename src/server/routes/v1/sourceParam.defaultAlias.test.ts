/**
 * Regression: the v1 `default` source alias must DEEP-SCOPE by the RESOLVED
 * concrete source id, not the literal string "default".
 *
 * `attachSource` normalises `req.params.sourceId` to the resolved id, but
 * Express RE-DERIVES `req.params` for the nested `mergeParams` sub-router
 * (`nodesRouter`) from the matched URL — so a handler reading
 * `req.params.sourceId` sees the raw literal "default". `req.source` is a
 * request-level property that survives, so it carries the concrete Source.
 * `getScopedSourceId` now routes through `req.source.id` first
 * (`resolvedSourceIdFromPath`).
 *
 * This test reproduces the exact production wiring from `index.ts`
 * (`attachSource` + a nested mergeParams sub-router). On the pre-fix code the
 * nodes query is scoped by "default", which matches no source and returns an
 * empty list — so the seeded-rows assertion fails (red). With the fix the
 * query is scoped by the resolved id and the rows come back (green).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const {
  CONCRETE_ID,
  SEEDED_NODES,
  getAllNodes,
  getActiveNodes,
} = vi.hoisted(() => {
  const CONCRETE_ID = 'src-primary-0001';
  const SEEDED_NODES = [
    { nodeId: '111', nodeNum: 111, longName: 'Alpha', shortName: 'ALFA', channel: 0 },
    { nodeId: '222', nodeNum: 222, longName: 'Bravo', shortName: 'BRVO', channel: 0 },
  ];
  // Only the concrete id yields rows — "default" (the raw URL literal) yields none.
  const getAllNodes = vi.fn(async (sourceId?: string) =>
    sourceId === CONCRETE_ID ? SEEDED_NODES.slice() : []
  );
  const getActiveNodes = vi.fn(async (_days: number, sourceId?: string) =>
    sourceId === CONCRETE_ID ? SEEDED_NODES.slice() : []
  );
  return { CONCRETE_ID, SEEDED_NODES, getAllNodes, getActiveNodes };
});

vi.mock('../../../services/database.js', () => ({
  default: {
    sources: {
      getAllSources: vi.fn(async () => [{ id: CONCRETE_ID, enabled: true, createdAt: 1 }]),
      getSource: vi.fn(async (id: string) =>
        id === CONCRETE_ID ? { id: CONCRETE_ID, enabled: true, createdAt: 1 } : null
      ),
    },
    checkPermissionAsync: vi.fn(async () => true),
    nodes: { getAllNodes, getActiveNodes },
    telemetry: {
      getLatestTelemetryValueForAllNodes: vi.fn(async () => new Map()),
    },
  },
}));

// Pass-through channel enrichment so the seeded rows survive to the response.
vi.mock('../../utils/nodeEnhancer.js', () => ({
  filterNodesByChannelPermission: vi.fn(async (nodes: unknown[]) => nodes),
  maskNodeLocationByChannel: vi.fn(async (nodes: unknown[]) => nodes),
  checkNodeChannelAccess: vi.fn(async () => true),
  getEffectiveDbNodePosition: vi.fn(() => null),
}));

// Import after mocks
import { attachSource } from './sourceParam.js';
import nodesRouter from './nodes.js';
import positionHistoryRouter from './positionHistory.js';

function buildApp(user: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: unknown }).user = user;
    next();
  });
  // Exact production wiring from index.ts — attachSource then nested routers.
  app.use(
    '/api/v1/sources/:sourceId/nodes',
    attachSource('nodes', 'read'),
    positionHistoryRouter,
    nodesRouter
  );
  return app;
}

const ADMIN = { id: 1, isAdmin: true, isActive: true };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('v1 `default` source alias deep-scoping (regression)', () => {
  it('scopes the nodes query by the resolved concrete id, not the literal "default"', async () => {
    const res = await request(buildApp(ADMIN)).get('/api/v1/sources/default/nodes');

    expect(res.status).toBe(200);
    // The handler must return the seeded rows for the RESOLVED source. On the
    // pre-fix code this is [] because the query was scoped by "default".
    expect(res.body.data).toHaveLength(SEEDED_NODES.length);
    expect(res.body.data.map((n: { nodeId: string }) => n.nodeId).sort()).toEqual(['111', '222']);
    // And it must have deep-scoped by the concrete id, never the literal alias.
    expect(getAllNodes).toHaveBeenCalledWith(CONCRETE_ID);
    expect(getAllNodes).not.toHaveBeenCalledWith('default');
  });

  it('still deep-scopes correctly when the concrete id is used directly', async () => {
    const res = await request(buildApp(ADMIN)).get(`/api/v1/sources/${CONCRETE_ID}/nodes`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(SEEDED_NODES.length);
    expect(getAllNodes).toHaveBeenCalledWith(CONCRETE_ID);
  });
});
