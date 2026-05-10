/**
 * Source Routes — security regression tests for the MM-SEC-7 / MM-SEC-8
 * follow-on advisory.
 *
 * MM-SEC-7: `GET /api/sources/:id/channels` previously returned the raw
 *           channels rows (including the `psk` column) to any caller with
 *           `messages:read` on the source. The fix moves the route to
 *           `optionalAuth()` plus a per-row `channel_${id}:read` gate, then
 *           projects through `transformChannel`.
 *
 *           Issue #2951 follow-up: the actual `psk` is now intentionally
 *           included for admins and callers with `channel_${id}:write`
 *           permission so the channel-configuration UI can show the
 *           existing key to the operator who is allowed to change it.
 *           Read-only callers must still never see the key.
 *
 * MM-SEC-8: `GET /api/sources/:id` previously returned the raw source row,
 *           skipping the `password` / `apiKey` strip applied to the list
 *           endpoint. The fix routes both endpoints through a shared
 *           `stripSourceSecrets` helper that removes credentials for
 *           non-admin callers.
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
    channels: {
      getAllChannels: vi.fn(),
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

const adminUser = { id: 1, username: 'admin', isActive: true, isAdmin: true };
const regularUser = { id: 2, username: 'viewer', isActive: true, isAdmin: false };

function createApp(userId: number | null): Express {
  const app = express();
  app.use(express.json());
  app.use(session({
    secret: 'test-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
  }));
  app.use((req: any, _res, next) => {
    if (userId !== null) req.session.userId = userId;
    next();
  });
  app.use('/', sourceRoutes);
  return app;
}

// ────────────────────────────────────────────────────────────────────────
// MM-SEC-7 — `GET /api/sources/:id/channels`
// ────────────────────────────────────────────────────────────────────────
describe('MM-SEC-7 — /api/sources/:id/channels does not leak PSKs', () => {
  // Two channels seeded for every test below. PSKs are intentionally distinct
  // so we can assert the actual values never appear anywhere in the response.
  const channelRows = [
    { id: 0, name: 'Primary', psk: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', role: 1, uplinkEnabled: true, downlinkEnabled: true, positionPrecision: 14 },
    { id: 2, name: 'hidden',  psk: 'WklET0VOX0NIQU5fMl9TRUNSRVRfUFNLX0NIQU5fMjI=', role: 2, uplinkEnabled: false, downlinkEnabled: false, positionPrecision: 0 },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.sources.getSource.mockResolvedValue({ id: 'src-1', name: 'src-1', type: 'meshtastic_tcp', enabled: true });
    mockDb.channels.getAllChannels.mockResolvedValue(channelRows);
  });

  it('anonymous (no session) receives empty array — no PSK material in response', async () => {
    mockDb.findUserByIdAsync.mockResolvedValue(null);
    mockDb.checkPermissionAsync.mockResolvedValue(false);

    const res = await request(createApp(null)).get('/src-1/channels');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    expect(JSON.stringify(res.body)).not.toContain('WklET0VOX0NIQU5fMl9TRUNSRVRfUFNLX0NIQU5fMjI=');
  });

  it('authenticated viewer with channel_0:read (no write) sees channel 0 but no psk field', async () => {
    mockDb.findUserByIdAsync.mockResolvedValue(regularUser);
    mockDb.findUserByUsernameAsync.mockResolvedValue(null);
    mockDb.getUserPermissionSetAsync.mockResolvedValue({ resources: {}, isAdmin: false });
    // Per-channel: grant channel_0:read only — NOT write.
    mockDb.checkPermissionAsync.mockImplementation(
      (_uid: number, resource: string, action: string) =>
        Promise.resolve(resource === 'channel_0' && action === 'read')
    );

    const res = await request(createApp(regularUser.id)).get('/src-1/channels');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(0);
    // Read-only viewer must not receive the actual key.
    expect(res.body[0]).not.toHaveProperty('psk');
    expect(res.body[0].pskSet).toBe(true);
    // But the derived encryption status is safe to expose.
    expect(res.body[0].encryptionStatus).toBe('secure');
    // The hidden channel must not appear at all — neither its name nor PSK.
    expect(JSON.stringify(res.body)).not.toContain('hidden');
    expect(JSON.stringify(res.body)).not.toContain('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    expect(JSON.stringify(res.body)).not.toContain('WklET0VOX0NIQU5fMl9TRUNSRVRfUFNLX0NIQU5fMjI=');
  });

  it('authenticated writer with channel_0:write sees channel 0 PSK in the response (issue #2951)', async () => {
    mockDb.findUserByIdAsync.mockResolvedValue(regularUser);
    mockDb.findUserByUsernameAsync.mockResolvedValue(null);
    mockDb.getUserPermissionSetAsync.mockResolvedValue({ resources: {}, isAdmin: false });
    // Grant channel_0 read + write; channel_2 read only.
    mockDb.checkPermissionAsync.mockImplementation(
      (_uid: number, resource: string, action: string) => {
        if (resource === 'channel_0') return Promise.resolve(true); // read + write
        if (resource === 'channel_2' && action === 'read') return Promise.resolve(true);
        return Promise.resolve(false);
      }
    );

    const res = await request(createApp(regularUser.id)).get('/src-1/channels');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    const ch0 = res.body.find((c: any) => c.id === 0);
    const ch2 = res.body.find((c: any) => c.id === 2);
    // Channel 0: writer sees the PSK so the edit dialog can prefill it.
    expect(ch0.psk).toBe('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    expect(ch0.pskSet).toBe(true);
    expect(ch0.encryptionStatus).toBe('secure');
    // Channel 2: read-only — no PSK exposed.
    expect(ch2).not.toHaveProperty('psk');
    expect(ch2.pskSet).toBe(true);
  });

  it('admin sees all channels including PSK (issue #2951 — needed for channel config UI)', async () => {
    mockDb.findUserByIdAsync.mockResolvedValue(adminUser);
    mockDb.getUserPermissionSetAsync.mockResolvedValue({});

    const res = await request(createApp(adminUser.id)).get('/src-1/channels');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    // Admin can see PSKs to configure channels.
    expect(res.body.every((c: any) => 'psk' in c)).toBe(true);
    expect(res.body.find((c: any) => c.id === 0).psk).toBe('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    expect(res.body.find((c: any) => c.id === 2).psk).toBe('WklET0VOX0NIQU5fMl9TRUNSRVRfUFNLX0NIQU5fMjI=');
    expect(res.body.every((c: any) => typeof c.pskSet === 'boolean')).toBe(true);
    expect(res.body.every((c: any) => typeof c.encryptionStatus === 'string')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────
// MM-SEC-8 — `GET /api/sources` and `GET /api/sources/:id` strip credentials
// ────────────────────────────────────────────────────────────────────────
describe('MM-SEC-8 — sources endpoints strip credentials for non-admins', () => {
  const mqttSource = {
    id: 'mqtt-1',
    name: 'mqtt-1',
    type: 'mqtt',
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    config: {
      host: 'mqtt.example.com',
      port: 1883,
      username: 'msmuser',
      password: 'super-secret-mqtt-password',
      apiKey: 'tok_aaaaaaaaaaaaaaaa',
      topicPrefix: 'msh/US',
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.sources.getSource.mockResolvedValue(mqttSource);
    mockDb.sources.getAllSources.mockResolvedValue([mqttSource]);
    mockDb.checkPermissionAsync.mockResolvedValue(true);
    mockDb.getUserPermissionSetAsync.mockResolvedValue({ resources: {}, isAdmin: false });
  });

  it('anonymous list — strips password and apiKey', async () => {
    mockDb.findUserByIdAsync.mockResolvedValue(null);

    const res = await request(createApp(null)).get('/');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].config.password).toBeUndefined();
    expect(res.body[0].config.apiKey).toBeUndefined();
    // Non-secret fields still present
    expect(res.body[0].config.host).toBe('mqtt.example.com');
    expect(JSON.stringify(res.body)).not.toContain('super-secret-mqtt-password');
    expect(JSON.stringify(res.body)).not.toContain('tok_aaaaaaaaaaaaaaaa');
  });

  it('non-admin singular GET — strips password and apiKey (was leaking pre-MM-SEC-8)', async () => {
    mockDb.findUserByIdAsync.mockResolvedValue(regularUser);

    const res = await request(createApp(regularUser.id)).get('/mqtt-1');
    expect(res.status).toBe(200);
    expect(res.body.config.password).toBeUndefined();
    expect(res.body.config.apiKey).toBeUndefined();
    expect(res.body.config.host).toBe('mqtt.example.com');
    expect(JSON.stringify(res.body)).not.toContain('super-secret-mqtt-password');
    expect(JSON.stringify(res.body)).not.toContain('tok_aaaaaaaaaaaaaaaa');
  });

  it('admin singular GET — receives credentials so the source-edit UI can round-trip', async () => {
    mockDb.findUserByIdAsync.mockResolvedValue(adminUser);
    mockDb.getUserPermissionSetAsync.mockResolvedValue({});

    const res = await request(createApp(adminUser.id)).get('/mqtt-1');
    expect(res.status).toBe(200);
    expect(res.body.config.password).toBe('super-secret-mqtt-password');
    expect(res.body.config.apiKey).toBe('tok_aaaaaaaaaaaaaaaa');
  });

  it('admin list — receives credentials (mirrors singular admin behaviour)', async () => {
    mockDb.findUserByIdAsync.mockResolvedValue(adminUser);
    mockDb.getUserPermissionSetAsync.mockResolvedValue({});

    const res = await request(createApp(adminUser.id)).get('/');
    expect(res.status).toBe(200);
    expect(res.body[0].config.password).toBe('super-secret-mqtt-password');
    expect(res.body[0].config.apiKey).toBe('tok_aaaaaaaaaaaaaaaa');
  });
});
