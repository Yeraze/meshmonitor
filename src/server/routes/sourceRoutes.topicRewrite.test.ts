/**
 * sourceRoutes — mqtt_bridge topic rewrite validation (#3166).
 *
 * Covers POST + PUT validation for the new downlinkTopicRewrite and
 * uplinkTopicRewrite fields on mqtt_bridge config:
 *
 *   - Valid rules accepted (POST + PUT).
 *   - Both rules accepted together.
 *   - Missing `from` / `to` rejected.
 *   - Wildcards (+, #) rejected.
 *   - `from === to` rejected.
 *   - Wrong type (string instead of object, array) rejected.
 *   - Standalone bridge (no brokerSourceId) with rewrite rejected.
 *   - Trailing slashes accepted (normalized).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { Express } from 'express';
import session from 'express-session';
import request from 'supertest';
import sourceRoutes from './sourceRoutes.js';
import databaseService from '../../services/database.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';

vi.mock('../../services/database.js', () => ({
  default: {
    sources: {
      getSource: vi.fn(),
      getAllSources: vi.fn().mockResolvedValue([]),
      createSource: vi.fn(),
      updateSource: vi.fn(),
      deleteSource: vi.fn().mockResolvedValue(true),
    },
    nodes: { getAllNodes: vi.fn().mockResolvedValue([]) },
    messages: { getMessages: vi.fn().mockResolvedValue([]) },
    traceroutes: { getAllTraceroutes: vi.fn().mockResolvedValue([]) },
    neighbors: { getAllNeighborInfo: vi.fn().mockResolvedValue([]) },
    channels: { getAllChannels: vi.fn().mockResolvedValue([]) },
    settings: { getSetting: vi.fn().mockResolvedValue(null) },
    checkPermissionAsync: vi.fn().mockResolvedValue(true),
    findUserByIdAsync: vi.fn(),
    findUserByUsernameAsync: vi.fn().mockResolvedValue(null),
    getUserPermissionSetAsync: vi.fn().mockResolvedValue({ resources: {}, isAdmin: true }),
    getChannelDatabasePermissionsForUserAsSetAsync: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    addManager: vi.fn().mockResolvedValue(undefined),
    removeManager: vi.fn().mockResolvedValue(undefined),
    getManager: vi.fn().mockReturnValue(null),
    stopAll: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../meshtasticManager.js', () => {
  class MeshtasticManager {
    sourceId: string;
    constructor(id: string) {
      this.sourceId = id;
    }
    async start() {}
    async stop() {}
    on() {
      return this;
    }
    off() {
      return this;
    }
  }
  return { MeshtasticManager };
});

vi.mock('../mqttBrokerManager.js', () => {
  class MqttBrokerManager {
    sourceId: string;
    constructor(id: string) {
      this.sourceId = id;
    }
    async start() {}
    async stop() {}
    on() {
      return this;
    }
    off() {
      return this;
    }
    getStatus() {
      return { sourceId: this.sourceId, sourceName: '', sourceType: 'mqtt_broker' as const, connected: false };
    }
  }
  return { MqttBrokerManager };
});

vi.mock('../mqttBridgeManager.js', () => {
  class MqttBridgeManager {
    sourceId: string;
    constructor(id: string) {
      this.sourceId = id;
    }
    async start() {}
    async stop() {}
    on() {
      return this;
    }
    off() {
      return this;
    }
    getStatus() {
      return { sourceId: this.sourceId, sourceName: '', sourceType: 'mqtt_bridge' as const, connected: false };
    }
  }
  return { MqttBridgeManager };
});

vi.mock('../meshcoreRegistry.js', () => ({
  meshcoreManagerRegistry: {
    get: vi.fn().mockReturnValue(null),
    getOrCreate: vi.fn(),
    remove: vi.fn().mockResolvedValue(undefined),
  },
  meshcoreConfigFromSource: vi.fn().mockReturnValue(null),
}));

const mockDb = databaseService as any;
const mockRegistry = sourceManagerRegistry as any;

const adminUser = { id: 1, username: 'admin', isActive: true, isAdmin: true };

const createApp = (): Express => {
  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
      cookie: { secure: false },
    }),
  );
  app.use((req: any, _res, next) => {
    req.session.userId = adminUser.id;
    next();
  });
  app.use('/', sourceRoutes);
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.findUserByIdAsync.mockResolvedValue(adminUser);
  mockDb.getUserPermissionSetAsync.mockResolvedValue({ resources: {}, isAdmin: true });
  mockDb.checkPermissionAsync.mockResolvedValue(true);
  mockRegistry.getManager.mockReturnValue(null);
});

const brokerRecord = {
  id: 'broker-1',
  type: 'mqtt_broker',
  name: 'Local',
  enabled: true,
  config: { listener: { port: 1883 }, auth: { username: 'u', password: 'p' } },
};

function attachedBridgeBody(extra: Record<string, unknown> = {}) {
  return {
    name: 'TX Bridge',
    type: 'mqtt_bridge',
    config: {
      brokerSourceId: 'broker-1',
      upstream: { url: 'mqtt://mqtt.meshtastic.org:1883', username: 'meshdev', password: 'large4cats' },
      subscriptions: ['msh/US/TX/#'],
      ...extra,
    },
  };
}

describe('sourceRoutes — POST mqtt_bridge topic rewrite validation (#3166)', () => {
  it('accepts a valid downlink rewrite on an attached bridge', async () => {
    const app = createApp();
    mockDb.sources.getSource.mockResolvedValue(brokerRecord);
    mockDb.sources.createSource.mockImplementation(async (s: any) => ({ ...s, createdAt: new Date(), updatedAt: new Date() }));

    const res = await request(app)
      .post('/')
      .send(attachedBridgeBody({ downlinkTopicRewrite: { from: 'msh/US/TX', to: 'msh/US/LA' } }));

    expect(res.status).toBe(201);
    expect(mockDb.sources.createSource).toHaveBeenCalledTimes(1);
    const created = mockDb.sources.createSource.mock.calls[0][0];
    expect(created.config.downlinkTopicRewrite).toEqual({ from: 'msh/US/TX', to: 'msh/US/LA' });
  });

  it('accepts both downlink and uplink rewrites together', async () => {
    const app = createApp();
    mockDb.sources.getSource.mockResolvedValue(brokerRecord);
    mockDb.sources.createSource.mockImplementation(async (s: any) => ({ ...s, createdAt: new Date(), updatedAt: new Date() }));

    const res = await request(app)
      .post('/')
      .send(
        attachedBridgeBody({
          downlinkTopicRewrite: { from: 'msh/US/TX', to: 'msh/US/LA' },
          uplinkTopicRewrite: { from: 'msh/US/LA', to: 'msh/US/TX' },
        }),
      );

    expect(res.status).toBe(201);
  });

  it('accepts trailing-slash variants (normalized at runtime)', async () => {
    const app = createApp();
    mockDb.sources.getSource.mockResolvedValue(brokerRecord);
    mockDb.sources.createSource.mockImplementation(async (s: any) => ({ ...s, createdAt: new Date(), updatedAt: new Date() }));

    const res = await request(app)
      .post('/')
      .send(attachedBridgeBody({ downlinkTopicRewrite: { from: 'msh/US/TX/', to: 'msh/US/LA' } }));

    expect(res.status).toBe(201);
  });

  it('rejects rewrite on a standalone bridge (no brokerSourceId)', async () => {
    const app = createApp();
    mockDb.sources.getAllSources.mockResolvedValue([]);

    const res = await request(app)
      .post('/')
      .send({
        name: 'Standalone',
        type: 'mqtt_bridge',
        config: {
          upstream: { url: 'mqtt://example.com' },
          subscriptions: ['msh/#'],
          downlinkTopicRewrite: { from: 'msh/US/TX', to: 'msh/US/LA' },
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/standalone bridges cannot rewrite/);
  });

  it('rejects rewrite missing `from`', async () => {
    const app = createApp();
    mockDb.sources.getSource.mockResolvedValue(brokerRecord);

    const res = await request(app)
      .post('/')
      .send(attachedBridgeBody({ downlinkTopicRewrite: { to: 'msh/US/LA' } as any }));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/downlinkTopicRewrite\.from.*to.*strings/);
  });

  it('rejects empty `from` after trim', async () => {
    const app = createApp();
    mockDb.sources.getSource.mockResolvedValue(brokerRecord);

    const res = await request(app)
      .post('/')
      .send(attachedBridgeBody({ downlinkTopicRewrite: { from: '   /', to: 'msh/US/LA' } }));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/non-empty/);
  });

  it('rejects MQTT wildcards (+)', async () => {
    const app = createApp();
    mockDb.sources.getSource.mockResolvedValue(brokerRecord);

    const res = await request(app)
      .post('/')
      .send(attachedBridgeBody({ downlinkTopicRewrite: { from: 'msh/US/+', to: 'msh/US/LA' } }));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/MQTT wildcards/);
  });

  it('rejects MQTT wildcards (#)', async () => {
    const app = createApp();
    mockDb.sources.getSource.mockResolvedValue(brokerRecord);

    const res = await request(app)
      .post('/')
      .send(attachedBridgeBody({ uplinkTopicRewrite: { from: 'msh/US/LA', to: 'msh/#' } }));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/MQTT wildcards/);
  });

  it('rejects from === to', async () => {
    const app = createApp();
    mockDb.sources.getSource.mockResolvedValue(brokerRecord);

    const res = await request(app)
      .post('/')
      .send(attachedBridgeBody({ downlinkTopicRewrite: { from: 'msh/US/TX', to: 'msh/US/TX/' } }));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must differ/);
  });

  it('rejects non-object rule (array)', async () => {
    const app = createApp();
    mockDb.sources.getSource.mockResolvedValue(brokerRecord);

    const res = await request(app)
      .post('/')
      .send(attachedBridgeBody({ downlinkTopicRewrite: ['msh/US/TX', 'msh/US/LA'] as any }));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must be an object/);
  });
});

describe('sourceRoutes — PUT mqtt_bridge topic rewrite validation (#3166)', () => {
  const existingBridge = {
    id: 'bridge-1',
    type: 'mqtt_bridge',
    name: 'TX Bridge',
    enabled: true,
    config: {
      brokerSourceId: 'broker-1',
      upstream: { url: 'mqtt://mqtt.meshtastic.org:1883', username: 'meshdev', password: 'large4cats' },
      subscriptions: ['msh/US/TX/#'],
    },
  };

  it('accepts adding a valid rewrite on PUT', async () => {
    const app = createApp();
    mockDb.sources.getSource.mockResolvedValue(existingBridge);
    mockDb.sources.updateSource.mockResolvedValue({ ...existingBridge });

    const res = await request(app)
      .put('/bridge-1')
      .send({
        config: {
          brokerSourceId: 'broker-1',
          upstream: { url: 'mqtt://mqtt.meshtastic.org:1883', username: 'meshdev' },
          subscriptions: ['msh/US/TX/#'],
          downlinkTopicRewrite: { from: 'msh/US/TX', to: 'msh/US/LA' },
        },
      });

    expect(res.status).toBe(200);
    const updateArg = mockDb.sources.updateSource.mock.calls[0][1];
    expect(updateArg.config.downlinkTopicRewrite).toEqual({ from: 'msh/US/TX', to: 'msh/US/LA' });
  });

  it('rejects rewrite on PUT when the bridge becomes standalone', async () => {
    const app = createApp();
    mockDb.sources.getSource.mockResolvedValue(existingBridge);

    // PUT drops brokerSourceId — bridge becomes standalone. Rewrite must be rejected.
    const res = await request(app)
      .put('/bridge-1')
      .send({
        config: {
          upstream: { url: 'mqtt://mqtt.meshtastic.org:1883' },
          subscriptions: ['msh/US/TX/#'],
          downlinkTopicRewrite: { from: 'msh/US/TX', to: 'msh/US/LA' },
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/standalone bridges cannot rewrite/);
  });

  it('rejects malformed rewrite on PUT', async () => {
    const app = createApp();
    mockDb.sources.getSource.mockResolvedValue(existingBridge);

    const res = await request(app)
      .put('/bridge-1')
      .send({
        config: {
          brokerSourceId: 'broker-1',
          upstream: { url: 'mqtt://mqtt.meshtastic.org:1883' },
          subscriptions: ['msh/US/TX/#'],
          downlinkTopicRewrite: { from: 'msh/US/+/foo', to: 'msh/US/LA' },
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/MQTT wildcards/);
  });
});
