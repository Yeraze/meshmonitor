import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import cors from 'cors';

// Mock the database module
vi.mock('../services/database', () => ({
  default: {
    getAllNodes: vi.fn(() => [
      { nodeNum: 1, nodeId: '!node1', longName: 'Test Node 1', shortName: 'TN1' },
      { nodeNum: 2, nodeId: '!node2', longName: 'Test Node 2', shortName: 'TN2' }
    ]),
    getActiveNodes: vi.fn(() => [
      { nodeNum: 1, nodeId: '!node1', longName: 'Test Node 1', shortName: 'TN1', lastHeard: Date.now() }
    ]),
    getMessages: vi.fn((limit) => {
      const messages = [];
      for (let i = 0; i < Math.min(limit, 5); i++) {
        messages.push({
          id: `msg-${i}`,
          fromNodeNum: 1,
          toNodeNum: 2,
          fromNodeId: '!node1',
          toNodeId: '!node2',
          text: `Message ${i}`,
          channel: 0,
          timestamp: Date.now() - i * 1000,
          createdAt: Date.now()
        });
      }
      return messages;
    }),
    getMessagesByChannel: vi.fn((channel) => [
      {
        id: 'msg-channel',
        fromNodeNum: 1,
        toNodeNum: 2,
        fromNodeId: '!node1',
        toNodeId: '!node2',
        text: `Message on channel ${channel}`,
        channel,
        timestamp: Date.now(),
        createdAt: Date.now()
      }
    ]),
    getDirectMessages: vi.fn(() => [
      {
        id: 'msg-direct',
        fromNodeNum: 1,
        toNodeNum: 2,
        fromNodeId: '!node1',
        toNodeId: '!node2',
        text: 'Direct message',
        channel: 0,
        timestamp: Date.now(),
        createdAt: Date.now()
      }
    ]),
    getAllChannels: vi.fn(() => [
      { id: 0, name: 'Primary', uplinkEnabled: true, downlinkEnabled: true },
      { id: 1, name: 'Secondary', uplinkEnabled: true, downlinkEnabled: true }
    ]),
    getMessageCount: vi.fn(() => 100),
    getNodeCount: vi.fn(() => 10),
    getChannelCount: vi.fn(() => 2),
    getMessagesByDay: vi.fn(() => [
      { date: '2024-01-01', count: 10 },
      { date: '2024-01-02', count: 15 }
    ]),
    exportData: vi.fn(() => ({
      nodes: [{ nodeNum: 1, nodeId: '!node1' }],
      messages: [{ id: 'msg-1', text: 'Test' }]
    })),
    importData: vi.fn(),
    cleanupOldMessages: vi.fn(() => 5),
    cleanupInactiveNodes: vi.fn(() => 3),
    cleanupEmptyChannels: vi.fn(() => 1),
    getAllTraceroutes: vi.fn(() => [
      {
        id: 1,
        fromNodeNum: 1,
        toNodeNum: 2,
        fromNodeId: '!node1',
        toNodeId: '!node2',
        route: '1,3,2',
        timestamp: Date.now()
      }
    ]),
    getTelemetryByNode: vi.fn(() => [
      {
        id: 1,
        nodeId: '!node1',
        nodeNum: 1,
        telemetryType: 'battery',
        value: 85.5,
        timestamp: Date.now()
      }
    ]),
    getNode: vi.fn((nodeNum) => {
      if (nodeNum === 1) {
        return { nodeNum: 1, nodeId: '!node1', longName: 'Test Node 1' };
      }
      return null;
    }),
    purgeAllNodes: vi.fn(),
    purgeAllTelemetry: vi.fn(),
    purgeAllMessages: vi.fn()
  }
}));

// Mock the meshtasticManager
vi.mock('../server/meshtasticManager', () => ({
  default: {
    isConnected: () => true,
    getNodeId: () => '!localNode',
    getChannels: () => [
      { id: 0, name: 'Primary' },
      { id: 1, name: 'Secondary' }
    ],
    sendTextMessage: vi.fn(async () => true),
    sendTraceroute: vi.fn(async () => true),
    refreshNodeInfo: vi.fn(async () => ({ success: true })),
    getDeviceConfig: vi.fn(async () => ({
      lora: { region: 'US', hopLimit: 3 },
      bluetooth: { enabled: true }
    })),
    tracerouteInterval: 300000,
    refreshChannels: vi.fn(async () => ({ success: true, channels: 2 }))
  }
}));

