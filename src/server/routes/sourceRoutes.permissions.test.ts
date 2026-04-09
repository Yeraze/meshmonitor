/**
 * Source Routes — per-source permission isolation tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { Express } from 'express';
import session from 'express-session';
import request from 'supertest';
import sourceRoutes from './sourceRoutes.js';
import databaseService from '../../services/database.js';

vi.mock('../../services/database.js', () => ({
  default: {
    sources: {
      getSource: vi.fn(),
      getAllSources: vi.fn(),
    },
    nodes: {
      getNode: vi.fn(),
      getAllNodes: vi.fn().mockResolvedValue([]),
      getNodesByNums: vi.fn().mockResolvedValue(new Map()),
    },
    messages: {
      getMessages: vi.fn().mockResolvedValue([]),
    },
    traceroutes: {
      getAllTraceroutes: vi.fn().mockResolvedValue([]),
    },
    neighbors: {
      getAllNeighborInfo: vi.fn().mockResolvedValue([]),
    },
    channels: {
      getAllChannels: vi.fn().mockResolvedValue([]),
    },
    settings: {
      getSetting: vi.fn().mockResolvedValue(null),
    },
    checkPermissionAsync: vi.fn(),
    findUserByIdAsync: vi.fn(),
    findUserByUsernameAsync: vi.fn(),
    getUserPermissionSetAsync: vi.fn(),
    getChannelDatabasePermissionsForUserAsSetAsync: vi.fn().mockResolvedValue({}),
  }
}));

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn().mockReturnValue(null),
    startManager: vi.fn(),
    stopManager: vi.fn(),
  }
}));

vi.mock('../meshtasticManager.js', () => ({
  MeshtasticManager: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  }))
}));

const mockDb = databaseService as any;

const normalUser = { id: 7, username: 'scoped', isActive: true, isAdmin: false };

const createApp = (): Express => {
  const app = express();
  app.use(express.json());
  app.use(session({
    secret: 'test-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
  }));
  app.use((req: any, _res, next) => {
    req.session.userId = normalUser.id;
    next();
  });
  app.use('/', sourceRoutes);
  return app;
};

describe('sourceRoutes — per-source permission isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.findUserByIdAsync.mockResolvedValue(normalUser);
    mockDb.findUserByUsernameAsync.mockResolvedValue(null);
    mockDb.getUserPermissionSetAsync.mockResolvedValue({ resources: {}, isAdmin: false });
    // User has access ONLY to sourceA — implements per-source grant simulation
    mockDb.checkPermissionAsync.mockImplementation(
      (_uid: number, _r: string, _a: string, sourceId?: string) => Promise.resolve(sourceId === 'sourceA')
    );
    mockDb.sources.getSource.mockImplementation((id: string) =>
      Promise.resolve({ id, name: id, type: 'meshtastic_tcp', enabled: true })
    );
  });

  const endpoints = ['/messages', '/nodes', '/traceroutes', '/channels', '/neighbor-info'];

  for (const ep of endpoints) {
    it(`GET /sourceA${ep} → 200 (allowed source)`, async () => {
      const res = await request(createApp()).get(`/sourceA${ep}`);
      expect(res.status).toBe(200);
    });

    it(`GET /sourceB${ep} → 403 (other source denied)`, async () => {
      const res = await request(createApp()).get(`/sourceB${ep}`);
      expect(res.status).toBe(403);
    });
  }
});
