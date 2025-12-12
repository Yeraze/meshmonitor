/**
 * V1 API Routes Unit Tests
 *
 * Tests all public-facing v1 API endpoints to ensure:
 * - Proper authentication with API tokens
 * - Correct response formats and schemas
 * - Consistent interface contracts
 * - Error handling and edge cases
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import v1Router from './index.js';

// Token constants
const TOKEN_PREFIX = 'mm_v1_';
const TOKEN_LENGTH = 32;

// Test database and Express app setup
let app: express.Application;
let db: Database.Database;
let testToken: string;
let testUserId: number;

/**
 * Create in-memory test database with required schema
 */
function createTestDatabase(): Database.Database {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');

  // Create users table
  database.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      email TEXT,
      display_name TEXT,
      auth_provider TEXT NOT NULL DEFAULT 'local',
      oidc_sub TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      last_login_at INTEGER,
      CHECK (is_admin IN (0, 1)),
      CHECK (is_active IN (0, 1))
    )
  `);

  // Create API tokens table
  database.exec(`
    CREATE TABLE api_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token_hash TEXT UNIQUE NOT NULL,
      prefix TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      created_by INTEGER NOT NULL,
      revoked_at INTEGER,
      revoked_by INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id),
      FOREIGN KEY (revoked_by) REFERENCES users(id)
    )
  `);

  // Create nodes table
  database.exec(`
    CREATE TABLE nodes (
      node_id INTEGER PRIMARY KEY,
      node_id_hex TEXT UNIQUE NOT NULL,
      short_name TEXT,
      long_name TEXT,
      hardware_model INTEGER,
      role INTEGER,
      last_seen INTEGER,
      latitude REAL,
      longitude REAL,
      altitude INTEGER,
      position_precision INTEGER,
      snr REAL,
      rssi INTEGER,
      battery_level INTEGER,
      voltage REAL,
      channel_utilization REAL,
      air_util_tx REAL,
      uptime_seconds INTEGER
    )
  `);

  // Create messages table
  database.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      packet_id INTEGER,
      from_node INTEGER,
      to_node INTEGER,
      channel INTEGER,
      message TEXT,
      timestamp INTEGER,
      rx_time INTEGER,
      rx_snr REAL,
      rx_rssi INTEGER,
      hop_limit INTEGER,
      hop_start INTEGER,
      want_ack INTEGER,
      via_mqtt INTEGER,
      pki_encrypted INTEGER
    )
  `);

  // Create telemetry table
  database.exec(`
    CREATE TABLE telemetry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id INTEGER,
      timestamp INTEGER,
      battery_level INTEGER,
      voltage REAL,
      channel_utilization REAL,
      air_util_tx REAL,
      temperature REAL,
      relative_humidity REAL,
      barometric_pressure REAL,
      uptime_seconds INTEGER
    )
  `);

  // Create traceroutes table
  database.exec(`
    CREATE TABLE traceroutes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_node INTEGER,
      to_node INTEGER,
      route TEXT,
      snr_towards TEXT,
      snr_back TEXT,
      timestamp INTEGER
    )
  `);

  // Create packet_log table
  database.exec(`
    CREATE TABLE packet_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      packet_id INTEGER,
      timestamp INTEGER,
      from_node INTEGER,
      from_node_id TEXT,
      to_node INTEGER,
      to_node_id TEXT,
      channel INTEGER,
      portnum INTEGER,
      encrypted INTEGER,
      snr REAL,
      rssi INTEGER,
      hop_limit INTEGER,
      hop_start INTEGER,
      want_ack INTEGER,
      via_mqtt INTEGER,
      payload_text TEXT,
      payload_json TEXT
    )
  `);

  // Create solar_estimates table
  database.exec(`
    CREATE TABLE solar_estimates (
      timestamp INTEGER PRIMARY KEY,
      watt_hours REAL NOT NULL,
      fetched_at INTEGER NOT NULL
    )
  `);

  return database;
}