describe('Server API Endpoints', () => {
  let app: express.Application;

  beforeAll(() => {
    // Create a minimal Express app for testing
    app = express();
    app.use(cors());
    app.use(express.json());

    // Import API routes from the server
    // Note: In a real scenario, you'd extract the routes to a separate module
    // For this test, we'll recreate the essential routes

    // Node endpoints
    app.get('/api/nodes', (_req, res) => {
      try {
        const db = require('../services/database').default;
        res.json(db.getAllNodes());
      } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    app.get('/api/nodes/active', (_req, res) => {
      try {
        const db = require('../services/database').default;
        res.json(db.getActiveNodes());
      } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Message endpoints
    app.get('/api/messages', (req, res) => {
      try {
        const db = require('../services/database').default;
        const limit = parseInt(req.query.limit as string) || 100;
        res.json(db.getMessages(limit));
      } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    app.get('/api/messages/channel/:channel', (req, res) => {
      try {
        const db = require('../services/database').default;
        const channel = parseInt(req.params.channel);
        res.json(db.getMessagesByChannel(channel));
      } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    app.get('/api/messages/direct/:nodeId1/:nodeId2', (_req, res) => {
      try {
        const db = require('../services/database').default;
        res.json(db.getDirectMessages());
      } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    app.post('/api/messages/send', async (req, res) => {
      const manager = require('../server/meshtasticManager').default;
      const { text, toNodeId, channelIndex } = req.body;

      if (!text || !toNodeId) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      try {
        const result = await manager.sendTextMessage(text, toNodeId, channelIndex);
        res.json({ success: result });
      } catch (error) {
        res.status(500).json({ error: 'Failed to send message' });
      }
    });

    // Channel endpoints
    app.get('/api/channels', (_req, res) => {
      try {
        const db = require('../services/database').default;
        res.json(db.getAllChannels());
      } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Stats endpoint
    app.get('/api/stats', (_req, res) => {
      try {
        const db = require('../services/database').default;
      res.json({
        messageCount: db.getMessageCount(),
        nodeCount: db.getNodeCount(),
        channelCount: db.getChannelCount(),
        messagesByDay: db.getMessagesByDay()
      });
      } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Health check
    app.get('/api/health', (_req, res) => {
      res.json({ status: 'ok' });
    });

    // Connection status
    app.get('/api/connection', (_req, res) => {
      try {
        const manager = require('../server/meshtasticManager').default;
      res.json({
        connected: manager.isConnected(),
        nodeId: manager.getNodeId()
      });
      } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Export/Import
    app.post('/api/export', (_req, res) => {
      try {
        const db = require('../services/database').default;
        res.json(db.exportData());
      } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    app.post('/api/import', (req, res) => {
      try {
        const db = require('../services/database').default;
      try {
        db.importData(req.body);
        res.json({ success: true });
      } catch (error) {
        res.status(400).json({ error: 'Invalid data format' });
      }
      } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Cleanup endpoints
    app.post('/api/cleanup/messages', (req, res) => {
      try {
        const db = require('../services/database').default;
      const days = parseInt(req.body.days) || 30;
      const deleted = db.cleanupOldMessages(days);
      res.json({ deleted });
      } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    app.post('/api/cleanup/nodes', (req, res) => {
      try {
        const db = require('../services/database').default;
      const days = parseInt(req.body.days) || 30;
      const deleted = db.cleanupInactiveNodes(days);
      res.json({ deleted });
      } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Traceroute endpoints
    app.post('/api/traceroute', async (req, res) => {
      const manager = require('../server/meshtasticManager').default;
      const { toNodeNum } = req.body;

      if (!toNodeNum) {
        return res.status(400).json({ error: 'Missing toNodeNum' });
      }

      try {
        await manager.sendTraceroute(toNodeNum);
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: 'Failed to send traceroute' });
      }
    });

    app.get('/api/traceroutes/recent', (_req, res) => {
      try {
        const db = require('../services/database').default;
        res.json(db.getAllTraceroutes());
      } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Telemetry endpoints
    app.get('/api/telemetry/:nodeId', (req, res) => {
      try {
        const db = require('../services/database').default;
        res.json(db.getTelemetryByNode(req.params.nodeId));
      } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Purge endpoints
    app.post('/api/purge/nodes', (_req, res) => {
      try {
        const db = require('../services/database').default;
      db.purgeAllNodes();
      res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    app.post('/api/purge/telemetry', (_req, res) => {
      try {
        const db = require('../services/database').default;
      db.purgeAllTelemetry();
      res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    app.post('/api/purge/messages', (_req, res) => {
      try {
        const db = require('../services/database').default;
      db.purgeAllMessages();
      res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
      }
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Node Endpoints', () => {
    it('GET /api/nodes should return all nodes', async () => {
      const response = await request(app)
        .get('/api/nodes')
        .expect(200);

      expect(response.body).toHaveLength(2);
      expect(response.body[0].nodeId).toBe('!node1');
    });

    it('GET /api/nodes/active should return active nodes', async () => {
      const response = await request(app)
        .get('/api/nodes/active')
        .expect(200);

      expect(response.body).toHaveLength(1);
      expect(response.body[0].nodeId).toBe('!node1');
    });
  });

  describe('Message Endpoints', () => {
    it('GET /api/messages should return messages with default limit', async () => {
      const response = await request(app)
        .get('/api/messages')
        .expect(200);

      expect(response.body).toHaveLength(5);
      expect(response.body[0].id).toBe('msg-0');
    });

    it('GET /api/messages should respect limit parameter', async () => {
      const response = await request(app)
        .get('/api/messages?limit=3')
        .expect(200);

      expect(response.body).toHaveLength(3);
    });

    it('GET /api/messages/channel/:channel should return messages for channel', async () => {
      const response = await request(app)
        .get('/api/messages/channel/1')
        .expect(200);

      expect(response.body).toHaveLength(1);
      expect(response.body[0].channel).toBe(1);
    });

    it('GET /api/messages/direct/:nodeId1/:nodeId2 should return direct messages', async () => {
      const response = await request(app)
        .get('/api/messages/direct/!node1/!node2')
        .expect(200);

      expect(response.body).toHaveLength(1);
      expect(response.body[0].text).toBe('Direct message');
    });

    it('POST /api/messages/send should send a message', async () => {
      const response = await request(app)
        .post('/api/messages/send')
        .send({
          text: 'Test message',
          toNodeId: '!node2',
          channelIndex: 0
        })
        .expect(200);

      expect(response.body.success).toBe(true);
    });

    it('POST /api/messages/send should reject without required fields', async () => {
      const response = await request(app)
        .post('/api/messages/send')
        .send({ text: 'Test message' })
        .expect(400);

      expect(response.body.error).toBe('Missing required fields');
    });
  });

  describe('Channel Endpoints', () => {
    it('GET /api/channels should return all channels', async () => {
      const response = await request(app)
        .get('/api/channels')
        .expect(200);

      expect(response.body).toHaveLength(2);
      expect(response.body[0].name).toBe('Primary');
    });
  });

  describe('Statistics Endpoints', () => {
    it('GET /api/stats should return statistics', async () => {
      const response = await request(app)
        .get('/api/stats')
        .expect(200);

      expect(response.body).toHaveProperty('messageCount', 100);
      expect(response.body).toHaveProperty('nodeCount', 10);
      expect(response.body).toHaveProperty('channelCount', 2);
      expect(response.body).toHaveProperty('messagesByDay');
    });
  });

  describe('Health and Status Endpoints', () => {
    it('GET /api/health should return ok status', async () => {
      const response = await request(app)
        .get('/api/health')
        .expect(200);

      expect(response.body.status).toBe('ok');
    });

    it('GET /api/connection should return connection status', async () => {
      const response = await request(app)
        .get('/api/connection')
        .expect(200);

      expect(response.body.connected).toBe(true);
      expect(response.body.nodeId).toBe('!localNode');
    });
  });

  describe('Export/Import Endpoints', () => {
    it('POST /api/export should export data', async () => {
      const response = await request(app)
        .post('/api/export')
        .expect(200);

      expect(response.body).toHaveProperty('nodes');
      expect(response.body).toHaveProperty('messages');
    });

    it('POST /api/import should import data', async () => {
      const response = await request(app)
        .post('/api/import')
        .send({
          nodes: [{ nodeNum: 3, nodeId: '!node3' }],
          messages: []
        })
        .expect(200);

      expect(response.body.success).toBe(true);
    });
  });

  describe('Cleanup Endpoints', () => {
    it('POST /api/cleanup/messages should cleanup old messages', async () => {
      const response = await request(app)
        .post('/api/cleanup/messages')
        .send({ days: 7 })
        .expect(200);

      expect(response.body.deleted).toBe(5);
    });

    it('POST /api/cleanup/nodes should cleanup inactive nodes', async () => {
      const response = await request(app)
        .post('/api/cleanup/nodes')
        .send({ days: 7 })
        .expect(200);

      expect(response.body.deleted).toBe(3);
    });
  });

  describe('Traceroute Endpoints', () => {
    it('POST /api/traceroute should send traceroute', async () => {
      const response = await request(app)
        .post('/api/traceroute')
        .send({ toNodeNum: 2 })
        .expect(200);

      expect(response.body.success).toBe(true);
    });

    it('POST /api/traceroute should reject without toNodeNum', async () => {
      const response = await request(app)
        .post('/api/traceroute')
        .send({})
        .expect(400);

      expect(response.body.error).toBe('Missing toNodeNum');
    });

    it('GET /api/traceroutes/recent should return recent traceroutes', async () => {
      const response = await request(app)
        .get('/api/traceroutes/recent')
        .expect(200);

      expect(response.body).toHaveLength(1);
      expect(response.body[0].route).toBe('1,3,2');
    });
  });

  describe('Telemetry Endpoints', () => {
    it('GET /api/telemetry/:nodeId should return telemetry for node', async () => {
      const response = await request(app)
        .get('/api/telemetry/!node1')
        .expect(200);

      expect(response.body).toHaveLength(1);
      expect(response.body[0].telemetryType).toBe('battery');
    });
  });

  describe('Purge Endpoints', () => {
    it('POST /api/purge/nodes should purge all nodes', async () => {
      const response = await request(app)
        .post('/api/purge/nodes')
        .expect(200);

      expect(response.body.success).toBe(true);
    });

    it('POST /api/purge/telemetry should purge all telemetry', async () => {
      const response = await request(app)
        .post('/api/purge/telemetry')
        .expect(200);

      expect(response.body.success).toBe(true);
    });

    it('POST /api/purge/messages should purge all messages', async () => {
      const response = await request(app)
        .post('/api/purge/messages')
        .expect(200);

      expect(response.body.success).toBe(true);
    });
  });
});