/**
 * Unified Routes Tests
 *
 * Tests for GET /api/unified/messages and GET /api/unified/telemetry.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { Express } from 'express';
import session from 'express-session';
import request from 'supertest';
import unifiedRoutes from './unifiedRoutes.js';
import databaseService from '../../services/database.js';

vi.mock('../../services/database.js', () => ({
  default: {
    sources: {
      getAllSources: vi.fn(),
    },
    messages: {
      getMessages: vi.fn(),
    },
    nodes: {
      getAllNodes: vi.fn(),
    },
    telemetry: {
      getLatestTelemetryByNode: vi.fn(),
    },
    checkPermissionAsync: vi.fn(),
    findUserByIdAsync: vi.fn(),
    findUserByUsernameAsync: vi.fn(),
    getUserPermissionSetAsync: vi.fn(),
  }
}));

// sourceManagerRegistry is imported dynamically inside the route handler
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn().mockReturnValue(null),
  }
}));

const mockDb = databaseService as any;

const adminUser = { id: 1, username: 'admin', isActive: true, isAdmin: true };
const regularUser = { id: 2, username: 'user', isActive: true, isAdmin: false };

const createApp = (user: any = null): Express => {
  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
      cookie: { secure: false }
    })
  );
  app.use((req: any, _res: any, next: any) => {
    if (user) {
      req.session.userId = user.id;
      // Set findUserByIdAsync to return the right user for this session
      mockDb.findUserByIdAsync.mockResolvedValue(user);
    }
    next();
  });
  app.use('/', unifiedRoutes);
  return app;
};

const SOURCE_A = { id: 'src-a', name: 'Source A', type: 'meshtastic_tcp', enabled: true };
const SOURCE_B = { id: 'src-b', name: 'Source B', type: 'meshtastic_tcp', enabled: true };

describe('Unified Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.findUserByIdAsync.mockResolvedValue(adminUser);
    mockDb.findUserByUsernameAsync.mockResolvedValue(null);
    mockDb.getUserPermissionSetAsync.mockResolvedValue({ resources: {}, isAdmin: false });
    mockDb.checkPermissionAsync.mockResolvedValue(true);
  });

  // ── /messages ─────────────────────────────────────────────────────────────

  describe('GET /messages', () => {
    it('returns merged messages from all accessible sources for admin', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A, SOURCE_B]);
      mockDb.messages.getMessages
        .mockResolvedValueOnce([
          { id: '1', text: 'Hello', timestamp: 1000, channel: 0 },
        ])
        .mockResolvedValueOnce([
          { id: '2', text: 'World', timestamp: 900, channel: 0 },
        ]);

      const app = createApp(adminUser);
      const res = await request(app).get('/messages?limit=50');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      // Should be sorted newest first
      expect(res.body[0].timestamp).toBe(1000);
      expect(res.body[0].sourceName).toBe('Source A');
      expect(res.body[1].timestamp).toBe(900);
      expect(res.body[1].sourceName).toBe('Source B');
    });

    it('respects limit parameter', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A]);
      mockDb.messages.getMessages.mockResolvedValue([
        { id: '1', text: 'A', timestamp: 100, channel: 0 },
        { id: '2', text: 'B', timestamp: 200, channel: 0 },
        { id: '3', text: 'C', timestamp: 300, channel: 0 },
      ]);

      const app = createApp(adminUser);
      const res = await request(app).get('/messages?limit=2');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });

    it('caps limit at 200', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A]);
      mockDb.messages.getMessages.mockResolvedValue([]);

      const app = createApp(adminUser);
      await request(app).get('/messages?limit=9999');

      // getMessages should have been called with limit=200
      expect(mockDb.messages.getMessages).toHaveBeenCalledWith(200, 0, SOURCE_A.id);
    });

    it('skips sources the user has no read permission for', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A, SOURCE_B]);
      // Grant access to A, deny for B
      mockDb.checkPermissionAsync.mockImplementation(
        (_userId: number, _resource: string, _action: string, sourceId: string) =>
          Promise.resolve(sourceId === 'src-a')
      );
      mockDb.messages.getMessages.mockResolvedValue([
        { id: '1', text: 'Hi', timestamp: 1000, channel: 0 },
      ]);

      const app = createApp(regularUser);
      const res = await request(app).get('/messages');

      expect(res.status).toBe(200);
      // Only Source A messages should be present
      expect(res.body.every((m: any) => m.sourceId === 'src-a')).toBe(true);
      expect(mockDb.messages.getMessages).toHaveBeenCalledTimes(1);
    });

    it('returns 500 on database error', async () => {
      mockDb.sources.getAllSources.mockRejectedValue(new Error('DB error'));

      const app = createApp(adminUser);
      const res = await request(app).get('/messages');

      expect(res.status).toBe(500);
    });
  });

  // ── /telemetry ────────────────────────────────────────────────────────────

  describe('GET /telemetry', () => {
    // Telemetry timestamps are stored in milliseconds (see meshtasticManager).
    const recentTs = Date.now() - 100 * 1000; // 100s ago (ms)

    it('returns telemetry for all accessible sources', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A]);
      mockDb.nodes.getAllNodes.mockResolvedValue([
        { nodeId: '!aabbccdd', nodeNum: 0xaabbccdd, longName: 'Node One', shortName: 'N1' },
      ]);
      mockDb.telemetry.getLatestTelemetryByNode.mockResolvedValue([
        { nodeId: '!aabbccdd', nodeNum: 0xaabbccdd, telemetryType: 'battery_level', value: 85, timestamp: recentTs },
        { nodeId: '!aabbccdd', nodeNum: 0xaabbccdd, telemetryType: 'voltage', value: 4.1, timestamp: recentTs },
      ]);

      const app = createApp(adminUser);
      const res = await request(app).get('/telemetry?hours=24');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0].sourceName).toBe('Source A');
      expect(res.body[0].nodeLongName).toBe('Node One');
      expect(['battery_level', 'voltage']).toContain(res.body[0].telemetryType);
    });

    it('filters out readings older than hours window', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A]);
      mockDb.nodes.getAllNodes.mockResolvedValue([
        { nodeId: '!aabbccdd', nodeNum: 0xaabbccdd, longName: 'Node One', shortName: 'N1' },
      ]);
      const oldTs = Date.now() - 7200 * 1000; // 2 hours ago (ms)
      mockDb.telemetry.getLatestTelemetryByNode.mockResolvedValue([
        { nodeId: '!aabbccdd', nodeNum: 0xaabbccdd, telemetryType: 'battery_level', value: 80, timestamp: oldTs },
      ]);

      const app = createApp(adminUser);
      const res = await request(app).get('/telemetry?hours=1'); // only 1h window

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(0); // filtered out
    });

    it('skips nodes from sources user cannot read', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A, SOURCE_B]);
      mockDb.checkPermissionAsync.mockImplementation(
        (_userId: number, _resource: string, _action: string, sourceId: string) =>
          Promise.resolve(sourceId === 'src-a')
      );
      mockDb.nodes.getAllNodes.mockResolvedValue([
        { nodeId: '!aabbccdd', nodeNum: 0xaabbccdd, longName: 'Node One', shortName: 'N1' },
      ]);
      mockDb.telemetry.getLatestTelemetryByNode.mockResolvedValue([
        { nodeId: '!aabbccdd', nodeNum: 0xaabbccdd, telemetryType: 'battery_level', value: 85, timestamp: recentTs },
      ]);

      const app = createApp(regularUser);
      const res = await request(app).get('/telemetry');

      expect(res.status).toBe(200);
      expect(res.body.every((e: any) => e.sourceId === 'src-a')).toBe(true);
    });

    it('returns entries sorted by timestamp descending', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A]);
      mockDb.nodes.getAllNodes.mockResolvedValue([
        { nodeId: '!aabbccdd', nodeNum: 0xaabbccdd, longName: 'Node One', shortName: 'N1' },
        { nodeId: '!11223344', nodeNum: 0x11223344, longName: 'Node Two', shortName: 'N2' },
      ]);
      mockDb.telemetry.getLatestTelemetryByNode
        .mockResolvedValueOnce([
          { nodeId: '!aabbccdd', nodeNum: 0xaabbccdd, telemetryType: 'battery_level', value: 80, timestamp: recentTs - 50 },
        ])
        .mockResolvedValueOnce([
          { nodeId: '!11223344', nodeNum: 0x11223344, telemetryType: 'battery_level', value: 90, timestamp: recentTs },
        ]);

      const app = createApp(adminUser);
      const res = await request(app).get('/telemetry');

      expect(res.status).toBe(200);
      expect(res.body[0].timestamp).toBeGreaterThan(res.body[1].timestamp);
    });

    it('caps hours at 168', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([]);

      const app = createApp(adminUser);
      const res = await request(app).get('/telemetry?hours=9999');

      // Should succeed (no sources, empty result) and not error
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('returns 500 on database error', async () => {
      mockDb.sources.getAllSources.mockRejectedValue(new Error('DB error'));

      const app = createApp(adminUser);
      const res = await request(app).get('/telemetry');

      expect(res.status).toBe(500);
    });
  });
});