/**
 * Generate and store a test API token
 */
async function generateTestToken(database: Database.Database, userId: number): Promise<string> {
  const randomBytes = crypto.randomBytes(TOKEN_LENGTH / 2);
  const tokenSecret = randomBytes.toString('hex');
  const fullToken = TOKEN_PREFIX + tokenSecret;
  const tokenHash = await bcrypt.hash(fullToken, 12);

  database.prepare(`
    INSERT INTO api_tokens (user_id, token_hash, prefix, created_at, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, tokenHash, TOKEN_PREFIX, Date.now(), userId);

  return fullToken;
}

/**
 * Mock database service for tests
 */
function setupMockDatabaseService(database: Database.Database) {
  const mockDb = {
    db: database,
    getNodes: () => {
      return database.prepare('SELECT * FROM nodes').all();
    },
    getMessages: (params: any) => {
      const { offset = 0, limit = 100 } = params;
      return database.prepare('SELECT * FROM messages LIMIT ? OFFSET ?').all(limit, offset);
    },
    getMessageCount: () => {
      return database.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number };
    },
    getTelemetry: (params: any) => {
      const { offset = 0, limit = 100 } = params;
      return database.prepare('SELECT * FROM telemetry LIMIT ? OFFSET ?').all(limit, offset);
    },
    getTelemetryCount: () => {
      return database.prepare('SELECT COUNT(*) as count FROM telemetry').get() as { count: number };
    },
    getTraceroutes: (params: any) => {
      const { offset = 0, limit = 100 } = params;
      return database.prepare('SELECT * FROM traceroutes LIMIT ? OFFSET ?').all(limit, offset);
    },
    getTracerouteCount: () => {
      return database.prepare('SELECT COUNT(*) as count FROM traceroutes').get() as { count: number };
    },
    apiTokenModel: {
      validateToken: async (token: string) => {
        if (!token || !token.startsWith(TOKEN_PREFIX)) {
          return null;
        }

        const tokens = database.prepare('SELECT * FROM api_tokens WHERE is_active = 1').all();
        for (const tokenRecord of tokens as any[]) {
          const isValid = await bcrypt.compare(token, tokenRecord.token_hash);
          if (isValid) {
            return {
              id: tokenRecord.id,
              user_id: tokenRecord.user_id,
              is_active: tokenRecord.is_active === 1
            };
          }
        }
        return null;
      }
    }
  };

  // Make it globally available for the routes
  (global as any).mockDatabaseService = mockDb;
  return mockDb;
}

beforeEach(async () => {
  // Create test database
  db = createTestDatabase();

  // Create test user
  const result = db.prepare(`
    INSERT INTO users (username, is_admin, is_active, created_at)
    VALUES (?, ?, ?, ?)
  `).run('test-api-user', 0, 1, Date.now());
  testUserId = Number(result.lastInsertRowid);

  // Generate test token
  testToken = await generateTestToken(db, testUserId);

  // Set up mock database service
  setupMockDatabaseService(db);

  // Create Express app with v1 router
  app = express();
  app.use(express.json());

  // Mock the database service import
  app.use((req, res, next) => {
    (req as any).databaseService = (global as any).mockDatabaseService;
    next();
  });

  app.use('/api/v1', v1Router);

  // Insert test data
  db.prepare(`
    INSERT INTO nodes (node_id, node_id_hex, short_name, long_name, hardware_model, role, last_seen)
    VALUES
      (2882400001, '!abcd0001', 'TEST1', 'Test Node 1', 1, 0, ?),
      (2882400002, '!abcd0002', 'YERG2', 'Yeraze Station G2', 2, 1, ?),
      (2882400003, '!abcd0003', 'TEST3', 'Test Node 3', 3, 0, ?)
  `).run(Date.now(), Date.now(), Date.now() - 3600000);

  db.prepare(`
    INSERT INTO messages (from_node, to_node, channel, message, timestamp)
    VALUES
      (2882400001, 2882400002, 0, 'Test message 1', ?),
      (2882400002, 2882400001, 0, 'Test message 2', ?)
  `).run(Date.now(), Date.now() - 1000);

  db.prepare(`
    INSERT INTO telemetry (node_id, timestamp, battery_level, voltage, temperature)
    VALUES
      (2882400001, ?, 95, 4.2, 25.5),
      (2882400002, ?, 80, 3.9, 24.0)
  `).run(Date.now(), Date.now() - 1000);

  db.prepare(`
    INSERT INTO traceroutes (from_node, to_node, route, timestamp)
    VALUES (2882400001, 2882400002, '2882400001,2882400002', ?)
  `).run(Date.now());

  db.prepare(`
    INSERT INTO packet_log (packet_id, from_node, to_node, channel, portnum, encrypted, timestamp)
    VALUES
      (1001, 2882400001, 2882400002, 0, 1, 0, ?),
      (1002, 2882400002, 2882400001, 0, 3, 1, ?)
  `).run(Date.now(), Date.now() - 1000);

  // Insert solar estimate test data
  const now = Math.floor(Date.now() / 1000);
  const fetchedAt = now - 3600; // 1 hour ago
  db.prepare(`
    INSERT INTO solar_estimates (timestamp, watt_hours, fetched_at)
    VALUES
      (?, 450.5, ?),
      (?, 520.3, ?),
      (?, 380.2, ?)
  `).run(now, fetchedAt, now + 3600, fetchedAt, now + 7200, fetchedAt);
});

afterEach(() => {
  if (db) {
    db.close();
  }
  delete (global as any).mockDatabaseService;
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
      .set('Authorization', `Bearer ${testToken}`)
      .expect(200);

    expect(response.body).toHaveProperty('version', 'v1');
  });
});

describe('GET /api/v1/', () => {
  it('should return API version info', async () => {
    const response = await request(app)
      .get('/api/v1/')
      .set('Authorization', `Bearer ${testToken}`)
      .expect(200);

    expect(response.body).toEqual({
      version: 'v1',
      description: 'MeshMonitor REST API v1',
      documentation: '/api/v1/docs',
      endpoints: {
        nodes: '/api/v1/nodes',
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
      .set('Authorization', `Bearer ${testToken}`)
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
      .set('Authorization', `Bearer ${testToken}`)
      .expect(200);

    const yerazeNode = response.body.data.find((n: any) => n.short_name === 'YERG2');
    expect(yerazeNode).toBeDefined();
    expect(yerazeNode.long_name).toBe('Yeraze Station G2');
  });
});

describe('GET /api/v1/nodes/:id', () => {
  it('should return single node by ID', async () => {
    const response = await request(app)
      .get('/api/v1/nodes/2882400002')
      .set('Authorization', `Bearer ${testToken}`)
      .expect(200);

    expect(response.body).toHaveProperty('success', true);
    expect(response.body).toHaveProperty('data');
    expect(response.body.data.node_id).toBe(2882400002);
    expect(response.body.data.short_name).toBe('YERG2');
  });

  it('should return 404 for non-existent node', async () => {
    const response = await request(app)
      .get('/api/v1/nodes/999999999')
      .set('Authorization', `Bearer ${testToken}`)
      .expect(404);

    expect(response.body).toHaveProperty('success', false);
    expect(response.body).toHaveProperty('error');
  });
});

describe('GET /api/v1/messages', () => {
  it('should return messages with pagination', async () => {
    const response = await request(app)
      .get('/api/v1/messages?offset=0&limit=10')
      .set('Authorization', `Bearer ${testToken}`)
      .expect(200);

    expect(response.body).toHaveProperty('success', true);
    expect(response.body).toHaveProperty('count');
    expect(response.body).toHaveProperty('total');
    expect(response.body).toHaveProperty('offset', 0);
    expect(response.body).toHaveProperty('limit', 10);
    expect(response.body).toHaveProperty('data');
    expect(Array.isArray(response.body.data)).toBe(true);
  });

  it('should respect pagination parameters', async () => {
    const response = await request(app)
      .get('/api/v1/messages?offset=1&limit=1')
      .set('Authorization', `Bearer ${testToken}`)
      .expect(200);

    expect(response.body.offset).toBe(1);
    expect(response.body.limit).toBe(1);
    expect(response.body.count).toBeLessThanOrEqual(1);
  });
});

describe('GET /api/v1/telemetry', () => {
  it('should return telemetry data', async () => {
    const response = await request(app)
      .get('/api/v1/telemetry')
      .set('Authorization', `Bearer ${testToken}`)
      .expect(200);

    expect(response.body).toHaveProperty('success', true);
    expect(response.body).toHaveProperty('data');
    expect(Array.isArray(response.body.data)).toBe(true);
    expect(response.body.count).toBeGreaterThanOrEqual(2);
  });
});

describe('GET /api/v1/traceroutes', () => {
  it('should return traceroute data', async () => {
    const response = await request(app)
      .get('/api/v1/traceroutes')
      .set('Authorization', `Bearer ${testToken}`)
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
      .set('Authorization', `Bearer ${testToken}`)
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
      .set('Authorization', `Bearer ${testToken}`)
      .expect(200);

    expect(response.body.success).toBe(true);
  });

  it('should support pagination', async () => {
    const response = await request(app)
      .get('/api/v1/packets?offset=0&limit=1')
      .set('Authorization', `Bearer ${testToken}`)
      .expect(200);

    expect(response.body.offset).toBe(0);
    expect(response.body.limit).toBe(1);
  });
});

describe('GET /api/v1/packets/:id', () => {
  it('should return single packet by ID', async () => {
    // Get the ID of a packet first
    const packets = db.prepare('SELECT id FROM packet_log LIMIT 1').get() as { id: number };

    const response = await request(app)
      .get(`/api/v1/packets/${packets.id}`)
      .set('Authorization', `Bearer ${testToken}`)
      .expect(200);

    expect(response.body).toHaveProperty('success', true);
    expect(response.body).toHaveProperty('data');
  });

  it('should return 404 for non-existent packet', async () => {
    const response = await request(app)
      .get('/api/v1/packets/999999')
      .set('Authorization', `Bearer ${testToken}`)
      .expect(404);

    expect(response.body).toHaveProperty('success', false);
  });
});

describe('GET /api/v1/solar', () => {
  it('should return solar estimates with standard response format', async () => {
    const response = await request(app)
      .get('/api/v1/solar')
      .set('Authorization', `Bearer ${testToken}`)
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
      .set('Authorization', `Bearer ${testToken}`)
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
      .set('Authorization', `Bearer ${testToken}`)
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
      .set('Authorization', `Bearer ${testToken}`)
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
      .set('Authorization', `Bearer ${testToken}`)
      .expect(400);

    expect(response.body).toHaveProperty('success', false);
    expect(response.body).toHaveProperty('error');
  });

  it('should return 400 for missing end parameter', async () => {
    const response = await request(app)
      .get('/api/v1/solar/range?start=1699520400')
      .set('Authorization', `Bearer ${testToken}`)
      .expect(400);

    expect(response.body).toHaveProperty('success', false);
    expect(response.body).toHaveProperty('error');
  });

  it('should return 400 when start is after end', async () => {
    const response = await request(app)
      .get('/api/v1/solar/range?start=1699606800&end=1699520400')
      .set('Authorization', `Bearer ${testToken}`)
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
        .set('Authorization', `Bearer ${testToken}`)
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
      .set('Authorization', `Bearer ${testToken}`)
      .expect(404);

    expect(response.body).toHaveProperty('success', false);
    expect(response.body).toHaveProperty('error');
    expect(response.body).toHaveProperty('message');
  });
});
