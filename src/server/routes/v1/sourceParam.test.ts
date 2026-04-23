/**
 * attachSource() middleware + `default` alias tests (issue #2773 follow-up)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { attachSource } from './sourceParam.js';

// Mock the database service — attachSource only needs `sources.getAllSources`,
// `sources.getSource`, and `checkPermissionAsync`.
vi.mock('../../../services/database.js', () => {
  const _sources: any[] = [];
  const _permissions = new Map<string, boolean>();

  return {
    default: {
      sources: {
        getAllSources: vi.fn(async () => _sources.slice()),
        getSource: vi.fn(async (id: string) => _sources.find((s) => s.id === id) ?? null),
      },
      checkPermissionAsync: vi.fn(async (userId: number, resource: string, action: string, sourceId?: string) => {
        return _permissions.get(`${userId}:${resource}:${action}:${sourceId ?? ''}`) === true;
      }),
    },
    __seedSources: (sources: any[]) => {
      _sources.length = 0;
      _sources.push(...sources);
    },
    __seedPermission: (userId: number, resource: string, action: string, sourceId: string, allowed: boolean) => {
      _permissions.set(`${userId}:${resource}:${action}:${sourceId}`, allowed);
    },
    __resetPermissions: () => _permissions.clear(),
  };
});

// Dynamically-mocked seed helpers
async function getSeeds() {
  const mod = await import('../../../services/database.js');
  return mod as any;
}

function buildApp(user: any) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = user;
    next();
  });
  app.use(
    '/api/v1/sources/:sourceId/nodes',
    attachSource('nodes', 'read'),
    (req: any, res) => {
      res.json({ resolved: req.source.id, scopedParam: req.params.sourceId });
    }
  );
  return app;
}

const ADMIN = { id: 1, isAdmin: true, isActive: true };
const USER = { id: 42, isAdmin: false, isActive: true };

beforeEach(async () => {
  const seeds = await getSeeds();
  seeds.__seedSources([]);
  seeds.__resetPermissions();
  vi.clearAllMocks();
});

describe('attachSource — concrete sourceId', () => {
  it('returns 404 when the source does not exist', async () => {
    const seeds = await getSeeds();
    seeds.__seedSources([]);
    const res = await request(buildApp(ADMIN)).get('/api/v1/sources/missing/nodes');
    expect(res.status).toBe(404);
  });

  it('returns 403 when user lacks permission on the source', async () => {
    const seeds = await getSeeds();
    seeds.__seedSources([{ id: 'src-A', enabled: true, createdAt: 1 }]);
    // no permission seeded for this user
    const res = await request(buildApp(USER)).get('/api/v1/sources/src-A/nodes');
    expect(res.status).toBe(403);
  });

  it('passes through for an admin regardless of permission grant', async () => {
    const seeds = await getSeeds();
    seeds.__seedSources([{ id: 'src-A', enabled: true, createdAt: 1 }]);
    const res = await request(buildApp(ADMIN)).get('/api/v1/sources/src-A/nodes');
    expect(res.status).toBe(200);
    expect(res.body.resolved).toBe('src-A');
    expect(res.body.scopedParam).toBe('src-A');
  });

  it('passes through for a non-admin user with the matching permission', async () => {
    const seeds = await getSeeds();
    seeds.__seedSources([{ id: 'src-A', enabled: true, createdAt: 1 }]);
    seeds.__seedPermission(USER.id, 'nodes', 'read', 'src-A', true);
    const res = await request(buildApp(USER)).get('/api/v1/sources/src-A/nodes');
    expect(res.status).toBe(200);
  });
});

describe('attachSource — `default` alias', () => {
  it('resolves to the first enabled source by createdAt for admins', async () => {
    const seeds = await getSeeds();
    seeds.__seedSources([
      { id: 'src-B', enabled: true, createdAt: 10 },
      { id: 'src-A', enabled: true, createdAt: 5 },
      { id: 'src-C', enabled: false, createdAt: 1 },
    ]);
    const res = await request(buildApp(ADMIN)).get('/api/v1/sources/default/nodes');
    expect(res.status).toBe(200);
    expect(res.body.resolved).toBe('src-A');
  });

  it('resolves to the first readable source for non-admins', async () => {
    const seeds = await getSeeds();
    seeds.__seedSources([
      { id: 'src-A', enabled: true, createdAt: 1 },
      { id: 'src-B', enabled: true, createdAt: 2 },
    ]);
    // User only has permission on src-B
    seeds.__seedPermission(USER.id, 'nodes', 'read', 'src-B', true);
    const res = await request(buildApp(USER)).get('/api/v1/sources/default/nodes');
    expect(res.status).toBe(200);
    expect(res.body.resolved).toBe('src-B');
  });

  it('returns 404 when the user has permission on nothing', async () => {
    const seeds = await getSeeds();
    seeds.__seedSources([{ id: 'src-A', enabled: true, createdAt: 1 }]);
    const res = await request(buildApp(USER)).get('/api/v1/sources/default/nodes');
    expect(res.status).toBe(404);
  });

  it('returns 404 when zero sources are configured', async () => {
    const seeds = await getSeeds();
    seeds.__seedSources([]);
    const res = await request(buildApp(ADMIN)).get('/api/v1/sources/default/nodes');
    expect(res.status).toBe(404);
  });

  it('ignores disabled sources when resolving default', async () => {
    const seeds = await getSeeds();
    seeds.__seedSources([
      { id: 'src-A', enabled: false, createdAt: 1 },
      { id: 'src-B', enabled: true, createdAt: 2 },
    ]);
    const res = await request(buildApp(ADMIN)).get('/api/v1/sources/default/nodes');
    expect(res.status).toBe(200);
    expect(res.body.resolved).toBe('src-B');
  });
});
