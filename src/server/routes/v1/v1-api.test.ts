/**
 * V1 API Routes Unit Tests
 *
 * Tests all public-facing v1 API endpoints to ensure:
 * - Proper authentication with API tokens
 * - Correct response formats and schemas
 * - Consistent interface contracts
 * - Error handling and edge cases
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

// Token constants
const VALID_TEST_TOKEN = 'mm_v1_test_token_12345678901234567890';
const TEST_USER_ID = 1;

// Test data
const testNodes = [
  { nodeId: '2882400001', node_id: 2882400001, node_id_hex: '!abcd0001', short_name: 'TEST1', long_name: 'Test Node 1', hardware_model: 1, role: 0, last_seen: Date.now() },
  { nodeId: '2882400002', node_id: 2882400002, node_id_hex: '!abcd0002', short_name: 'YERG2', long_name: 'Yeraze Station G2', hardware_model: 2, role: 1, last_seen: Date.now() },
  { nodeId: '2882400003', node_id: 2882400003, node_id_hex: '!abcd0003', short_name: 'TEST3', long_name: 'Test Node 3', hardware_model: 3, role: 0, last_seen: Date.now() - 3600000 }
];

const testMessages = [
  { id: '1', fromNodeId: '2882400001', toNodeId: '2882400002', channel: 0, message: 'Test message 1', timestamp: Date.now() },
  { id: '2', fromNodeId: '2882400002', toNodeId: '2882400001', channel: 0, message: 'Test message 2', timestamp: Date.now() - 1000 }
];

const testTelemetry = [
  { node_id: 2882400001, timestamp: Date.now(), battery_level: 95, voltage: 4.2, temperature: 25.5 },
  { node_id: 2882400002, timestamp: Date.now() - 1000, battery_level: 80, voltage: 3.9, temperature: 24.0 }
];

const testTraceroutes = [
  { id: 1, fromNodeId: '2882400001', toNodeId: '2882400002', route: '2882400001,2882400002', timestamp: Date.now() }
];

const testPackets = [
  { id: 1, packet_id: 1001, from_node: 2882400001, to_node: 2882400002, channel: 0, portnum: 1, encrypted: 0, timestamp: Date.now() },
  { id: 2, packet_id: 1002, from_node: 2882400002, to_node: 2882400001, channel: 0, portnum: 3, encrypted: 1, timestamp: Date.now() - 1000 }
];

const testSolarEstimates = [
  { timestamp: Math.floor(Date.now() / 1000), watt_hours: 450.5, fetched_at: Math.floor(Date.now() / 1000) - 3600 },
  { timestamp: Math.floor(Date.now() / 1000) + 3600, watt_hours: 520.3, fetched_at: Math.floor(Date.now() / 1000) - 3600 },
  { timestamp: Math.floor(Date.now() / 1000) + 7200, watt_hours: 380.2, fetched_at: Math.floor(Date.now() / 1000) - 3600 }
];

// Mock the database service before importing v1Router
vi.mock('../../../services/database.js', () => {
  return {
    default: {
      db: null,
      apiTokenModel: {
        validate: vi.fn(async (token: string) => {
          if (token === VALID_TEST_TOKEN) {
            return TEST_USER_ID;
          }
          return null;
        }),
        updateLastUsed: vi.fn()
      },
      userModel: {
        findById: vi.fn((id: number) => {
          if (id === TEST_USER_ID) {
            return { id: TEST_USER_ID, username: 'test-api-user', isActive: true, isAdmin: false };
          }
          return null;
        })
      },
      permissionModel: {
        check: vi.fn((userId: number, resource: string, action: string) => {
          // Grant all permissions for test user
          return true;
        })
      },
      auditLog: vi.fn(),
      getSetting: vi.fn((key: string) => {
        if (key === 'localNodeNum') return '2715451348';
        if (key === 'localNodeId') return '!a1b2c3d4';
        return null;
      }),
      // Nodes methods
      getAllNodes: vi.fn(() => testNodes),
      getActiveNodes: vi.fn(() => testNodes.slice(0, 2)),
      // Messages methods
      getMessages: vi.fn(() => testMessages),
      getMessagesByChannel: vi.fn(() => testMessages),
      getMessagesAfterTimestamp: vi.fn(() => testMessages),
      // Telemetry methods
      getTelemetryByNode: vi.fn(() => testTelemetry),
      getTelemetryCountByNode: vi.fn(() => testTelemetry.length),
      getTelemetryByType: vi.fn(() => testTelemetry),
      getTelemetryCount: vi.fn(() => testTelemetry.length),
      getLatestTelemetryForType: vi.fn((nodeId: string, type: string) => {
        // Return mock uptime data for test nodes
        if (type === 'uptimeSeconds') {
          return { value: 86400 }; // 1 day uptime
        }
        return null;
      }),
      // Traceroutes methods
      getAllTraceroutes: vi.fn(() => testTraceroutes)
    }
  };
});

// Mock meshtasticManager
vi.mock('../../meshtasticManager.js', () => {
  return {
    default: {
      sendTextMessage: vi.fn(async (text: string, channel: number, destination?: number, replyId?: number, emoji?: number, userId?: number) => {
        // Simulate returning a message ID
        return 123456789;
      })
    }
  };
});

// Mock packetLogService
vi.mock('../../services/packetLogService.js', () => {
  return {
    default: {
      getPackets: vi.fn(() => testPackets),
      getPacketCount: vi.fn(() => testPackets.length),
      getPacketById: vi.fn((id: number) => testPackets.find(p => p.id === id) || null),
      getMaxCount: vi.fn(() => 10000)
    }
  };
});

// Mock solarMonitoringService
vi.mock('../../services/solarMonitoringService.js', () => {
  return {
    solarMonitoringService: {
      getRecentEstimates: vi.fn((limit: number) => testSolarEstimates.slice(0, limit)),
      getEstimatesInRange: vi.fn((start: number, end: number) => {
        return testSolarEstimates.filter(e => e.timestamp >= start && e.timestamp <= end);
      })
    }
  };
});

// Import after mocking
import v1Router from './index.js';

let app: express.Application;

beforeEach(async () => {
  // Create Express app with v1 router
  app = express();
  app.use(express.json());
  app.use('/api/v1', v1Router);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('V1 API Authentication', () => {
  it('should reject requests without API token', async () => {
    const response = await request(app)
      .get('/api/v1/nodes')
      .expect(401);

    expect(response.body).toHaveProperty('error');
  });

  it('should reject requests with invalid API token', async () => {
    const response = await request(app)
      .get('/api/v1/nodes')
      .set('Authorization', 'Bearer mm_v1_invalid_token_12345')
      .expect(401);

    expect(response.body).toHaveProperty('error');
  });

  it('should accept requests with valid API token', async () => {
    const response = await request(app)
      .get('/api/v1/')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`)
      .expect(200);

    expect(response.body).toHaveProperty('version', 'v1');
  });
});

describe('GET /api/v1/', () => {
  it('should return API version info', async () => {
    const response = await request(app)
      .get('/api/v1/')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`)
      .expect(200);

    expect(response.body).toEqual({
      version: 'v1',
      description: 'MeshMonitor REST API v1',
      documentation: '/api/v1/docs',
      endpoints: {
        nodes: '/api/v1/nodes',
        channels: '/api/v1/channels',
        telemetry: '/api/v1/telemetry',
        traceroutes: '/api/v1/traceroutes',
        messages: '/api/v1/messages',
        network: '/api/v1/network',
        packets: '/api/v1/packets',
        solar: '/api/v1/solar'
      }
    });
  });
});

describe('GET /api/v1/nodes', () => {
  it('should return list of nodes with standard response format', async () => {
    const response = await request(app)
      .get('/api/v1/nodes')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`)
      .expect(200);

    expect(response.body).toHaveProperty('success', true);
    expect(response.body).toHaveProperty('count');
    expect(response.body).toHaveProperty('data');
    expect(Array.isArray(response.body.data)).toBe(true);
    expect(response.body.count).toBeGreaterThanOrEqual(3);
  });

  it('should include Yeraze Station G2 in node list', async () => {
    const response = await request(app)
      .get('/api/v1/nodes')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`)
      .expect(200);

    const yerazeNode = response.body.data.find((n: { short_name: string }) => n.short_name === 'YERG2');
    expect(yerazeNode).toBeDefined();
    expect(yerazeNode.long_name).toBe('Yeraze Station G2');
  });
});

describe('GET /api/v1/nodes/:id', () => {
  it('should return single node by ID', async () => {
    const response = await request(app)
      .get('/api/v1/nodes/2882400002')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`)
      .expect(200);

    expect(response.body).toHaveProperty('success', true);
    expect(response.body).toHaveProperty('data');
    expect(response.body.data.short_name).toBe('YERG2');
  });

  it('should return 404 for non-existent node', async () => {
    const response = await request(app)
      .get('/api/v1/nodes/999999999')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`)
      .expect(404);

    expect(response.body).toHaveProperty('success', false);
    expect(response.body).toHaveProperty('error');
  });
});

describe('GET /api/v1/messages', () => {
  it('should return messages with standard response format', async () => {
    const response = await request(app)
      .get('/api/v1/messages')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`)
      .expect(200);

    expect(response.body).toHaveProperty('success', true);
    expect(response.body).toHaveProperty('count');
    expect(response.body).toHaveProperty('data');
    expect(Array.isArray(response.body.data)).toBe(true);
  });

  it('should filter messages by channel', async () => {
    const response = await request(app)
      .get('/api/v1/messages?channel=0')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`)
      .expect(200);

    expect(response.body.success).toBe(true);
  });
});

describe('GET /api/v1/telemetry', () => {
  it('should return telemetry data', async () => {
    const response = await request(app)
      .get('/api/v1/telemetry')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`)
      .expect(200);

    expect(response.body).toHaveProperty('success', true);
    expect(response.body).toHaveProperty('data');
    expect(Array.isArray(response.body.data)).toBe(true);
  });

  it('should filter telemetry by node ID', async () => {
    const response = await request(app)
      .get('/api/v1/telemetry?nodeId=2882400001')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`)
      .expect(200);

    expect(response.body.success).toBe(true);
  });
});

describe('GET /api/v1/traceroutes', () => {
  it('should return traceroute data', async () => {
    const response = await request(app)
      .get('/api/v1/traceroutes')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`)
      .expect(200);

    expect(response.body).toHaveProperty('success', true);
    expect(response.body).toHaveProperty('data');
    expect(Array.isArray(response.body.data)).toBe(true);
    expect(response.body.count).toBeGreaterThanOrEqual(1);
  });
});

describe('GET /api/v1/packets', () => {
  it('should return packet log data', async () => {
    const response = await request(app)
      .get('/api/v1/packets')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`)
      .expect(200);

    expect(response.body).toHaveProperty('success', true);
    expect(response.body).toHaveProperty('count');
    expect(response.body).toHaveProperty('total');
    expect(response.body).toHaveProperty('data');
    expect(Array.isArray(response.body.data)).toBe(true);
  });

  it('should support filtering by portnum', async () => {
    const response = await request(app)
      .get('/api/v1/packets?portnum=1')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`)
      .expect(200);

    expect(response.body.success).toBe(true);
  });

  it('should support pagination', async () => {
    const response = await request(app)
      .get('/api/v1/packets?offset=0&limit=1')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`)
      .expect(200);

    expect(response.body.offset).toBe(0);
    expect(response.body.limit).toBe(1);
  });
});

describe('GET /api/v1/packets/:id', () => {
  it('should return single packet by ID', async () => {
    const response = await request(app)
      .get('/api/v1/packets/1')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`)
      .expect(200);

    expect(response.body).toHaveProperty('success', true);
    expect(response.body).toHaveProperty('data');
  });

  it('should return 404 for non-existent packet', async () => {
    const response = await request(app)
      .get('/api/v1/packets/999999')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`)
      .expect(404);

    expect(response.body).toHaveProperty('success', false);
  });
});

describe('GET /api/v1/solar', () => {
  it('should return solar estimates with standard response format', async () => {
    const response = await request(app)
      .get('/api/v1/solar')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`)
      .expect(200);

    expect(response.body).toHaveProperty('success', true);
    expect(response.body).toHaveProperty('count');
    expect(response.body).toHaveProperty('data');
    expect(Array.isArray(response.body.data)).toBe(true);
    expect(response.body.count).toBeGreaterThanOrEqual(3);
  });

  it('should return solar estimates with correct fields', async () => {
    const response = await request(app)
      .get('/api/v1/solar')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`)
      .expect(200);

    const estimate = response.body.data[0];
    expect(estimate).toHaveProperty('timestamp');
    expect(estimate).toHaveProperty('datetime');
    expect(estimate).toHaveProperty('wattHours');
    expect(estimate).toHaveProperty('fetchedAt');
  });

  it('should respect limit parameter', async () => {
    const response = await request(app)
      .get('/api/v1/solar?limit=1')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`)
      .expect(200);

    expect(response.body.count).toBe(1);
    expect(response.body.data.length).toBe(1);
  });
});

describe('GET /api/v1/solar/range', () => {
  it('should return solar estimates within time range', async () => {
    const now = Math.floor(Date.now() / 1000);
    const start = now - 3600;
    const end = now + 10800; // 3 hours ahead

    const response = await request(app)
      .get(`/api/v1/solar/range?start=${start}&end=${end}`)
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`)
      .expect(200);

    expect(response.body).toHaveProperty('success', true);
    expect(response.body).toHaveProperty('count');
    expect(response.body).toHaveProperty('start', start);
    expect(response.body).toHaveProperty('end', end);
    expect(response.body).toHaveProperty('data');
    expect(Array.isArray(response.body.data)).toBe(true);
  });

  it('should return 400 for missing start parameter', async () => {
    const response = await request(app)
      .get('/api/v1/solar/range?end=1699560000')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`)
      .expect(400);

    expect(response.body).toHaveProperty('success', false);
    expect(response.body).toHaveProperty('error');
  });

  it('should return 400 for missing end parameter', async () => {
    const response = await request(app)
      .get('/api/v1/solar/range?start=1699520400')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`)
      .expect(400);

    expect(response.body).toHaveProperty('success', false);
    expect(response.body).toHaveProperty('error');
  });

  it('should return 400 when start is after end', async () => {
    const response = await request(app)
      .get('/api/v1/solar/range?start=1699606800&end=1699520400')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`)
      .expect(400);

    expect(response.body).toHaveProperty('success', false);
    expect(response.body).toHaveProperty('error');
  });
});

describe('API Response Format Consistency', () => {
  it('all list endpoints should have consistent response structure', async () => {
    const endpoints = [
      '/api/v1/nodes',
      '/api/v1/messages',
      '/api/v1/telemetry',
      '/api/v1/traceroutes',
      '/api/v1/packets',
      '/api/v1/solar'
    ];

    for (const endpoint of endpoints) {
      const response = await request(app)
        .get(endpoint)
        .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`)
        .expect(200);

      // All should have success flag
      expect(response.body).toHaveProperty('success', true);
      // All should have data array
      expect(response.body).toHaveProperty('data');
      expect(Array.isArray(response.body.data)).toBe(true);
      // All should have count
      expect(response.body).toHaveProperty('count');
    }
  });

  it('all error responses should have consistent structure', async () => {
    const response = await request(app)
      .get('/api/v1/nodes/999999999')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`)
      .expect(404);

    expect(response.body).toHaveProperty('success', false);
    expect(response.body).toHaveProperty('error');
    expect(response.body).toHaveProperty('message');
  });
});

describe('POST /api/v1/messages', () => {
  it('should send a channel message successfully', async () => {
    const response = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`)
      .send({
        text: 'Hello from API test!',
        channel: 0
      })
      .expect(201);

    expect(response.body).toHaveProperty('success', true);
    expect(response.body.data).toHaveProperty('messageId');
    expect(response.body.data).toHaveProperty('requestId', 123456789);
    expect(response.body.data).toHaveProperty('deliveryState', 'pending');
    expect(response.body.data).toHaveProperty('text', 'Hello from API test!');
    expect(response.body.data).toHaveProperty('channel', 0);
    expect(response.body.data).toHaveProperty('toNodeId', 'broadcast');
  });

  it('should send a direct message successfully', async () => {
    const response = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`)
      .send({
        text: 'Private message via API',
        toNodeId: '!a1b2c3d4'
      })
      .expect(201);

    expect(response.body).toHaveProperty('success', true);
    expect(response.body.data).toHaveProperty('messageId');
    expect(response.body.data).toHaveProperty('requestId', 123456789);
    expect(response.body.data).toHaveProperty('deliveryState', 'pending');
    expect(response.body.data).toHaveProperty('channel', -1);
    expect(response.body.data).toHaveProperty('toNodeId', '!a1b2c3d4');
  });

  it('should reject request without text', async () => {
    const response = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`)
      .send({
        channel: 0
      })
      .expect(400);

    expect(response.body).toHaveProperty('success', false);
    expect(response.body).toHaveProperty('error', 'Bad Request');
    expect(response.body.message).toContain('text');
  });

  it('should reject request with empty text', async () => {
    const response = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`)
      .send({
        text: '',
        channel: 0
      })
      .expect(400);

    expect(response.body).toHaveProperty('success', false);
    expect(response.body).toHaveProperty('error', 'Bad Request');
  });

  it('should reject request with both channel and toNodeId', async () => {
    const response = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`)
      .send({
        text: 'Test message',
        channel: 0,
        toNodeId: '!a1b2c3d4'
      })
      .expect(400);

    expect(response.body).toHaveProperty('success', false);
    expect(response.body).toHaveProperty('error', 'Bad Request');
    expect(response.body.message).toContain('either channel OR toNodeId');
  });

  it('should reject request without channel or toNodeId', async () => {
    const response = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`)
      .send({
        text: 'Test message'
      })
      .expect(400);

    expect(response.body).toHaveProperty('success', false);
    expect(response.body).toHaveProperty('error', 'Bad Request');
    expect(response.body.message).toContain('Either channel or toNodeId is required');
  });

  it('should reject invalid channel number', async () => {
    const response = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`)
      .send({
        text: 'Test message',
        channel: 10
      })
      .expect(400);

    expect(response.body).toHaveProperty('success', false);
    expect(response.body).toHaveProperty('error', 'Bad Request');
    expect(response.body.message).toContain('between 0 and 7');
  });

  it('should reject invalid toNodeId format', async () => {
    const response = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`)
      .send({
        text: 'Test message',
        toNodeId: 'invalid_node_id'
      })
      .expect(400);

    expect(response.body).toHaveProperty('success', false);
    expect(response.body).toHaveProperty('error', 'Bad Request');
    expect(response.body.message).toContain('hex string starting with !');
  });

  it('should support optional replyId', async () => {
    const response = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`)
      .send({
        text: 'This is a reply',
        channel: 0,
        replyId: 987654321
      })
      .expect(201);

    expect(response.body).toHaveProperty('success', true);
    expect(response.body.data).toHaveProperty('messageId');
  });

  it('should trim whitespace from message text', async () => {
    const response = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`)
      .send({
        text: '  Trimmed message  ',
        channel: 0
      })
      .expect(201);

    expect(response.body.data.text).toBe('Trimmed message');
  });

  it('should accept short node IDs (1-8 hex chars)', async () => {
    const response = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`)
      .send({
        text: 'Short node ID test',
        toNodeId: '!abc'
      })
      .expect(201);

    expect(response.body).toHaveProperty('success', true);
    expect(response.body.data).toHaveProperty('toNodeId', '!abc');
  });

  it('should reject whitespace-only text', async () => {
    const response = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`)
      .send({
        text: '   ',
        channel: 0
      })
      .expect(400);

    expect(response.body).toHaveProperty('success', false);
    expect(response.body).toHaveProperty('error', 'Bad Request');
  });
});

describe('POST /api/v1/messages - Permission Tests', () => {
  it('should reject channel message without channel permission', async () => {
    // Override permissionModel.check to deny channel_0:write
    const databaseService = await import('../../../services/database.js');
    vi.mocked(databaseService.default.permissionModel.check).mockImplementation(
      (userId: number, resource: string, action: string) => {
        if (resource === 'channel_0' && action === 'write') return false;
        return true;
      }
    );

    const response = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`)
      .send({
        text: 'Should be denied',
        channel: 0
      })
      .expect(403);

    expect(response.body).toHaveProperty('success', false);
    expect(response.body).toHaveProperty('error', 'Forbidden');
    expect(response.body).toHaveProperty('required');
    expect(response.body.required).toHaveProperty('resource', 'channel_0');
    expect(response.body.required).toHaveProperty('action', 'write');
  });

  it('should reject direct message without messages permission', async () => {
    // Override permissionModel.check to deny messages:write
    const databaseService = await import('../../../services/database.js');
    vi.mocked(databaseService.default.permissionModel.check).mockImplementation(
      (userId: number, resource: string, action: string) => {
        if (resource === 'messages' && action === 'write') return false;
        return true;
      }
    );

    const response = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`)
      .send({
        text: 'Should be denied',
        toNodeId: '!a1b2c3d4'
      })
      .expect(403);

    expect(response.body).toHaveProperty('success', false);
    expect(response.body).toHaveProperty('error', 'Forbidden');
    expect(response.body).toHaveProperty('required');
    expect(response.body.required).toHaveProperty('resource', 'messages');
  });
});

describe('POST /api/v1/messages - Error Handling', () => {
  it('should return 503 when not connected to node', async () => {
    // Mock sendTextMessage to throw a "Not connected" error
    const meshtasticManager = await import('../../meshtasticManager.js');
    vi.mocked(meshtasticManager.default.sendTextMessage).mockRejectedValueOnce(
      new Error('Not connected to Meshtastic device')
    );

    const response = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`)
      .send({
        text: 'Test message',
        channel: 0
      })
      .expect(503);

    expect(response.body).toHaveProperty('success', false);
    expect(response.body).toHaveProperty('error', 'Service Unavailable');
    expect(response.body.message).toContain('Not connected');
  });

  it('should return 500 for generic errors', async () => {
    // Mock sendTextMessage to throw a generic error
    const meshtasticManager = await import('../../meshtasticManager.js');
    vi.mocked(meshtasticManager.default.sendTextMessage).mockRejectedValueOnce(
      new Error('Something went wrong')
    );

    const response = await request(app)
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`)
      .send({
        text: 'Test message',
        channel: 0
      })
      .expect(500);

    expect(response.body).toHaveProperty('success', false);
    expect(response.body).toHaveProperty('error', 'Internal Server Error');
  });
});
